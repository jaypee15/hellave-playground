/**
 * Media test: two real browsers, one publishing a fake microphone, asserting RTP arrives.
 *
 * lifecycle.test.mjs proves everything up to attach. This proves the part that only a
 * browser can: ICE against the TURN/SFU, DTLS, and SRTP actually flowing through the SFU.
 * It is the only check that exercises UDP to the SFU media port, which cannot be verified
 * from outside the host.
 *
 *   npm run test:audio
 *
 * Chromium runs with --use-fake-device-for-media-stream, which synthesises a tone, and
 * --use-fake-ui-for-media-stream so getUserMedia needs no click. The assertion reads
 * getStats() from the receiving peer connection rather than trusting UI state: inbound
 * audio with packetsReceived > 0 is the only proof media crossed the network.
 *
 * Requires a build (`npm run build`) — the express server serves dist/ and /api on one
 * origin, so the browser sees the same-origin setup production uses.
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

const API_KEY = process.env["HELLAVE_API_KEY"];
const PORT = Number(process.env["AUDIO_PORT"] ?? 3098);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const MEDIA_WAIT_MS = Number(process.env["AUDIO_WAIT_MS"] ?? 30_000);
const CASE_TIMEOUT = { timeout: 180_000 };

/**
 * The local stack's control script, when this run is pointed at a local stack.
 *
 * Restarting a service is only meaningful — and only permissible — against a stack this machine
 * owns, so the restart case skips when HELLAVE_BASE_URL names anything else.
 */
const STACK_SCRIPT =
  process.env["HELLAVE_STACK_SCRIPT"]
  ?? new URL("../../Hellave/scripts/local-stack.sh", import.meta.url).pathname;
const LOCAL_STACK =
  /127\.0\.0\.1|localhost/.test(process.env["HELLAVE_BASE_URL"] ?? "") && existsSync(STACK_SCRIPT);

let server;
let browser;
let shuttingDown = false;

/**
 * Capture every RTCPeerConnection the SDK creates so the test can read getStats() without
 * depending on SDK internals.
 */
const PC_SPY = `
  window.__hellavePCs = [];
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...args) {
    const pc = new Native(...args);
    window.__hellavePCs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = Native.prototype;
  Object.assign(window.RTCPeerConnection, Native);
`;

/**
 * Record why the control WebSocket closed.
 *
 * The server can close the socket without logging anything, and the SDK reports only that "the
 * Public Edge connection closed" — so without the close code a dropped control connection is
 * indistinguishable from a negotiation bug. 1009 means the message was too large, 1011 an
 * internal error, 1006 an abnormal close with no frame at all.
 */
const WS_SPY = `
  window.__hellaveSockets = [];
  const NativeWS = window.WebSocket;
  window.WebSocket = function (...args) {
    const ws = new NativeWS(...args);
    const record = { url: String(args[0]), closed: null, largestSent: 0, sent: 0, rejected: [], transcript: [], notices: [] };
    window.__hellaveSockets.push(record);
    const send = ws.send.bind(ws);
    const note = (arrow, data) => {
      if (record.transcript.length >= 120 || typeof data !== "string") return;
      try {
        const value = JSON.parse(data);
        // Concatenation, not a template literal: this whole spy is itself a template literal, so
        // an inner placeholder would be interpolated by the outer one at module load.
        record.transcript.push(arrow + (value.type || "?"));
        // Lifetime notices carry the deadline that governs the session, and a session torn down
        // early looks identical to a negotiation failure from the outside.
        if (arrow === "<" && /expir|terminat|clos|ice_servers/i.test(value.type || "")) {
          record.notices.push(data.slice(0, 400));
        }
      } catch {
        record.transcript.push(arrow + "unparseable");
      }
    };
    ws.send = (data) => {
      const size = typeof data === "string" ? new Blob([data]).size : (data.byteLength ?? 0);
      record.sent += 1;
      record.largestSent = Math.max(record.largestSent, size);
      note(">", data);
      return send(data);
    };
    // Anything the SDK would reject as "an invalid message", kept verbatim. A server message that
    // fails to parse is otherwise reported only as that phrase, which cannot distinguish a
    // truncated frame from a binary one from a valid message the SDK simply did not expect.
    ws.addEventListener("message", (event) => {
      const data = event.data;
      note("<", data);
      if (typeof data !== "string") {
        record.rejected.push({ kind: typeof data, size: data?.size ?? data?.byteLength ?? null });
        return;
      }
      try {
        const value = JSON.parse(data);
        if (!value || typeof value.type !== "string") {
          record.rejected.push({ kind: "no-type", size: data.length, head: data.slice(0, 200) });
        }
      } catch {
        record.rejected.push({
          kind: "unparseable",
          size: data.length,
          head: data.slice(0, 120),
          tail: data.slice(-120),
        });
      }
    });
    ws.addEventListener("close", (event) => {
      record.closed = { code: event.code, reason: event.reason, wasClean: event.wasClean };
    });
    return ws;
  };
  window.WebSocket.prototype = NativeWS.prototype;
  Object.assign(window.WebSocket, NativeWS);
`;

