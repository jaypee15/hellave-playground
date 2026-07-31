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
      (await pc.getStats()).forEach((r) => {
        if (r.type === "candidate-pair") {
          info.pairs.push({
            state: r.state,
            nominated: r.nominated,
            requestsSent: r.requestsSent,
            responsesReceived: r.responsesReceived,
          });
        }
        if (r.type === "local-candidate") info.local.push(`${r.candidateType}/${r.protocol}`);
        if (r.type === "remote-candidate") {
          info.remote.push(`${r.candidateType}/${r.protocol}:${r.port}`);
        }
      });
      out.push(info);
    }
    return out;
  });
}

async function newPage(label) {
  const context = await browser.newContext({ permissions: ["microphone"] });
  const page = await context.newPage();
  await page.addInitScript(PC_SPY);
  page.on("console", (msg) => {
    if (msg.type() === "error") process.stderr.write(`[${label}] ${msg.text()}\n`);
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

    // Host publishes the fake microphone.
    const publish = host.getByRole("button", { name: "Publish Mic" });
    await publish.waitFor({ timeout: 60_000 });
    await publish.click();

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
  });
});
