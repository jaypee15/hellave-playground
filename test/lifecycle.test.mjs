/**
 * End-to-end lifecycle test: playground server -> Hellave API -> control plane.
 *
 * Every failure this repo has hit so far surfaced *before* any media flowed — a rejected
 * request body, an undecoded response field, an unreachable orchestrator, a TLS scheme
 * against a plaintext port, a participant profile the SDK refused. All of them are
 * reachable from Node, so this test covers them without a browser.
 *
 * Each case is an independent `it`, so one run reports every problem instead of stopping
 * at the first. Run with:
 *
 *   npm run test:e2e
 *
 * It drives the real deployed API by default (HELLAVE_BASE_URL), creating real rooms and
 * destroying them afterwards. Point HELLAVE_BASE_URL at a local stack to test that
 * instead — nothing here assumes the deployed host.
 *
 * What it deliberately does NOT cover: actual audio. That needs a browser with fake media
 * devices; see the media-prerequisites case for the reachability checks that stand in.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import dgram from "node:dgram";
import crypto from "node:crypto";

import { HellaveClient } from "@hellave/js-sdk";
import { HellaveApiClient } from "@hellave/js-sdk/server";

const API_KEY = process.env["HELLAVE_API_KEY"];
const BASE_URL = process.env["HELLAVE_BASE_URL"] ?? "https://hellave-api.maiaddy.com";
const PORT = Number(process.env["E2E_PORT"] ?? 3099);
const ATTACH_TIMEOUT_MS = Number(process.env["E2E_ATTACH_TIMEOUT_MS"] ?? 20_000);
/** Per-case ceiling so a stuck backend fails the case instead of hanging the run. */
const CASE_TIMEOUT = { timeout: 60_000 };
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** Room instances created during the run, destroyed in `after`. */
const createdRoomInstances = [];
const attachedClients = [];
let server;
/** Set before we SIGTERM the server so its exit is not reported as a crash. */
let shuttingDown = false;

function post(path, body) {
  return fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Any response — including a 400 — proves the listener is up.
      await post("/api/create-room", {});
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`playground server did not listen on ${ORIGIN} within ${timeoutMs}ms`);
}

async function createRoom(displayName, lobbyEnabled = false) {
  const res = await post("/api/create-room", { displayName, lobbyEnabled });
  const body = await res.json();
  assert.equal(res.status, 200, `create-room failed: ${JSON.stringify(body)}`);
  if (body.roomInstanceId) createdRoomInstances.push(body.roomInstanceId);
  return body;
}

async function attach(token, roomInstanceId, roomId = roomInstanceId) {
  const client = new HellaveClient({
    controlUrl: BASE_URL,
    tokenProvider: async () => ({ token }),
    // Without this a broken control plane hangs the run instead of failing it.
    attachTimeoutMs: ATTACH_TIMEOUT_MS,
  });
  attachedClients.push(client);
  const conference = await client.attach({ roomId, roomInstanceId });
  return { client, conference };
}

