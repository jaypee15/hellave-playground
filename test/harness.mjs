/**
 * Shared browser harness for the playground's end-to-end suites.
 *
 * Every suite here drives real Chromium pages against the playground's own express server, and each
 * used to carry its own copy of the setup. That duplication was not cosmetic: fixing `createRoom` and
 * `joinRoom` once left ten hand-inlined copies of the same blind wait untouched, because they were
 * separate copies of the same code rather than callers of it. This file exists so a third suite adds
 * a caller instead of a copy.
 *
 * Two kinds of export:
 *
 * - **Page helpers** that only need a page (`rtpTotals`, `waitFor`, `socketReport`, …), used directly.
 * - **`createHarness()`**, which owns the express server, the browser, and the contexts a case opens,
 *   because those need per-suite configuration (its own port) and per-suite lifecycle.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

/**
 * Capture every RTCPeerConnection the SDK creates so the test can read getStats() without
 * depending on SDK internals.
 */
export const PC_SPY = `
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
export const WS_SPY = `
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
export async function socketReport(page) {
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
export async function rtpTotals(page, direction, kind) {
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

export async function inboundAudio(page) {
  return rtpTotals(page, "inbound", "audio");
}

export async function outboundAudio(page) {
  return rtpTotals(page, "outbound", "audio");
}

export async function inboundVideo(page) {
  return rtpTotals(page, "inbound", "video");
}

export async function outboundVideo(page) {
  return rtpTotals(page, "outbound", "video");
}

/** Poll until the predicate holds, so a slow ICE handshake is not a failure. */
export async function waitFor(fn, predicate, timeoutMs, label) {
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
export async function iceDiagnostics(page) {
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
 * The app's own event log.
 *
 * Publish failures are reported with addEvent and never reach the console, so a test that only
 * watches console errors sees a silent timeout instead of the reason. Any assertion about
 * publishing needs this to say anything useful.
 */
export async function appEvents(page) {
  const drawer = page.getByTestId("debug-drawer");
  if (!(await drawer.isVisible().catch(() => false))) {
    await page.getByTestId("debug-toggle").click().catch(() => {});
    await drawer.waitFor({ timeout: 30_000 }).catch(() => {});
  }
  return drawer.innerText().catch(() => "(no event log available)");
}

/**
 * Wait to be in the room, or fail with the reason the home screen gave.
 *
 * The home screen already displays why creating or joining failed, but a test that waits only for
 * the room id never reads it: a named error like "no capacity for a new room" arrives in one
 * second and then sits on screen for the full minute, and the run reports
 * `locator.innerText: Timeout 60000ms exceeded` — which names neither the failure nor the side it
 * came from. One suite run cost a create-room 500 that way; the message it carried is simply gone.
 *
 * The room id keeps the only timeout, so a screen that shows neither still fails as it did before
 * rather than hanging until the case deadline.
 */
export async function reachRoom(page, what) {
  const roomId = page.getByTestId("room-instance-id");
  const failure = page.getByTestId("home-error");
  const reported = await Promise.race([
    roomId.waitFor({ timeout: 60_000 }).then(() => null),
    failure.waitFor({ timeout: 60_000 }).then(
      () => failure.innerText(),
      // Never wins the race, and is not an unhandled rejection either: the room arrived first,
      // so this locator timing out afterwards means nothing.
      () => new Promise(() => {}),
    ),
  ]);
  if (reported) throw new Error(`${what}: ${reported}`);
  return roomId.innerText();
}

/**
 * The express server, the browser, and the contexts one case opens.
 *
 * Grouped into a factory rather than exported as loose functions because each suite runs its own
 * server on its own port, and the page helpers below all need that origin.
 */
export function createHarness({ port, mediaWaitMs = 30_000, browserArgs = [] } = {}) {
  const origin = `http://127.0.0.1:${port}`;
  let server;
  let browser;
  let shuttingDown = false;
  /**
   * Contexts opened by the running case, closed when it ends.
   *
   * Cases used to leave every browser context open until the whole file finished, so a participant
   * from the first case was still in its room during the last one. Closing a tab is a leave, so
   * they really were live sessions: by the end of a run the node was holding every participant the
   * suite had ever created, and cases began timing out in an order that varied run to run.
   */
  let openContexts = [];

  const harness = {
    origin,

    async start() {
      assert.ok(process.env["HELLAVE_API_KEY"], "HELLAVE_API_KEY must be set");
      assert.ok(
        existsSync(new URL("../dist/index.html", import.meta.url)),
        "dist/ is missing — run `npm run build` first",
      );

      server = spawn("npx", ["tsx", "server/index.ts"], {
        env: { ...process.env, PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      server.stderr.on("data", (chunk) => {
        stderr += chunk;
        // Printed as it arrives, not only if the server dies. It is quiet in an ordinary run, so what
        // does appear is worth seeing — a reattempted API call is how a run that passes says something
        // was briefly wrong, and holding it back would report an unqualified success instead.
        process.stderr.write(`[server] ${chunk}`);
      });
      server.once("exit", (code, signal) => {
        if (shuttingDown || code === 0 || code === null || code === 143 || signal) return;
        throw new Error(`playground server exited with ${code}: ${stderr}`);
      });

      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        try {
          await fetch(`${origin}/`);
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
          ...browserArgs,
        ],
      });
    },

    async stop() {
      if (browser) await browser.close().catch(() => {});
      if (server && server.exitCode === null) {
        shuttingDown = true;
        server.kill("SIGTERM");
        await Promise.race([
          once(server, "exit").catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]);
      }
    },

    /** Close what the finished case opened, so the next one starts against an empty node. */
    async closeOpenContexts() {
      const contexts = openContexts;
      openContexts = [];
      await Promise.all(contexts.map((context) => context.close().catch(() => {})));
    },

    async newPage(label, { grantMedia = true, viewport } = {}) {
      // grantMedia matters more than it looks. Chrome hides local addresses behind mDNS
      // `<uuid>.local` hostnames for any page that has not been granted camera or microphone
      // access, and granting it up front in every test is what hid a bug that broke every
      // first-time visitor on a fresh origin.
      const context = await browser.newContext({
        ...(grantMedia ? { permissions: ["microphone", "camera"] } : {}),
        ...(viewport ? { viewport, isMobile: true, hasTouch: true } : {}),
      });
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
    },

    /** Create a room and return its instance id. */
    async createRoom(page, name) {
      await page.goto(origin);
      await page.getByRole("button", { name: "Create a Room" }).click();
      await page.getByPlaceholder("Your name").fill(name);
      await page.getByRole("button", { name: /Create & Join|Creating/ }).click();
      return reachRoom(page, `${name} could not create a room`);
    },

    async joinRoom(page, roomInstanceId, name) {
      await page.goto(origin);
      await page.getByRole("button", { name: "Join a Room" }).click();
      await page.getByPlaceholder("Room Instance ID").fill(roomInstanceId);
      await page.getByPlaceholder("Your name").fill(name);
      await page.getByRole("button", { name: /^Join$|Joining/ }).click();
      await reachRoom(page, `${name} could not join ${roomInstanceId}`);
    },

    /** Turn on the camera and wait until it is actually sending, not merely toggled. */
    async startCamera(page, label) {
      const toggle = page.getByTestId("camera-toggle");
      await toggle.waitFor({ timeout: 60_000 });
      await toggle.click();
      try {
        await waitFor(
          () => outboundVideo(page),
          (t) => t.packetsSent > 0,
          mediaWaitMs,
          `${label} never sent camera RTP`,
        );
      } catch (error) {
        const sockets = JSON.stringify(await socketReport(page));
        throw new Error(
          `${error.message}\n${label} control sockets: ${sockets}\n${label} event log:\n${await appEvents(page)}`,
        );
      }
    },

    /**
     * How long a media capability lives on the stack under test.
     *
     * Signaling derives it as min(meeting_token_ttl - 1, 120), and the meeting token's own lifetime
     * is whatever that deployment configured — 60s locally, 300s in production. A test that must
     * outlive a capability therefore cannot hardcode the wait: it reads the token's expiry off a
     * freshly minted one and applies the same formula.
     */
    async capabilitySeconds(roomInstanceId) {
      const response = await fetch(`${origin}/api/token`, {
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
    },
  };

  return harness;
}