/** What happened on this page's control sockets: how much was sent, and why they closed. */
async function socketReport(page) {
  return page.evaluate(() =>
    (window.__hellaveSockets ?? []).map((s) => ({
      largestSent: s.largestSent,
      messages: s.sent,
      closed: s.closed,
      rejected: s.rejected,
      transcript: s.transcript,
      notices: s.notices,
    })),
  );
}

/**
 * Sum RTP of one direction and kind across every peer connection on the page.
 *
 * `tracks` counts the receivers or senders carrying that kind, which is the measurement that
 * matters for a subscriber: one m-line is negotiated per remote publication, so a page that can
 * see three cameras but only ever has one inbound video track has not been renegotiated.
 *
 * Video-only: a receiver reports `inbound-rtp` for a track that was negotiated but never carried
 * a frame, so packet counts have to be checked as well as track counts.
 */
async function rtpTotals(page, direction, kind) {
  return page.evaluate(
    async ([direction, kind]) => {
      const sent = direction === "outbound";
      const totals = sent
        ? { packetsSent: 0, bytesSent: 0, tracks: 0 }
        : { packetsReceived: 0, bytesReceived: 0, tracks: 0 };
      for (const pc of window.__hellavePCs ?? []) {
        const stats = await pc.getStats();
        stats.forEach((report) => {
          if (report.type !== `${direction}-rtp` || report.kind !== kind) return;
          totals.tracks += 1;
          if (sent) {
            totals.packetsSent += report.packetsSent ?? 0;
            totals.bytesSent += report.bytesSent ?? 0;
          } else {
            totals.packetsReceived += report.packetsReceived ?? 0;
            totals.bytesReceived += report.bytesReceived ?? 0;
          }
        });
      }
      return totals;
    },
    [direction, kind],
  );
}

async function inboundAudio(page) {
  return rtpTotals(page, "inbound", "audio");
}

async function outboundAudio(page) {
  return rtpTotals(page, "outbound", "audio");
}

async function inboundVideo(page) {
  return rtpTotals(page, "inbound", "video");
}

async function outboundVideo(page) {
  return rtpTotals(page, "outbound", "video");
}

/**
 * How long a media capability lives on the stack under test.
 *
 * Signaling derives it as min(meeting_token_ttl - 1, 120), and the meeting token's own lifetime
 * is whatever that deployment configured — 60s locally, 300s in production. A test that must
 * outlive a capability therefore cannot hardcode the wait: it reads the token's expiry off a
 * freshly minted one and applies the same formula.
 */
async function capabilitySeconds(roomInstanceId) {
  const response = await fetch(`${ORIGIN}/api/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      roomInstanceId,
      displayName: "capability-probe",
      peerId: `capability-probe-${Date.now()}`,
      sessionId: `capability-probe-${Date.now()}`,
    }),
  });
  assert.ok(response.ok, `could not mint a probe token: HTTP ${response.status}`);
  const { expiresAt } = await response.json();
  // expiresAt is epoch seconds or an ISO timestamp depending on the API version; both parse.
  const expiresMs = Number.isFinite(Number(expiresAt))
    ? Number(expiresAt) * 1000
    : Date.parse(expiresAt);
  assert.ok(Number.isFinite(expiresMs), `unreadable token expiry: ${expiresAt}`);
  const tokenSeconds = Math.round((expiresMs - Date.now()) / 1000);
  assert.ok(tokenSeconds > 1, `probe token was already expiring: ${tokenSeconds}s`);
  return Math.min(tokenSeconds - 1, 120);
}

/** Poll until the predicate holds, so a slow ICE handshake is not a failure. */
async function waitFor(fn, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${label} — last observed: ${JSON.stringify(last)}`);
}

/**
 * Dump why media failed: ICE state, candidate types on both sides, and STUN check counts.
 * A pair with many requests and zero responses means the far side is unreachable — usually a
 * closed UDP port rather than anything wrong with the negotiation.
 */
async function iceDiagnostics(page) {
  return page.evaluate(async () => {
    const out = [];
    for (const pc of window.__hellavePCs ?? []) {
      const info = {
        ice: pc.iceConnectionState,
        connection: pc.connectionState,
        gathering: pc.iceGatheringState,
        sendersWithTrack: pc.getSenders().filter((s) => s.track).length,
        pairs: [],
        local: [],
        remote: [],
      };
      // Candidates are indexed first so each pair can name the two endpoints it joins.
      // Without that, "two pairs got no response" cannot distinguish a blocked public port
      // from a relay path that was never attempted.
      const stats = await pc.getStats();
      const candidates = new Map();
      stats.forEach((r) => {
        if (r.type === "local-candidate" || r.type === "remote-candidate") {
          candidates.set(r.id, `${r.candidateType}/${r.protocol}:${r.address}:${r.port}`);
        }
      });
      stats.forEach((r) => {
        if (r.type === "candidate-pair") {
          info.pairs.push({
            state: r.state,
            nominated: r.nominated,
            requestsSent: r.requestsSent,
            responsesReceived: r.responsesReceived,
            from: candidates.get(r.localCandidateId) ?? r.localCandidateId,
            to: candidates.get(r.remoteCandidateId) ?? r.remoteCandidateId,
          });
        }
        if (r.type === "local-candidate") info.local.push(`${r.candidateType}/${r.protocol}`);
        if (r.type === "remote-candidate") {
          info.remote.push(`${r.candidateType}/${r.protocol}:${r.address}:${r.port}`);
        }
      });
      out.push(info);
    }
    return out;
  });
}

