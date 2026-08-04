/**
 * The playground server against an API that fails in transit.
 *
 * A media suite run was lost to a create-room whose request never reached the API: an 89-second gap
 * in the API's access log spanning the case, no 5xx anywhere, and on this side the bare string
 * "fetch failed". The server now reattempts a call that got no response — and this is what says so,
 * because none of the browser suites can produce that failure on purpose.
 *
 *   node --test test/server-retry.test.mjs
 *
 * No browser, no build and no network: the API here is a local socket that drops connections when
 * told to, so a transport failure is deterministic rather than something to wait around for.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";

/** Requests that reached the fake API, which is how "did it reattempt?" is answered. */
let received = [];
/** Connections to destroy before responding. Set per case. */
let dropsRemaining = 0;
/** What to answer once a request is allowed through, so a refusal can be tested too. */
let respondWith = { status: 201 };

let api;
let apiPort;
let server;
let serverPort;
let serverStderr = "";

/** A meeting token only has to survive `roomIdFromToken`, which reads one claim. */
function fakeToken() {
  const claims = Buffer.from(JSON.stringify({ room_id: "room-under-test" })).toString("base64url");
  return `header.${claims}.signature`;
}

/** Snake_case on the wire, the way the real API answers — the SDK converts it on the way in. */
function apiBody(url) {
  if (url === "/v1/room-instances") {
    return {
      room_instance_id: "instance-under-test",
      organization_id: "org-1",
      room_id: "room-under-test",
      policy: {
        lobby_enabled: false,
        max_participants: 50,
        max_active_video_publications: 10,
        reconnect_grace_seconds: 300,
      },
    };
  }
  return { token: fakeToken(), expires_at: Math.floor(Date.now() / 1000) + 3600 };
}

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  probe.close();
  await once(probe, "close");
  return port;
}

describe("the playground server against an API that fails in transit", () => {
  before(async () => {
    api = createServer((req, res) => {
      received.push(`${req.method} ${req.url}`);
      req.resume();
      if (dropsRemaining > 0) {
        dropsRemaining -= 1;
        // Destroyed rather than answered: the socket closes with no response at all, which is the
        // failure that leaves no trace in an access log and arrives here as "fetch failed".
        req.socket.destroy();
        return;
      }
      const body = respondWith.status >= 400
        ? respondWith.body
        : apiBody(req.url.split("?")[0]);
      res.writeHead(respondWith.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    apiPort = await freePort();
    api.listen(apiPort, "127.0.0.1");
    await once(api, "listening");

    serverPort = await freePort();
    server = spawn("npx", ["tsx", "server/index.ts"], {
      env: {
        ...process.env,
        PORT: String(serverPort),
        // Never reaches a real deployment: every call in this file goes to the socket above.
        HELLAVE_BASE_URL: `http://127.0.0.1:${apiPort}`,
        HELLAVE_API_KEY: "test-key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stderr.on("data", (chunk) => { serverStderr += chunk; });

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        await fetch(`http://127.0.0.1:${serverPort}/api/create-room`, { method: "POST" });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  after(async () => {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      await Promise.race([once(server, "exit"), new Promise((r) => setTimeout(r, 5_000))]);
    }
    if (api) {
      api.close();
      await once(api, "close").catch(() => {});
    }
  });

  /** Reset between cases: each one states its own failure. */
  function expectApi({ drops = 0, status = 201, body = undefined } = {}) {
    received = [];
    dropsRemaining = drops;
    respondWith = { status, body };
    serverStderr = "";
  }

  const createRoom = () => fetch(`http://127.0.0.1:${serverPort}/api/create-room`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: "retry-host" }),
  });

  it("recovers a create-room whose connection was dropped", async () => {
    expectApi({ drops: 1 });

    const res = await createRoom();
    // Read once: a body consumed inside an assertion message is unusable by the time the assertion
    // that needs it runs.
    const created = await res.json();
    assert.equal(res.status, 200, `expected the room to be created: ${JSON.stringify(created)}`);
    assert.equal(created.roomInstanceId, "instance-under-test");

    // Twice for the room instance is the point: the first attempt got no response, so a run that
    // asserted only the 200 would pass with the retry removed.
    const instanceAttempts = received.filter((r) => r === "POST /v1/room-instances");
    assert.equal(
      instanceAttempts.length,
      2,
      `expected one dropped attempt and one that landed, saw ${JSON.stringify(received)}`,
    );
    assert.match(serverStderr, /reattempting \(2 of 3\)/);
  });

  it("gives up with the reason when the connection never holds", async () => {
    expectApi({ drops: 99 });

    const res = await createRoom();
    assert.equal(res.status, 500);
    const { error } = await res.json();
    // The cause, not just "fetch failed" — that string alone is what made the original failure
    // impossible to tell apart from the API refusing the request.
    assert.match(error, /fetch failed: .+/);
    assert.equal(
      received.filter((r) => r === "POST /v1/room-instances").length,
      3,
      "three attempts in total, so two reattempts",
    );
  });

  it("does not reattempt a refusal the API has already decided", async () => {
    expectApi({
      drops: 0,
      status: 403,
      body: {
        code: "forbidden",
        message: "the room policy does not allow lobby attachment",
        retryable: false,
      },
    });

    const res = await createRoom();
    assert.equal(res.status, 403);
    const { error } = await res.json();
    assert.match(error, /does not allow lobby/);
    // One attempt only. Reattempting a decision about this request repeats the refusal, and the
    // lobby fallback in /api/token and /api/join-room is built on that refusal arriving unchanged.
    assert.equal(
      received.filter((r) => r === "POST /v1/room-instances").length,
      1,
      `a refusal must not be reattempted, saw ${JSON.stringify(received)}`,
    );
  });

  it("reattempts a failure the API itself marked retryable", async () => {
    expectApi({
      drops: 0,
      status: 503,
      body: { code: "unavailable", message: "no media node is ready", retryable: true },
    });

    const res = await createRoom();
    assert.equal(res.status, 503);
    assert.equal(
      received.filter((r) => r === "POST /v1/room-instances").length,
      3,
      "the backend said retryable, so it should have been reattempted",
    );
  });
});