/** Poll a getter until it satisfies the predicate, so control-plane propagation is allowed for. */
async function waitForCondition(get, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = get();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} — last observed: ${JSON.stringify(last)}`);
}

function tcpProbe(host, port, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done("open"));
    socket.once("timeout", () => done("filtered"));
    socket.once("error", (err) => done(err.code === "ECONNREFUSED" ? "refused" : "error"));
    socket.connect(port, host);
  });
}

/** Send a STUN binding request; a 0x0101 reply proves STUN/TURN is answering on UDP. */
function stunProbe(host, port = 3478, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => {
      socket.close();
      resolve("no-reply");
    }, timeoutMs);
    const request = Buffer.alloc(20);
    request.writeUInt16BE(0x0001, 0);
    request.writeUInt16BE(0, 2);
    request.writeUInt32BE(0x2112a442, 4);
    crypto.randomBytes(12).copy(request, 8);
    socket.once("message", (msg) => {
      clearTimeout(timer);
      const type = msg.readUInt16BE(0);
      socket.close();
      resolve(type === 0x0101 ? "binding-success" : `unexpected-0x${type.toString(16)}`);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      socket.close();
      resolve("error");
    });
    socket.send(request, port, host);
  });
}

describe("playground lifecycle", () => {
  before(async () => {
    assert.ok(API_KEY, "HELLAVE_API_KEY must be set (see README) — nothing can run without it");
    server = spawn("npx", ["tsx", "server/index.ts"], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    server.stderr.on("data", (chunk) => { stderr += chunk; });
    server.once("exit", (code, signal) => {
      // 143 is SIGTERM from our own teardown; anything else means the server died and the
      // failure message is worth surfacing.
      if (shuttingDown || code === 0 || code === null || code === 143 || signal) return;
      throw new Error(`playground server exited with ${code}: ${stderr}`);
    });
    await waitForServer();
  });

  after(async () => {
    // Cleanup must never hold the run open: an attached client keeps a live WebSocket, and
    // a wedged leave() or destroy would otherwise hang the process after every case passed.
    const bounded = (promise, label) =>
      Promise.race([
        Promise.resolve(promise).catch(() => {}),
        new Promise((resolve) => setTimeout(() => resolve(`${label} timed out`), 5_000)),
      ]);

    await Promise.all(attachedClients.map((client) => bounded(client.leave(), "leave")));
    if (API_KEY) {
      const api = new HellaveApiClient({ baseUrl: BASE_URL, apiKey: API_KEY });
      // Leave no test rooms behind on a shared backend.
      await Promise.all(
        createdRoomInstances.map((id) => bounded(api.destroyRoomInstance(id), `destroy ${id}`)),
      );
    }
    if (server && server.exitCode === null) {
      shuttingDown = true;
      server.kill("SIGTERM");
      await bounded(once(server, "exit"), "server exit");
    }
  });

  it("creates a room with every response field populated", CASE_TIMEOUT, async () => {
    const room = await createRoom("e2e-host");
    // roomInstanceId undefined here means the response was not decoded from snake_case.
    assert.match(
      room.roomInstanceId ?? "",
      /^[0-9a-f-]{36}$/,
      "roomInstanceId must be a decoded UUID",
    );
    assert.ok(room.token && room.token.length > 100, "expected a signed meeting token");
    assert.equal(typeof room.expiresAt, "number", "expiresAt must be decoded, not undefined");
    assert.ok(room.peerId, "expected a server-generated peerId");
    // attach() validates roomId against room_id in the snapshot, so it must be the
    // application room id — never the room instance id.
    assert.ok(room.roomId, "create-room must return the application roomId");
    assert.notEqual(
      room.roomId,
      room.roomInstanceId,
      "roomId must not be the room instance id",
    );
  });

  it("issues a join token for an existing room", CASE_TIMEOUT, async () => {
    const room = await createRoom("e2e-host-join");
    const res = await post("/api/join-room", {
      roomInstanceId: room.roomInstanceId,
      displayName: "e2e-guest",
    });
    const body = await res.json();
    assert.equal(res.status, 200, `join-room failed: ${JSON.stringify(body)}`);
    assert.ok(body.token && body.token.length > 100, "expected a signed meeting token");
    assert.equal(typeof body.expiresAt, "number", "expiresAt must be decoded");
    assert.notEqual(body.peerId, room.peerId, "each participant needs a distinct peerId");
    assert.equal(body.roomId, room.roomId, "a joiner must receive the same application roomId");
  });

  it("attaches the creator to the control plane", CASE_TIMEOUT, async () => {
    const room = await createRoom("e2e-attach");
    const { conference } = await attach(room.token, room.roomInstanceId, room.roomId);
    assert.ok(
      ["waiting", "admitted"].includes(conference.state),
      `unexpected conference state: ${conference.state}`,
    );
    assert.equal(conference.roomInstanceId, room.roomInstanceId);
    assert.equal(conference.terminalError, null, "attach must not leave a terminal error");
    assert.equal(typeof conference.snapshot.revision, "number");
  });

  it("attaches a second participant to the same room", CASE_TIMEOUT, async () => {
    const room = await createRoom("e2e-two-host");
    const joinRes = await post("/api/join-room", {
      roomInstanceId: room.roomInstanceId,
      displayName: "e2e-two-guest",
    });
    const guest = await joinRes.json();
    assert.equal(joinRes.status, 200, `join-room failed: ${JSON.stringify(guest)}`);

    const host = await attach(room.token, room.roomInstanceId, room.roomId);
    const second = await attach(guest.token, room.roomInstanceId, guest.roomId);

    assert.equal(host.conference.terminalError, null, "host attach left a terminal error");
    assert.equal(second.conference.terminalError, null, "guest attach left a terminal error");
    assert.equal(second.conference.roomInstanceId, room.roomInstanceId);
  });

  it("holds a joiner in the lobby until the host admits them", CASE_TIMEOUT, async () => {
    // lobby_admission is one of only four capabilities the contract declares, yet
    // createMeeting used to hardcode lobbyEnabled: false, so this path had never run.
    const room = await createRoom("e2e-lobby-host", true);
    assert.equal(room.lobbyEnabled, true, "the room should require admission");

    const joinRes = await post("/api/join-room", {
      roomInstanceId: room.roomInstanceId,
      displayName: "e2e-lobby-guest",
      lobby: true,
    });
    const guest = await joinRes.json();
    assert.equal(joinRes.status, 200, `join-room failed: ${JSON.stringify(guest)}`);

    const host = await attach(room.token, room.roomInstanceId, room.roomId);
    const waiting = await attach(guest.token, room.roomInstanceId, guest.roomId);

    // The guest attaches but is not admitted.
    assert.equal(waiting.conference.state, "waiting", "guest should be waiting for admission");

    // The host sees them in the lobby and can admit.
    const seen = await waitForCondition(
      () => host.conference.snapshot.lobby.length,
      (n) => n > 0,
      20_000,
      "host never saw the guest in the lobby",
    );
    assert.ok(seen > 0);

    const guestId = host.conference.snapshot.lobby[0].id;
    await host.conference.admit(guestId);

    const admitted = await waitForCondition(
      () => waiting.conference.state,
      (state) => state === "admitted",
      20_000,
      "guest was never admitted",
    );
    assert.equal(admitted, "admitted");
  });

  it("delivers chat and raised hands between two participants", CASE_TIMEOUT, async () => {
    const room = await createRoom("e2e-chat-host");
    const joinRes = await post("/api/join-room", {
      roomInstanceId: room.roomInstanceId,
      displayName: "e2e-chat-guest",
    });
    const guest = await joinRes.json();
    assert.equal(joinRes.status, 200, `join-room failed: ${JSON.stringify(guest)}`);

    const host = await attach(room.token, room.roomInstanceId, room.roomId);
    const other = await attach(guest.token, room.roomInstanceId, guest.roomId);

    const received = [];
    other.conference.on("roomMessage", (message) => received.push(message));
    const hands = [];
    other.conference.on("handRaisedChanged", (participantId, raised) =>
      hands.push({ participantId, raised }));

    // Both participants must be admitted before an ephemeral broadcast reaches anyone.
    await waitForCondition(
      () => other.conference.state,
      (state) => state === "admitted",
      20_000,
      "guest never reached admitted",
    );

    host.conference.sendMessage("hello from the host");
    const message = await waitForCondition(
      () => received[0],
      (value) => value !== undefined,
      20_000,
      "the guest never received the chat message",
    );
    assert.equal(message.body, "hello from the host");
    assert.ok(message.fromParticipantId, "expected a sender id");
    assert.equal(typeof message.sentAt, "number", "expected a server timestamp");

    host.conference.setHandRaised(true);
    const raised = await waitForCondition(
      () => hands[0],
      (value) => value !== undefined,
      20_000,
      "the guest never saw the hand raise",
    );
    assert.equal(raised.raised, true);
    // Tracked client-side, since raised hands are not snapshot state.
    assert.ok(other.conference.raisedHands.has(raised.participantId));

    host.conference.setHandRaised(false);
    await waitForCondition(
      () => other.conference.raisedHands.has(raised.participantId),
      (stillRaised) => stillRaised === false,
      20_000,
      "the hand was never lowered",
    );
  });

  it("has the media prerequisites reachable, and the SFU control API closed", CASE_TIMEOUT, async () => {
    const host = new URL(BASE_URL).hostname;
    const mediaHost = process.env["E2E_MEDIA_HOST"] ?? "51.21.252.37";

    const [stun, turnTcp, sfuControl] = await Promise.all([
      stunProbe(mediaHost, 3478),
      tcpProbe(mediaHost, 5349),
      tcpProbe(mediaHost, 4000),
    ]);

    assert.equal(stun, "binding-success", `STUN must answer on ${mediaHost}:3478/udp`);
    assert.equal(turnTcp, "open", `TURN TCP must accept connections on ${mediaHost}:5349`);
    // Regression guard: the /internal control API was once reachable from the internet.
    assert.notEqual(
      sfuControl,
      "open",
      `SFU control API on ${mediaHost}:4000 must not be publicly reachable`,
    );
    assert.ok(host, "control URL must have a hostname");
  });
});