/**
 * Contexts opened by the running case, closed when it ends.
 *
 * Cases used to leave every browser context open until the whole file finished, so a participant
 * from the first case was still in its room during the last one. Closing a tab is a leave, so
 * they really were live sessions: by the end of a run the node was holding every participant the
 * suite had ever created, and cases began timing out in an order that varied run to run.
 */
let openContexts = [];

async function newPage(label) {
  const context = await browser.newContext({ permissions: ["microphone", "camera"] });
  openContexts.push(context);
  const page = await context.newPage();
  await page.addInitScript(PC_SPY);
  await page.addInitScript(WS_SPY);
  page.consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      page.consoleErrors.push(msg.text());
      process.stderr.write(`[${label}] ${msg.text()}\n`);
    }
  });
  return page;
}

/** Create a room and return its instance id. */
async function createRoom(page, name) {
  await page.goto(ORIGIN);
  await page.getByRole("button", { name: "Create a Room" }).click();
  await page.getByPlaceholder("Your name").fill(name);
  await page.getByRole("button", { name: /Create & Join|Creating/ }).click();
  return page.getByTestId("room-instance-id").innerText({ timeout: 60_000 });
}

async function joinRoom(page, roomInstanceId, name) {
  await page.goto(ORIGIN);
  await page.getByRole("button", { name: "Join a Room" }).click();
  await page.getByPlaceholder("Room Instance ID").fill(roomInstanceId);
  await page.getByPlaceholder("Your name").fill(name);
  await page.getByRole("button", { name: /^Join$|Joining/ }).click();
  await page.getByTestId("room-instance-id").waitFor({ timeout: 60_000 });
}

/**
 * The app's own event log.
 *
 * Publish failures are reported with addEvent and never reach the console, so a test that only
 * watches console errors sees a silent timeout instead of the reason. Any assertion about
 * publishing needs this to say anything useful.
 */
async function appEvents(page) {
  const drawer = page.getByTestId("debug-drawer");
  if (!(await drawer.isVisible().catch(() => false))) {
    await page.getByTestId("debug-toggle").click().catch(() => {});
    await drawer.waitFor({ timeout: 30_000 }).catch(() => {});
  }
  return drawer.innerText().catch(() => "(no event log available)");
}

/** Turn on the camera and wait until it is actually sending, not merely toggled. */
async function startCamera(page, label) {
  const toggle = page.getByTestId("camera-toggle");
  await toggle.waitFor({ timeout: 60_000 });
  await toggle.click();
  try {
    await waitFor(
      () => outboundVideo(page),
      (t) => t.packetsSent > 0,
      MEDIA_WAIT_MS,
      `${label} never sent camera RTP`,
    );
  } catch (error) {
    const sockets = JSON.stringify(await socketReport(page));
    throw new Error(
      `${error.message}\n${label} control sockets: ${sockets}\n${label} event log:\n${await appEvents(page)}`,
    );
  }
}

