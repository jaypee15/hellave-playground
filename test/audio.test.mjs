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
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

const API_KEY = process.env["HELLAVE_API_KEY"];
const PORT = Number(process.env["AUDIO_PORT"] ?? 3098);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const MEDIA_WAIT_MS = Number(process.env["AUDIO_WAIT_MS"] ?? 30_000);
const CASE_TIMEOUT = { timeout: 180_000 };

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

/** Sum inbound audio RTP across every peer connection on the page. */
async function inboundAudio(page) {
  return page.evaluate(async () => {
    const totals = { packetsReceived: 0, bytesReceived: 0, tracks: 0 };
    for (const pc of window.__hellavePCs ?? []) {
      const stats = await pc.getStats();
      stats.forEach((report) => {
        if (report.type === "inbound-rtp" && report.kind === "audio") {
          totals.tracks += 1;
          totals.packetsReceived += report.packetsReceived ?? 0;
          totals.bytesReceived += report.bytesReceived ?? 0;
        }
      });
    }
    return totals;
  });
}

async function outboundAudio(page) {
  return page.evaluate(async () => {
    const totals = { packetsSent: 0, bytesSent: 0, tracks: 0 };
    for (const pc of window.__hellavePCs ?? []) {
      const stats = await pc.getStats();
      stats.forEach((report) => {
        if (report.type === "outbound-rtp" && report.kind === "audio") {
          totals.tracks += 1;
          totals.packetsSent += report.packetsSent ?? 0;
          totals.bytesSent += report.bytesSent ?? 0;
        }
      });
    }
    return totals;
  });
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

async function newPage(label) {
  const context = await browser.newContext({ permissions: ["microphone", "camera"] });
  const page = await context.newPage();
  await page.addInitScript(PC_SPY);
  page.consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      page.consoleErrors.push(msg.text());
      process.stderr.write(`[${label}] ${msg.text()}\n`);
    }
  });
  return page;
}

describe("audio through the SFU", () => {
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
      ],
    });
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

  // KNOWN FAILING. A media session is still created only by publishing, so a listener never
  // gets an SFU transport: the SFU logs peers_in_room=1 for a room with two participants.
  // Left in place because it encodes the behaviour we want and is the regression test for it.
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
      throw new Error(`${error.message}\n  guest ICE: ${JSON.stringify(diag)}`);
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

  // Opt-in with HELLAVE_TEST_LONG_CALL=1 (npm run test:long). It cannot be instant — the point
  // is to outlive credentials — but the local stack deliberately runs a 60s meeting token so
  // ninety seconds is enough to cross both the join token and several capability lifetimes.
  // Against a production-shaped 300s token this needs the full CALL_SECONDS below instead.
  //
  // A call of any real length is exactly the gap that let a two-minute expiry and a five-minute
  // one both reach production: everything else in this file finishes in seconds.
  const longCall = process.env["HELLAVE_TEST_LONG_CALL"] === "1" ? it : it.skip;
  const CALL_SECONDS = Number(process.env["HELLAVE_TEST_CALL_SECONDS"] ?? 150);
  longCall("outlives the credentials it was established with", { timeout: 600_000 }, async () => {
    const host = await newPage("long-host");
    await host.goto(ORIGIN);
    await host.getByRole("button", { name: "Create a Room" }).click();
    await host.getByPlaceholder("Your name").fill("long-host");
    await host.getByRole("button", { name: /Create & Join|Creating/ }).click();
    await host.getByTestId("room-instance-id").waitFor({ timeout: 60_000 });

    const publish = host.getByRole("button", { name: "Publish Mic" });
    await publish.waitFor({ timeout: 60_000 });
    await publish.click();
    await waitFor(
      () => outboundAudio(host),
      (t) => t.packetsSent > 0,
      MEDIA_WAIT_MS,
      "host never sent audio RTP",
    );

    // Past the join token's lifetime and several capability lifetimes, so a session that cannot
    // reissue, or that is still bounded by the token it arrived with, has already failed.
    await host.waitForTimeout(CALL_SECONDS * 1000);

    // Audio alone proves nothing here: when the capability expires, the SFU refuses the
    // renegotiation poll but media already flowing carries on regardless, so this test passed
    // against the bug until it read the event log. What the expiry actually costs is the
    // control attachment, which surfaces as a degraded state.
    await host.getByTestId("debug-toggle").click();
    await host.getByTestId("debug-drawer").waitFor({ timeout: 30_000 });
    const events = await host.getByTestId("debug-drawer").innerText();
    assert.ok(
      !/degraded/i.test(events),
      `the control attachment degraded during the call:\n${events}`,
    );

    const errors = host.consoleErrors.join(" | ");
    assert.ok(
      !/authentication_failed|Meeting Token expired|Media Capability/i.test(errors),
      `call did not survive its credentials: ${errors}`,
    );
    const after = await outboundAudio(host);
    assert.ok(after.packetsSent > 0, "audio stopped flowing");
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
