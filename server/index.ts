import express from "express";
import { HellaveApiClient } from "@hellave/js-sdk/server";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const apiKey = process.env["HELLAVE_API_KEY"];
const baseUrl = process.env["HELLAVE_BASE_URL"] ?? "https://hellave-api.maiaddy.com";

if (!apiKey) {
  console.error("HELLAVE_API_KEY is required");
  process.exit(1);
}

const api = new HellaveApiClient({ baseUrl, apiKey });
const app = express();
const PORT = parseInt(process.env["PORT"] ?? "3001", 10);

app.use(express.json());

app.post("/api/create-room", async (req, res) => {
  try {
    const { displayName } = req.body;
    if (!displayName) {
      res.status(400).json({ error: "displayName is required" });
      return;
    }
    const peerId = slugify(displayName);
    // A room with the lobby on makes joiners wait for admission, which is what exercises
    // the backend's lobby_admission capability.
    const lobbyEnabled = req.body["lobbyEnabled"] === true;
    const result = await callApi("creating a room", () => api.createMeeting({
      peerId,
      displayName,
      // Whoever creates the room is its host. This used to depend on lobbyEnabled, which left
      // the creator of an ordinary room unable to admit, spotlight or record in the room they
      // had just made.
      role: req.body["role"] ?? "host",
      policy: { lobbyEnabled },
    }));
    res.json({ ...result, peerId, lobbyEnabled, controlUrl: baseUrl });
  } catch (err: unknown) {
    failed(res, err);
  }
});

/**
 * Mint a fresh meeting token for a peer that already has an identity.
 *
 * A meeting token only authorises joining and is deliberately short-lived, so the SDK asks its
 * tokenProvider for a new one on every attach and on every reconnect. Handing back a captured
 * token instead — which this app used to do — means a reconnect presents an expired credential.
 *
 * Two pieces of identity have to survive a refresh, and getting either wrong looks like a
 * different bug entirely:
 *
 * - **peerId**, because slugify() appends a fresh uuid, so minting by display name would return a
 *   different peer and the room would see a stranger.
 * - **sessionId**, because the server treats a token bearing the *same* session as a reconnect and
 *   replaces the old attachment, while the same peer arriving on a *different* session is refused
 *   outright with "peer_id is already connected in this room". Minting a new uuid per refresh
 *   therefore broke every reconnect.
 */
app.post("/api/token", async (req, res) => {
  try {
    const { roomInstanceId, displayName, peerId, sessionId } = req.body;
    if (!roomInstanceId || !displayName || !peerId || !sessionId) {
      res.status(400).json({
        error: "roomInstanceId, displayName, peerId and sessionId are required",
      });
      return;
    }
    const role = req.body["role"] ?? "participant";
    const isHost = role === "host";
    const mintToken = (lobby: boolean) => callApi("refreshing a meeting token", () =>
      api.issueMeetingToken(roomInstanceId, {
        peerId,
        sessionId,
        profile: { displayName, avatarUrl: null },
        role,
        capabilities: {
          publishAudio: true,
          publishVideo: true,
          shareScreen: true,
          sendMessages: true,
          moderateLobby: isHost,
          moderateParticipants: isHost,
          setSpotlight: isHost,
          controlRecording: isHost,
          updateProfile: true,
        },
        lobby,
      }));

    // Only the caller knows whether this attach should wait for admission, and only the first one
    // ever should — a reconnect is already past the lobby, and asking again would send the person
    // back to waiting. The fallback mirrors /api/join-room: a room without a lobby refuses the
    // request outright rather than ignoring the flag.
    const wantsLobby = req.body["lobby"] === true;
    let token;
    try {
      token = await mintToken(wantsLobby);
    } catch (err: unknown) {
      const refusedLobby = wantsLobby
        && err instanceof Error
        && /does not allow lobby/i.test(err.message);
      if (!refusedLobby) throw err;
      token = await mintToken(false);
    }
    res.json({ token: token.token, expiresAt: token.expiresAt });
  } catch (err: unknown) {
    failed(res, err);
  }
});

app.post("/api/join-room", async (req, res) => {
  try {
    const { roomInstanceId, displayName } = req.body;
    if (!roomInstanceId || !displayName) {
      res.status(400).json({ error: "roomInstanceId and displayName are required" });
      return;
    }
    const peerId = slugify(displayName);
    const role = req.body["role"] ?? "participant";
    const isHost = role === "host";
    // Minted once, outside the call, so a reattempt presents the same session. A request lost in
    // transit may still have reached the API, and the same peer arriving on a *different* session is
    // refused outright with "peer_id is already connected in this room" — whereas the same session
    // is read as a reconnect and replaces the attachment, which is what a retry should mean.
    const sessionId = crypto.randomUUID();
    const mintToken = (lobby: boolean) => callApi("joining a room", () =>
      api.issueMeetingToken(roomInstanceId, {
        peerId,
        sessionId,
        profile: { displayName, avatarUrl: null },
        role,
        capabilities: {
          publishAudio: true,
          publishVideo: true,
          shareScreen: true,
          sendMessages: true,
          moderateLobby: isHost,
          moderateParticipants: isHost,
          setSpotlight: isHost,
          // Follows the role, matching createMeeting. Signaling additionally requires the host
          // role, so granting this to a participant would be refused anyway.
          controlRecording: isHost,
          updateProfile: true,
        },
        lobby,
      }));

    // A joiner knows only the room instance id, and Hellave exposes no way to read a room's
    // policy, so it cannot tell whether admission is required. Asking for lobby placement in
    // a room that has none is refused outright with "the room policy does not allow lobby
    // attachment", which used to make every join of an ordinary room fail. Ask, then fall
    // back on exactly that refusal.
    const wantsLobby = req.body["lobby"] === true;
    let token;
    try {
      token = await mintToken(wantsLobby);
    } catch (err: unknown) {
      const refusedLobby = wantsLobby
        && err instanceof Error
        && /does not allow lobby/i.test(err.message);
      if (!refusedLobby) throw err;
      token = await mintToken(false);
    }
    // The browser needs the application roomId for attach(): it is validated against
    // room_id in the authoritative snapshot. A joiner only supplies the room *instance*
    // id, so read the roomId out of the token we just minted.
    res.json({
      token: token.token,
      expiresAt: token.expiresAt,
      peerId,
      roomId: roomIdFromToken(token.token),
      controlUrl: baseUrl,
    });
  } catch (err: unknown) {
    failed(res, err);
  }
});