describe("media through the SFU", () => {
  before(async () => {
    assert.ok(API_KEY, "HELLAVE_API_KEY must be set");
    assert.ok(
      existsSync(new URL("../dist/index.html", import.meta.url)),
      "dist/ is missing — run `npm run build` first",
    );

    server = spawn("npx", ["tsx", "server/index.ts"], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    server.stderr.on("data", (chunk) => { stderr += chunk; });
    server.once("exit", (code, signal) => {
      if (shuttingDown || code === 0 || code === null || code === 143 || signal) return;
      throw new Error(`playground server exited with ${code}: ${stderr}`);
    });

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        await fetch(`${ORIGIN}/`);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    browser = await chromium.launch({
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
        // getDisplayMedia otherwise opens a picker no test can click. The SDK requests plain
        // { video: true } rather than preferring the current tab, so the desktop source is what
        // has to be auto-selected.
        "--auto-select-desktop-capture-source=Entire screen",
      ],
    });
  });

  // Every case leaves the room it created, so the next one starts against an empty node rather
  // than inheriting every participant the suite has opened so far.
  afterEach(async () => {
    const contexts = openContexts;
    openContexts = [];
    await Promise.all(contexts.map((context) => context.close().catch(() => {})));
  });

  after(async () => {
    if (browser) await browser.close().catch(() => {});
    if (server && server.exitCode === null) {
      shuttingDown = true;
      server.kill("SIGTERM");
      await Promise.race([
        once(server, "exit").catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
  });

  // Was KNOWN FAILING: a media session used to be created only by publishing, so a listener never
  // got an SFU transport and the SFU logged peers_in_room=1 for a room with two participants. It
  // passes now — verified receiving RTP, not merely not erroring.
  it("carries audio to a listener that publishes nothing", CASE_TIMEOUT, async () => {
    // A participant who joins only to listen must hear the room.
    const host = await newPage("listen-host");
    const listener = await newPage("listener");

    await host.goto(ORIGIN);
    await host.getByRole("button", { name: "Create a Room" }).click();
    await host.getByPlaceholder("Your name").fill("listen-host");
    await host.getByRole("button", { name: /Create & Join|Creating/ }).click();
    const roomInstanceId = await host
      .getByTestId("room-instance-id")
      .innerText({ timeout: 60_000 });

    await listener.goto(ORIGIN);
    await listener.getByRole("button", { name: "Join a Room" }).click();
    await listener.getByPlaceholder("Room Instance ID").fill(roomInstanceId);
    await listener.getByPlaceholder("Your name").fill("listener");
    await listener.getByRole("button", { name: /^Join$|Joining/ }).click();
    await listener.getByTestId("room-instance-id").waitFor({ timeout: 60_000 });

    // Only the host publishes. The listener never touches a capture control.
    const publish = host.getByRole("button", { name: "Publish Mic" });
    await publish.waitFor({ timeout: 60_000 });
    await publish.click();
    await waitFor(
      () => outboundAudio(host),
      (t) => t.packetsSent > 0,
      MEDIA_WAIT_MS,
      "host never sent audio RTP",
    );

    const received = await waitFor(
      () => inboundAudio(listener),
      (t) => t.packetsReceived > 0,
      MEDIA_WAIT_MS,
      "a listener that publishes nothing received no audio",
    );
    assert.ok(received.bytesReceived > 0, `listener heard nothing: ${JSON.stringify(received)}`);
  });

  it("carries a published microphone from one browser to another", CASE_TIMEOUT, async () => {
    const host = await newPage("host");
    const guest = await newPage("guest");

    // Host creates the room.
    await host.goto(ORIGIN);
    await host.getByRole("button", { name: "Create a Room" }).click();
    await host.getByPlaceholder("Your name").fill("audio-host");
    await host.getByRole("button", { name: /Create & Join|Creating/ }).click();

    const roomInstanceId = await host
      .getByTestId("room-instance-id")
      .innerText({ timeout: 60_000 });
    assert.match(roomInstanceId, /^[0-9a-f-]{36}$/, "expected a room instance UUID in the UI");

    // Guest joins the same room instance.
    await guest.goto(ORIGIN);
    await guest.getByRole("button", { name: "Join a Room" }).click();
    await guest.getByPlaceholder("Room Instance ID").fill(roomInstanceId);
    await guest.getByPlaceholder("Your name").fill("audio-guest");
    await guest.getByRole("button", { name: /^Join$|Joining/ }).click();
    await guest.getByTestId("room-instance-id").waitFor({ timeout: 60_000 });

    // Both publish. A participant only gets an SFU session when it publishes something —
    // push_pending_media_offer needs its own publication_id — so a listen-only guest never
    // receives anything. Two-way is also what an ordinary call looks like.
    const publish = host.getByRole("button", { name: "Publish Mic" });
    await publish.waitFor({ timeout: 60_000 });
    await publish.click();

    const guestPublish = guest.getByRole("button", { name: "Publish Mic" });
    await guestPublish.waitFor({ timeout: 60_000 });
    await guestPublish.click();

    let sent;
    try {
      sent = await waitFor(
        () => outboundAudio(host),
        (t) => t.packetsSent > 0,
        MEDIA_WAIT_MS,
        "host never sent audio RTP to the SFU",
      );
    } catch (error) {
      const diag = await iceDiagnostics(host);
      throw new Error(`${error.message}\n  host ICE: ${JSON.stringify(diag)}`);
    }
    assert.ok(sent.packetsSent > 0, `host sent no audio: ${JSON.stringify(sent)}`);

    let received;
    try {
      received = await waitFor(
        () => inboundAudio(guest),
        (t) => t.packetsReceived > 0,
        MEDIA_WAIT_MS,
        "guest never received audio RTP from the SFU",
      );
    } catch (error) {
      const diag = await iceDiagnostics(guest);
      const sockets = await socketReport(guest);
      throw new Error(
        `${error.message}\n  guest ICE: ${JSON.stringify(diag)}` +
          `\n  guest sockets: ${JSON.stringify(sockets)}`,
      );
    }
    assert.ok(
      received.bytesReceived > 0,
      `guest received no audio bytes: ${JSON.stringify(received)}`,
    );

    // Record which path media actually took. AUDIO_EXPECT_PATH=relay asserts the TURN
    // fallback specifically — used when UDP to the SFU is deliberately blocked.
    const [hostPath, guestPath] = await Promise.all([
      iceDiagnostics(host),
      iceDiagnostics(guest),
    ]);
    const selected = (diag) =>
      diag.flatMap((pc) => pc.remote.map((r) => r)).join(",") || "none";
    process.stderr.write(
      `\n[media path] host locals=${JSON.stringify(hostPath.map((p) => p.local))} ` +
        `remote=${selected(hostPath)}\n[media path] guest locals=` +
        `${JSON.stringify(guestPath.map((p) => p.local))} remote=${selected(guestPath)}\n`,
    );

    const expected = process.env["AUDIO_EXPECT_PATH"];
    if (expected) {
      const uiPath = await host.getByTestId("media-path").innerText({ timeout: 30_000 });
      assert.match(
        uiPath,
        new RegExp(expected),
        `expected the media path to be ${expected}, got ${uiPath}`,
      );
    }
  });

  // Three, because two never caught this. A subscriber needs a fresh m-line for every remote
  // publication, so it has to be renegotiated once per publisher. With two participants a single
  // renegotiation covers everything and the suite was green while the earliest joiner in a real
  // five-person room heard exactly one person: renegotiation_offers_sent was 1 for every
  // participant in it, ever.
  //
  // The order matters. The first page must already be settled with the second before the third
  // publishes, so the third arrives *after* its one renegotiation rather than inside it.
  it("carries a third publisher to whoever joined first", CASE_TIMEOUT, async () => {
    const first = await newPage("first");
    const second = await newPage("second");
    const third = await newPage("third");

    await first.goto(ORIGIN);
    await first.getByRole("button", { name: "Create a Room" }).click();
    await first.getByPlaceholder("Your name").fill("three-first");
    await first.getByRole("button", { name: /Create & Join|Creating/ }).click();
    const roomInstanceId = await first
      .getByTestId("room-instance-id")
      .innerText({ timeout: 60_000 });

    const join = async (page, name) => {
      await page.goto(ORIGIN);
      await page.getByRole("button", { name: "Join a Room" }).click();
      await page.getByPlaceholder("Room Instance ID").fill(roomInstanceId);
      await page.getByPlaceholder("Your name").fill(name);
      await page.getByRole("button", { name: /^Join$|Joining/ }).click();
      await page.getByTestId("room-instance-id").waitFor({ timeout: 60_000 });
    };
    const publish = async (page) => {
      const button = page.getByRole("button", { name: "Publish Mic" });
      await button.waitFor({ timeout: 60_000 });
      await button.click();
    };

    await join(second, "three-second");
    await publish(first);
    await publish(second);

    // Settle the two-party call first, so the third is unambiguously a later arrival.
    const beforeThird = await waitFor(
      () => inboundAudio(first),
      (t) => t.packetsReceived > 0,
      MEDIA_WAIT_MS,
      "the first participant never received the second",
    );

    await join(third, "three-third");
    await publish(third);

    // Two inbound audio streams on the first page: one per remote publisher. A count that stays
    // at one is the bug — the third's m-line was never negotiated onto this transport.
    const afterThird = await waitFor(
      () => inboundAudio(first),
      (t) => t.tracks >= 2 && t.packetsReceived > beforeThird.packetsReceived,
      MEDIA_WAIT_MS,
      "the first participant never received the third publisher",
    ).catch(async (error) => {
      throw new Error(
        `${error.message}\n  first ICE: ${JSON.stringify(await iceDiagnostics(first))}` +
          `\n  third ICE: ${JSON.stringify(await iceDiagnostics(third))}` +
          `\n  third sockets: ${JSON.stringify(await socketReport(third))}`,
      );
    });
    assert.ok(
      afterThird.tracks >= 2,
      `expected two inbound audio streams on the first participant, got ${JSON.stringify(afterThird)}`,
    );

    // And the third must hear the two who were already there.
    const thirdInbound = await waitFor(
      () => inboundAudio(third),
      (t) => t.tracks >= 2,
      MEDIA_WAIT_MS,
      "the third participant never received the two already publishing",
    );
    assert.ok(thirdInbound.packetsReceived > 0);
  });

  // Cameras, not microphones. Everything above measures audio, and video is not the same path:
  // it carries simulcast layers, it is subject to a per-subscriber video slot budget the SFU
  // enforces separately, and a video receiver reports inbound-rtp for a track that was
  // negotiated but never carried a frame. So "only one person can have video at a time" is
  // invisible to every audio assertion in this file.
  it("carries two cameras between two publishers", CASE_TIMEOUT, async () => {
    const host = await newPage("cam-host");
    const guest = await newPage("cam-guest");

    const roomInstanceId = await createRoom(host, "cam-host");
    await joinRoom(guest, roomInstanceId, "cam-guest");

    await startCamera(host, "cam-host");
    await startCamera(guest, "cam-guest");

    // Frames, not just a negotiated m-line: packetsReceived is what separates a subscription
    // that works from one that was set up and left empty.
    for (const [page, label] of [
      [host, "host"],
      [guest, "guest"],
    ]) {
      const received = await waitFor(
        () => inboundVideo(page),
        (t) => t.tracks >= 1 && t.packetsReceived > 0,
        MEDIA_WAIT_MS,
        `${label} received no camera video`,
      );
      assert.ok(
        received.bytesReceived > 0,
        `${label} saw an empty video track: ${JSON.stringify(received)}`,
      );
    }
  });

  // The reported bug: "only one person can have video on at the same time". Three cameras is the
  // smallest room that can show it — with two, one inbound video track per page is both the
  // correct answer and the broken one, so the count cannot distinguish them.
  it("carries three cameras at once", CASE_TIMEOUT, async () => {
    const first = await newPage("cam3-first");
    const second = await newPage("cam3-second");
    const third = await newPage("cam3-third");

    const roomInstanceId = await createRoom(first, "cam3-first");
    await joinRoom(second, roomInstanceId, "cam3-second");
    await joinRoom(third, roomInstanceId, "cam3-third");

    await startCamera(first, "cam3-first");
    await startCamera(second, "cam3-second");
    await startCamera(third, "cam3-third");

    // Every page must see both other cameras carrying frames. One track apiece is the symptom.
    for (const [page, label] of [
      [first, "first"],
      [second, "second"],
      [third, "third"],
    ]) {
      const received = await waitFor(
        () => inboundVideo(page),
        (t) => t.tracks >= 2 && t.packetsReceived > 0,
        MEDIA_WAIT_MS,
        `${label} did not receive both other cameras`,
      );
      assert.ok(
        received.tracks >= 2,
        `${label} saw ${received.tracks} camera(s), expected 2: ${JSON.stringify(received)}`,
      );
    }
  });

  // A screen share is a second video publication from a participant that already has one, so it
  // is the case where one peer must be renegotiated onto two inbound video m-lines from the same
  // publisher — distinct from two publishers with one camera each.
  it("carries a screen share alongside the sharer's camera", CASE_TIMEOUT, async () => {
    const sharer = await newPage("share-sharer");
    const viewer = await newPage("share-viewer");

    const roomInstanceId = await createRoom(sharer, "share-sharer");
    await joinRoom(viewer, roomInstanceId, "share-viewer");

    await startCamera(sharer, "share-sharer");
    const beforeShare = await waitFor(
      () => inboundVideo(viewer),
      (t) => t.tracks >= 1 && t.packetsReceived > 0,
      MEDIA_WAIT_MS,
      "the viewer never received the sharer's camera",
    );

    const screenToggle = sharer.getByTestId("screen-toggle");
    await screenToggle.waitFor({ timeout: 60_000 });
    await screenToggle.click();
    // Surfaced explicitly: if the picker could not be auto-selected, getDisplayMedia rejects and
    // the app reports it rather than throwing, so the failure would otherwise look like a
    // negotiation problem.
    await sharer.getByTestId("debug-toggle").click();
    await sharer.getByTestId("debug-drawer").waitFor({ timeout: 30_000 });
    await waitFor(
      async () => sharer.getByTestId("debug-drawer").innerText(),
      (text) => /Screen shared/i.test(text) || /Screen share failed/i.test(text),
      MEDIA_WAIT_MS,
      "the sharer neither shared nor reported a failure",
    );
    const shareEvents = await sharer.getByTestId("debug-drawer").innerText();
    assert.ok(
      !/Screen share failed/i.test(shareEvents),
      `screen capture did not start:\n${shareEvents}`,
    );

    const afterShare = await waitFor(
      () => inboundVideo(viewer),
      (t) => t.tracks >= 2 && t.packetsReceived > beforeShare.packetsReceived,
      MEDIA_WAIT_MS,
      "the viewer never received the screen share alongside the camera",
    );
    assert.ok(
      afterShare.tracks >= 2,
      `expected camera and screen on the viewer, got ${JSON.stringify(afterShare)}`,
    );
  });

  // The case above with time added, which is the only difference that matters and the reason
  // this bug shipped anyway.
  //
  // The SFU stamps each participant's identity binding with the expiry of the media capability
  // it arrived with, and prunes expired bindings when the *next* participant binds. So the
  // trigger needs both halves at once: a participant older than one capability lifetime, and
  // somebody new arriving. Every other case in this file finishes inside twenty seconds, so
  // nothing was ever old enough; the long-call case is old enough but has a single participant,
  // so nothing ever binds to run the prune. Neither half is a bug on its own, which is exactly
  // why a suite full of both was green while the earliest joiner in a real room went deaf.
  //
  // The wait is measured, not hardcoded: the fuse is min(meeting_token_ttl - 1, 120) seconds, so
  // it is 65s against the local stack's 60s token and 125s against a production-shaped 300s one.
  it(
    "carries a publisher that arrives after the first participant's capability expired",
    { timeout: 420_000 },
    async () => {
      const first = await newPage("expiry-first");
      const second = await newPage("expiry-second");
      const third = await newPage("expiry-third");

      await first.goto(ORIGIN);
      await first.getByRole("button", { name: "Create a Room" }).click();
      await first.getByPlaceholder("Your name").fill("expiry-first");
      await first.getByRole("button", { name: /Create & Join|Creating/ }).click();
      const roomInstanceId = await first
        .getByTestId("room-instance-id")
        .innerText({ timeout: 60_000 });

      const join = async (page, name) => {
        await page.goto(ORIGIN);
        await page.getByRole("button", { name: "Join a Room" }).click();
        await page.getByPlaceholder("Room Instance ID").fill(roomInstanceId);
        await page.getByPlaceholder("Your name").fill(name);
        await page.getByRole("button", { name: /^Join$|Joining/ }).click();
        await page.getByTestId("room-instance-id").waitFor({ timeout: 60_000 });
      };
      const publish = async (page) => {
        const button = page.getByRole("button", { name: "Publish Mic" });
        await button.waitFor({ timeout: 60_000 });
        await button.click();
      };

      await join(second, "expiry-second");
      await publish(first);
      await publish(second);

      const beforeThird = await waitFor(
        () => inboundAudio(first),
        (t) => t.packetsReceived > 0,
        MEDIA_WAIT_MS,
        "the first participant never received the second",
      );

      // Ask the stack how long its capabilities live rather than assuming, so this stays correct
      // against a local 60s token and a deployed 300s one. A probe token is minted for a peer
      // that never connects, which is inert — it is read for its expiry and discarded.
      await first.waitForTimeout((await capabilitySeconds(roomInstanceId)) * 1000 + 5_000);

      await join(third, "expiry-third");
      await publish(third);

      // Same assertion as the case above. What it catches here is different: the first
      // participant's binding has outlived the capability it arrived with, and the third's
      // arrival is what sweeps it away — so the renegotiation poll gets 403 and this count stays
      // at one for a participant that is otherwise perfectly healthy.
      const afterThird = await waitFor(
        () => inboundAudio(first),
        (t) => t.tracks >= 2 && t.packetsReceived > beforeThird.packetsReceived,
        MEDIA_WAIT_MS,
        "the first participant went deaf to later arrivals once its capability expired",
      );
      assert.ok(
        afterThird.tracks >= 2,
        `expected two inbound audio streams on the first participant, got ${JSON.stringify(afterThird)}`,
      );

      // The first participant must also still be heard. Media already flowing survives a refused
      // poll, so audio in one direction is not evidence the session is intact.
      const secondInbound = await waitFor(
        () => inboundAudio(second),
        (t) => t.tracks >= 2,
        MEDIA_WAIT_MS,
        "the second participant never received the third",
      );
      assert.ok(secondInbound.packetsReceived > 0);

      // Inherited from the long-call case this replaced. Receiving tracks proves the
      // renegotiation worked; these two prove the session did not merely limp there. A capability
      // that failed to reissue shows up as a degraded control attachment and as a credential
      // error on the console, and neither stops media that is already flowing — which is how a
      // broken session passed an audio-only assertion before.
      await first.getByTestId("debug-toggle").click();
      await first.getByTestId("debug-drawer").waitFor({ timeout: 30_000 });
      const events = await first.getByTestId("debug-drawer").innerText();
      assert.ok(
        !/degraded/i.test(events),
        `the control attachment degraded while outliving its capability:\n${events}`,
      );
      const errors = first.consoleErrors.join(" | ");
      assert.ok(
        !/authentication_failed|Meeting Token expired|Media Capability/i.test(errors),
        `the session did not survive its credentials: ${errors}`,
      );
    },
  );

  // FAILING, for a reason worth keeping visible: a signaling restart still destroys the room.
  //
  // It was written for the fatal trickled ICE candidate, which Hellave 7b37656 fixed — that alone
  // ended every live call on every deploy, 108 of them in three minutes. With it gone this case
  // gets further and then exposes a second, unrelated cause in a different subsystem:
  //
  //   disconnecting participant 2  reason="moderation_revoked"  ice_state=Connected
  //   removed empty media room worker
  //
  // Reconnecting clients are refused with "signaling room is owned by another live generation"
  // because the dead process's ownership lease is still held, while `retire_room_if_empty` asks an
  // in-memory registry whether the room is empty — and a fresh process sees every live room as
  // empty. So it issues DestroyRoom and the SFU kicks everyone. Signaling then retries against a
  // room that no longer exists, which the SFU reports as 500 rather than 404, so it retries
  // forever and the attachment stays degraded.
  //
  // Left failing rather than skipped: it is reporting a real bug that hit every deploy, and it
  // goes green when that is fixed. A skipped test is one nobody remembers.
  //
  // Local stack only. Restarting a service is meaningful only against a stack this machine owns.
  const localStackOnly = LOCAL_STACK ? it : it.skip;
  localStackOnly("survives a signaling restart mid-call", { timeout: 300_000 }, async () => {
    const host = await newPage("restart-host");
    const guest = await newPage("restart-guest");

    const roomInstanceId = await createRoom(host, "restart-host");
    await joinRoom(guest, roomInstanceId, "restart-guest");

    const publish = async (page) => {
      const button = page.getByRole("button", { name: "Publish Mic" });
      await button.waitFor({ timeout: 60_000 });
      await button.click();
    };
    await publish(host);
    await publish(guest);

    const before = await waitFor(
      () => inboundAudio(guest),
      (t) => t.packetsReceived > 0,
      MEDIA_WAIT_MS,
      "the guest never received audio before the restart",
    );

    execFileSync("bash", [STACK_SCRIPT, "restart-signaling"], { stdio: "ignore" });

    // A restart legitimately drops the control socket, so a transient degraded state is expected.
    // What must not happen is the call ending: media keeps flowing and the attachment comes back.
    const after = await waitFor(
      () => inboundAudio(guest),
      (t) => t.packetsReceived > before.packetsReceived,
      60_000,
      "audio stopped after signaling restarted",
    );
    assert.ok(after.packetsReceived > before.packetsReceived);

    await waitFor(
      () => guest.getByTestId("conference-state").innerText(),
      (state) => /admitted/i.test(state),
      60_000,
      "the guest's attachment never came back after the restart",
    );

    // The precise regression. A stale candidate must be ignored, never answered with a conflict.
    for (const [page, label] of [
      [host, "host"],
      [guest, "guest"],
    ]) {
      const errors = page.consoleErrors.join(" | ");
      assert.ok(
        !/unknown media transaction/i.test(errors),
        `${label} was killed by a stale ICE candidate after the restart: ${errors}`,
      );
    }
  });

  // Microphone only, deliberately: an audio-only capture is the case that used to be
  // rejected at stop with "recording contained no keyframe-safe media".
  it("records a room once media is flowing", CASE_TIMEOUT, async () => {
    // Lives here rather than in the lifecycle suite because the recording service attaches an
    // egress to the room on its SFU, and that room only exists once someone has published.
    const host = await newPage("record-host");
    await host.goto(ORIGIN);
    await host.getByRole("button", { name: "Create a Room" }).click();
    await host.getByPlaceholder("Your name").fill("record-host");
    await host.getByRole("button", { name: /Create & Join|Creating/ }).click();
    await host.getByTestId("room-instance-id").waitFor({ timeout: 60_000 });

    const publish = host.getByRole("button", { name: "Publish Mic" });
    await publish.waitFor({ timeout: 60_000 });
    await publish.click();
    await waitFor(
      () => outboundAudio(host),
      (t) => t.packetsSent > 0,
      MEDIA_WAIT_MS,
      "host never sent audio RTP, so there is nothing to record",
    );

    // Only a host is offered this, so its presence also confirms the token's capability.
    // Camera on top of the live microphone: two publications on one transport, which is what
    // used to mint a second SFU participant and fail with "room was not found".
    await host.getByRole("button", { name: "Start camera" }).click();
    await host.getByRole("button", { name: "Stop camera" }).waitFor({ timeout: 60_000 });

    const record = host.getByTestId("recording-toggle");
    await record.waitFor({ timeout: 30_000 });
    await record.click();

    await host.getByTestId("recording-indicator").waitFor({ timeout: 60_000 });

    // Record for long enough to be a recording. Stopping the instant the indicator appeared
    // captured a single video frame, which is not something a real recording ever contains and
    // which no encoder will turn into a video stream.
    await host.waitForTimeout(3_000);

    await host.getByTestId("recording-toggle").click();
    await host
      .getByTestId("recording-indicator")
      .waitFor({ state: "detached", timeout: 60_000 });
  });

  // A publishing participant is the case that broke: leave took the room's media generation
  // lock and then the publication rollback waited on the same lock, so the server never
  // acknowledged and the lock was never released. Nothing covered it, because every other
  // case here ends by closing the browser rather than by leaving.
  it("acknowledges a leave from a participant that is publishing", CASE_TIMEOUT, async () => {
    const host = await newPage("leave-host");
    await host.goto(ORIGIN);
    await host.getByRole("button", { name: "Create a Room" }).click();
    await host.getByPlaceholder("Your name").fill("leave-host");
    await host.getByRole("button", { name: /Create & Join|Creating/ }).click();
    await host.getByTestId("room-instance-id").waitFor({ timeout: 60_000 });

    const publish = host.getByRole("button", { name: "Publish Mic" });
    await publish.waitFor({ timeout: 60_000 });
    await publish.click();
    await waitFor(
      () => outboundAudio(host),
      (t) => t.packetsSent > 0,
      MEDIA_WAIT_MS,
      "host never sent audio RTP, so the leave would not carry a publication",
    );

    await host.getByRole("button", { name: "Leave" }).click();
    await host
      .getByRole("button", { name: "Create a Room" })
      .waitFor({ timeout: 30_000 });

    // The acknowledgement is what is under test, and the SDK only gives up on it after its
    // 10s command timeout — so the verdict is not in until that window has passed.
    await host.waitForTimeout(13_000);
    const failures = host.consoleErrors.filter((text) => text.includes("Leave failed"));
    assert.deepEqual(
      failures,
      [],
      "the server did not acknowledge a publishing participant's leave",
    );
  });
});
