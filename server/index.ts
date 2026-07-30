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
    const result = await api.createMeeting({
      peerId,
      displayName,
      role: req.body["role"] ?? "participant",
    });
    res.json({ ...result, peerId });
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
    const token = await api.issueMeetingToken(roomInstanceId, {
      peerId,
      sessionId: crypto.randomUUID(),
      profile: { displayName, avatarUrl: null },
      role: req.body["role"] ?? "participant",
      capabilities: {
        publishAudio: true,
        publishVideo: true,
        shareScreen: true,
        sendMessages: true,
        moderateLobby: false,
        moderateParticipants: false,
        setSpotlight: false,
        controlRecording: false,
        updateProfile: true,
      },
      lobby: false,
    });
    res.json({ token: token.token, expiresAt: token.expiresAt, peerId });
  } catch (err: unknown) {
    const status = err instanceof Error && "status" in err
      ? (err as { status: number }).status
      : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

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
