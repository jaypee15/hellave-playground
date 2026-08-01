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
    // the backend's lobby_admission capability. The creator is a host so they can admit.
    const lobbyEnabled = req.body["lobbyEnabled"] === true;
    const result = await api.createMeeting({
      peerId,
      displayName,
      role: req.body["role"] ?? (lobbyEnabled ? "host" : "participant"),
      policy: { lobbyEnabled },
    });
    res.json({ ...result, peerId, lobbyEnabled });
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
        // Follows the role, matching createMeeting. Signaling additionally requires the host
        // role, so granting this to a participant would be refused anyway.
        controlRecording: isHost,
        updateProfile: true,
      },
      // Placed in the lobby when the caller says the room requires admission; the host then
      // admits or denies. Rooms created without a lobby ignore this.
      lobby: req.body["lobby"] === true,
    });
    // The browser needs the application roomId for attach(): it is validated against
    // room_id in the authoritative snapshot. A joiner only supplies the room *instance*
    // id, so read the roomId out of the token we just minted.
    res.json({
      token: token.token,
      expiresAt: token.expiresAt,
      peerId,
      roomId: roomIdFromToken(token.token),
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
