/**
 * Freeze repro: two publishers, both cameras on, one silently stops sending.
 *
 * Captured production symptom: a healthy participant publishes a camera, sends for a few seconds,
 * then its outbound RTP stops entirely while the transport stays up (STUN still flows, the peer is
 * still receiving the other participant's video), and only ~12s later does ICE go Disconnected and
 * the participant get reaped. On the SFU this appears as idle_inbound_media_ms climbing while
 * idle_input_ms stays small.
 *
 * This test watches each page's outbound video and fails the instant one stops growing, dumping the
 * browser-side evidence needed to pin the cause: iceConnectionState, sender/track state, and the
 * app's event log.
 *
 * Run against production so the deployed SFU is exercised:
 *   HELLAVE_API_KEY=... npm run build && node --env-file=.env --test --test-force-exit \
 *     --test-reporter=spec test/freeze-repro.test.mjs
 */
import { after, afterEach, before, describe, it } from "node:test";
import {
  appEvents,
  createHarness,
  iceDiagnostics,
  outboundVideo,
  sentOfferSummaries,
  waitFor,
} from "./harness.mjs";

const PORT = Number(process.env["FREEZE_PORT"] ?? 3096);
const MEDIA_WAIT_MS = Number(process.env["FREEZE_WAIT_MS"] ?? 30_000);
const WATCH_MS = Number(process.env["FREEZE_WATCH_MS"] ?? 45_000);
const STALL_MS = Number(process.env["FREEZE_STALL_MS"] ?? 6_000);

const harness = createHarness({ port: PORT, mediaWaitMs: MEDIA_WAIT_MS });
const newPage = (...args) => harness.newPage(...args);
const createRoom = (...args) => harness.createRoom(...args);
const joinRoom = (...args) => harness.joinRoom(...args);
const startCamera = (...args) => harness.startCamera(...args);

describe("freeze repro", () => {
  before(() => harness.start());

  afterEach(() => harness.closeOpenContexts());

  after(() => harness.stop());

  it(
    "keeps both cameras sending after the second video is published",
    { timeout: WATCH_MS + MEDIA_WAIT_MS + 60_000 },
    async () => {
      const first = await newPage("freeze-first");
      const second = await newPage("freeze-second");

      const roomInstanceId = await createRoom(first, "freeze-first");
      await joinRoom(second, roomInstanceId, "freeze-second");

      // Both publish simultaneously — the ordering the user reports: two videos appearing at
      // once, one offer racing the other's negotiation.
      const cameras = [
        startCamera(second, "freeze-second"),
        startCamera(first, "freeze-first"),
      ];
      await Promise.allSettled(cameras);

      // A camera offer the SFU rejected because it restated a not-yet-settled video m-line as a
      // publishing section is the leading freeze suspect; capture its SDP when it appears.
      const firstOffers = await sentOfferSummaries(first);
      const secondOffers = await sentOfferSummaries(second);
      const rejectedBySfu = first.consoleErrors
        .concat(second.consoleErrors)
        .find((text) => /publication must bind exactly one source/.test(text));
      if (rejectedBySfu) {
        throw new Error(
          `the SFU rejected a camera offer ("${rejectedBySfu}")\n` +
            `  first offers: ${JSON.stringify(firstOffers, null, 2)}\n` +
            `  second offers: ${JSON.stringify(secondOffers, null, 2)}`,
        );
      }

      for (const [page, label] of [
        [first, "first"],
        [second, "second"],
      ]) {
        await waitFor(
          () => outboundVideo(page),
          (t) => t.packetsSent > 0,
          MEDIA_WAIT_MS,
          `${label} never sent camera video`,
        );
      }

      // Watch both senders; a sender that stalls is the freeze. Sample the raw numbers so the
      // failure message can show the last observed progress.
      const last = new Map();
      let stalled;
      const deadline = Date.now() + WATCH_MS;
      while (Date.now() < deadline && !stalled) {
        for (const [page, label] of [
          [first, "first"],
          [second, "second"],
        ]) {
          const totals = await outboundVideo(page);
          const previous = last.get(label) ?? { packetsSent: 0, bytesSent: 0 };
          const advanced = totals.packetsSent > previous.packetsSent
            || totals.bytesSent > previous.bytesSent;
          last.set(label, { packetsSent: totals.packetsSent, bytesSent: totals.bytesSent });
          if (last.has(label) && !advanced) {
            const stalledFor = stalled ? stalled.for : 0;
            if (stalledFor >= STALL_MS) {
              stalled = { label, for: stalledFor, totals };
            } else {
              stalled = { label, for: stalledFor + 1_000, totals };
            }
          } else {
            stalled = undefined;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }

      if (stalled) {
        const [page, label] = stalled.label === "first"
          ? [first, "first"]
          : [second, "second"];
        const diag = await iceDiagnostics(page);
        const events = await appEvents(page);
        const offers = await sentOfferSummaries(page);
        throw new Error(
          `${label} stopped sending camera video for ${stalled.for / 1_000}s; ` +
            `last totals ${JSON.stringify(stalled.totals)}; ` +
            `ICE: ${JSON.stringify(diag)}; ` +
            `offers: ${JSON.stringify(offers, null, 2)}; ` +
            `events:\n${events}`,
        );
      }
    },
  );
});
