/**
 * Capture the camera offer SDP that the SFU rejects with
 * "publication must bind exactly one source of its declared kind".
 *
 * The publisher publishes its camera while already receiving the other participant's video, so
 * the offer restates the existing recvonly video m-line alongside the new sendonly camera m-line.
 * The SFU's validate_publication_binding demands exactly one video publishing section; if the
 * restated m-line is not recvonly this rejects, and the SDK then has a camera it believes is
 * publishing while the SFU never bound it — the shape of the reported freeze.
 *
 *   HELLAVE_API_KEY=... npm run build && node --env-file=.env --test --test-force-exit \
 *     --test-reporter=spec test/camera-offer.test.mjs
 */
import { after, afterEach, before, describe, it } from "node:test";
import { createHarness, outboundVideo, waitFor } from "./harness.mjs";

const PORT = Number(process.env["CAMERA_OFFER_PORT"] ?? 3097);
const MEDIA_WAIT_MS = Number(process.env["CAMERA_OFFER_WAIT_MS"] ?? 30_000);

const harness = createHarness({ port: PORT, mediaWaitMs: MEDIA_WAIT_MS });
const newPage = (...args) => harness.newPage(...args);
const createRoom = (...args) => harness.createRoom(...args);
const joinRoom = (...args) => harness.joinRoom(...args);
const startCamera = (...args) => harness.startCamera(...args);

async function transceiverReport(page) {
  return page.evaluate(() => {
    const pc = (window.__hellavePCs ?? [])[0];
    if (!pc) return null;
    return pc.getTransceivers().map((t, index) => ({
      index,
      kind: t.receiver?.track?.kind ?? null,
      direction: t.direction,
      currentDirection: t.currentDirection,
      hasSenderTrack: Boolean(t.sender?.track),
      senderKind: t.sender?.track?.kind ?? null,
    }));
  });
}

async function mediaOfferSdps(page) {
  return page.evaluate(() => {
    const out = [];
    for (const ws of window.__hellaveSockets ?? []) {
      for (const message of ws.transcript ?? []) {
        if (message.startsWith(">media_offer")) {
          out.push("(type only; SDP not recorded)");
        }
      }
    }
    return out;
  });
}

describe("camera offer while receiving video", () => {
  before(() => harness.start());

  afterEach(() => harness.closeOpenContexts());

  after(() => harness.stop());

  it(
    "publishes a camera without a stray publishing section",
    { timeout: MEDIA_WAIT_MS * 2 + 60_000 },
    async () => {
      const first = await newPage("offer-first");
      const second = await newPage("offer-second");

      const roomInstanceId = await createRoom(first, "offer-first");
      await joinRoom(second, roomInstanceId, "offer-second");

      // Second publishes first, so first is receiving live inbound video when it publishes.
      await startCamera(second, "offer-second");
      await waitFor(
        () => outboundVideo(second),
        (t) => t.packetsSent > 0,
        MEDIA_WAIT_MS,
        "second never sent camera video",
      );

      // Give first a moment to have the inbound video negotiated.
      await first.waitForTimeout(2_000);

      const before = await transceiverReport(first);
      process.stderr.write(`\n[offer-first] transceivers before camera publish:\n${JSON.stringify(before, null, 2)}\n`);

      // First publishes its camera while receiving.
      try {
        await startCamera(first, "offer-first");
        process.stderr.write("[offer-first] camera published\n");
      } catch (error) {
        const report = await transceiverReport(first);
        const diag = first.consoleErrors;
        throw new Error(
          `first could not publish camera while receiving video\n` +
            `  error: ${error.message}\n` +
            `  transceivers: ${JSON.stringify(report, null, 2)}\n` +
            `  console: ${JSON.stringify(diag, null, 2)}`,
        );
      }

      const after = await transceiverReport(first);
      process.stderr.write(`[offer-first] transceivers after camera publish:\n${JSON.stringify(after, null, 2)}\n`);

      // The SFU bound the camera: first is actually sending video.
      await waitFor(
        () => outboundVideo(first),
        (t) => t.packetsSent > 0,
        MEDIA_WAIT_MS,
        "first never sent camera video",
      );
    },
  );
});