/** Attempts in total, so two reattempts, spaced 250ms then 500ms. */
const API_ATTEMPTS = 3;
const API_RETRY_BASE_DELAY_MS = 250;

/**
 * Call the Hellave API, reattempting a failure that says nothing about the request itself.
 *
 * Two kinds qualify, and nothing else:
 *
 * - **No response at all.** fetch rejects with a bare "fetch failed" and no status, so a name that
 *   momentarily would not resolve, or a connection dropped in transit, was indistinguishable from
 *   the API refusing the request. This is what cost a media suite run: the create-room request left
 *   no trace whatsoever in the API's access log.
 * - **A response the backend itself marked retryable**, which is how it reports a node it could not
 *   reach yet. `retryable: false` is a decision about this request and reattempting it only repeats
 *   the refusal — including the lobby refusal that /api/token and /api/join-room fall back on, which
 *   has to keep arriving unchanged.
 *
 * Creating a meeting is not idempotent, so a connection lost *after* the API committed can leave a
 * spare room behind. That is deliberate and much the lesser cost: an empty room is retired on its
 * own, while the alternative is the person who wanted a room not getting one.
 */
async function callApi<T>(what: string, call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (err: unknown) {
      if (attempt >= API_ATTEMPTS || !worthReattempting(err)) throw err;
      // Logged, not silent: a retry means something was briefly wrong, and a test run that passes
      // by retrying should still say so rather than reporting an unqualified success.
      console.warn(
        `${what}: ${describeError(err)} — reattempting (${attempt + 1} of ${API_ATTEMPTS})`,
      );
      await new Promise((resolve) => setTimeout(resolve, API_RETRY_BASE_DELAY_MS * attempt));
    }
  }
}

function worthReattempting(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // A status means the API answered, and then only its own verdict decides.
  if ("status" in err) return "retryable" in err && err.retryable === true;
  // No status: nothing came back. Narrowed to a transport failure so that a plain bug in this
  // server is reported at once instead of three times over.
  return err instanceof TypeError && err.message === "fetch failed";
}

/**
 * Report a failed Hellave API call to the browser.
 *
 * The cause carries the part worth reading. A request that never reaches the API arrives here as a
 * bare "fetch failed" with no status, so it is reported as a 500 that looks like the API rejecting
 * us — and only the cause separates a name that would not resolve from a connection that was
 * dropped. A media suite run was lost to exactly that: the create-room request left no trace in the
 * API's access log, and "fetch failed" was everything it left behind on this side.
 */
function failed(res: express.Response, err: unknown): void {
  const status = err instanceof Error && "status" in err
    ? (err as { status: number }).status
    : 500;
  res.status(status).json({ error: describeError(err) });
}

/** An error together with the causes underneath it, which is where fetch keeps the real reason. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return "Unknown error";
  const parts = [named(err)];
  let cause: unknown = err.cause;
  // Bounded: a cause chain is short in practice, and a cycle would otherwise not terminate.
  for (let depth = 0; cause instanceof Error && depth < 4; depth += 1) {
    parts.push(named(cause));
    // A host with several addresses fails as an AggregateError whose own message is empty, so the
    // reason is only in the errors it collected.
    if (cause instanceof AggregateError && cause.errors.length > 0) {
      cause = cause.errors[0];
      continue;
    }
    cause = cause.cause;
  }
  return parts.filter(Boolean).join(": ");
}

function named(err: Error): string {
  const code = "code" in err ? String((err as { code: unknown }).code) : "";
  if (!err.message) return code;
  return code && !err.message.includes(code) ? `${err.message} (${code})` : err.message;
}

/**
 * Read the `room_id` claim from a meeting token.
 *
 * Not a security check — the token was just issued by the Hellave API over TLS and is
 * passed straight back to our own frontend. It only avoids a second round trip to learn
 * the application roomId that attach() requires.
 */
function roomIdFromToken(token: string): string | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { room_id?: unknown };
    return typeof claims.room_id === "string" ? claims.room_id : null;
  } catch {
    return null;
  }
}

function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = resolve(__dirname, "../dist");
if (existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get("*", (_req, res) => {
    res.sendFile(resolve(distPath, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`Hellave playground server running on port ${PORT}`);
});
