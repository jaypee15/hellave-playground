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
    const result = await api.createMeeting({
      peerId,
      displayName,
      // Whoever creates the room is its host. This used to depend on lobbyEnabled, which left
      // the creator of an ordinary room unable to admit, spotlight or record in the room they
      // had just made.
      role: req.body["role"] ?? "host",
      policy: { lobbyEnabled },
    });
    res.json({ ...result, peerId, lobbyEnabled, controlUrl: baseUrl });
  } catch (err: unknown) {
    const status = err instanceof Error && "status" in err
      ? (err as { status: number }).status
      : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

/**
 * Mint a fresh meeting token for a peer that already has an identity.
 *
 * A meeting token only authorises joining and is deliberately short-lived, so the SDK asks its
 * tokenProvider for a new one on every attach and on every reconnect. Handing back a captured
 * token instead — which this app used to do — means a reconnect presents an expired credential
 * and fails.
 *
 * The peerId is supplied by the caller rather than derived: slugify() appends a fresh uuid, so
 * minting by display name would return a *different* peer and the room would see a stranger.
 */
app.post("/api/token", async (req, res) => {
  try {
    const { roomInstanceId, displayName, peerId } = req.body;
    if (!roomInstanceId || !displayName || !peerId) {
      res.status(400).json({ error: "roomInstanceId, displayName and peerId are required" });
      return;
    }
    const role = req.body["role"] ?? "participant";
    const isHost = role === "host";
    const token = await api.issueMeetingToken(roomInstanceId, {
      peerId,
      sessionId: crypto.randomUUID(),
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
      // Never the lobby on a refresh: this peer has already been admitted, and asking to be
      // placed in the lobby again would send them back to waiting.
      lobby: false,
    });
    res.json({ token: token.token, expiresAt: token.expiresAt });
  } catch (err: unknown) {
    const status = err instanceof Error && "status" in err
      ? (err as { status: number }).status
      : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : "Unknown error" });
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
    const mintToken = (lobby: boolean) => api.issueMeetingToken(roomInstanceId, {
      peerId,
      sessionId: crypto.randomUUID(),
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
    });

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
    const status = err instanceof Error && "status" in err
      ? (err as { status: number }).status
      : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

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
