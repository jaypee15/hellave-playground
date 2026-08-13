/**
 * Browser load check: N fake-device participants all publishing audio + video (+ some screens),
 * raising hands and sending reactions, watched for freeze/disconnect/error.
 *
 * Every participant is a real SDK client through the real signaling path, so this exercises the
 * full stack. It fails on:
 *   - a participant stopping outbound audio or video (the freeze),
 *   - a participant dropping out of `admitted` (a disconnect/kickout),
 *   - a known negotiation error reaching the console ("must bind exactly one source",
 *     "media restart does not match an active publication"),
 *   - a participant receiving none of the room's media while others publish.
 *
 * Run against production (the default) or a local stack:
 *   HELLAVE_API_KEY=... npm run build && node --env-file=.env --test --test-force-exit \
 *     --test-reporter=spec test/load-check.test.mjs
 *
 * Size/duration are tunable: LOAD_PEERS (default 8), LOAD_SCREEN_SHARERS (default 2),
 * LOAD_SECS (default 20), LOAD_PORT (default 3095).
 */
import { after, afterEach, before, describe, it } from "node:test";
import {
  appEvents,
  createHarness,
  iceDiagnostics,
  inboundAudio,
  inboundVideo,
  outboundAudio,
  outboundVideo,
  waitFor,
} from "./harness.mjs";

const PORT = Number(process.env["LOAD_PORT"] ?? 3095);
const PEERS = Number(process.env["LOAD_PEERS"] ?? 8);
const SCREEN_SHARERS = Math.min(Number(process.env["LOAD_SCREEN_SHARERS"] ?? 2), PEERS);
const DURATION_SECS = Number(process.env["LOAD_SECS"] ?? 20);
const MEDIA_WAIT_MS = 30_000;
const STALL_MS = 4_000;

const KNOWN_ERRORS = [
  /publication must bind exactly one source/,
  /publication must add exactly one source/,
  /media restart does not match an active publication/,
  /Track kind does not match Sender kind/,
];

const harness = createHarness({
  port: PORT,
  mediaWaitMs: MEDIA_WAIT_MS,
  browserArgs: ["--auto-select-desktop-capture-source=Entire screen"],
});
const newPage = (...args) => harness.newPage(...args);
const createRoom = (...args) => harness.createRoom(...args);
const joinRoom = (...args) => harness.joinRoom(...args);
const startCamera = (...args) => harness.startCamera(...args);
const shareScreen = (...args) => harness.shareScreen(...args);

async function publishMic(page, label) {
  const publish = page.getByRole("button", { name: "Publish Mic" });
  await publish.waitFor({ timeout: 60_000 });
  await publish.click();
  try {
    await waitFor(
      () => outboundAudio(page),
      (t) => t.packetsSent > 0,
      MEDIA_WAIT_MS,
      `${label} never sent audio RTP`,
    );
  } catch (error) {
    const diag = await iceDiagnostics(page);
    throw new Error(
      `${error.message}\n  console: ${JSON.stringify(page.consoleErrors)}\n` +
        `  ICE: ${JSON.stringify(diag)}\n  events:\n${await appEvents(page)}`,
    );
  }
}

async function raiseHand(page, label) {
  const toggle = page.getByTestId("hand-toggle");
  await toggle.waitFor({ timeout: 30_000 });
  await toggle.click();
  await page.waitForTimeout(500);
  await toggle.click();
}

async function sendReaction(page, label) {
  await page.getByTestId("reactions-toggle").click();
  await page.getByRole("button", { name: "👍" }).click().catch(() => {});
}

describe("load check", () => {
  before(() => harness.start());

  afterEach(() => harness.closeOpenContexts());

  after(() => harness.stop());

  it(
    `${PEERS} participants keep audio+video flowing with no freeze, disconnect or error`,
    { timeout: DURATION_SECS * 1_000 + MEDIA_WAIT_MS + 120_000 },
    async () => {
      const pages = [];
      for (let index = 0; index < PEERS; index += 1) {
        pages.push(await newPage(`load-${index + 1}`));
      }
      const [host, ...rest] = pages;

      const roomInstanceId = await createRoom(host, "load-1");
      for (const [index, page] of rest.entries()) {
        await joinRoom(page, roomInstanceId, `load-${index + 2}`);
      }

      // Each participant turns on audio, video and (for a subset) screen as they arrive, so the
      // publishes are staggered the way a real room fills rather than a simultaneous burst.
      for (const [index, page] of pages.entries()) {
        await publishMic(page, `load-${index + 1}`);
        await startCamera(page, `load-${index + 1}`);
        if (index < SCREEN_SHARERS) {
          await shareScreen(page, `load-${index + 1}`);
        }
      }

      // Exercise the ephemeral control plane during the watch window.
      const deadline = Date.now() + DURATION_SECS * 1_000;
      const lastSent = new Map();
      let stalled = null;
      let consoleError = null;
      while (Date.now() < deadline && !stalled && !consoleError) {
        for (const [index, page] of pages.entries()) {
          const label = `load-${index + 1}`;
          const [audio, video] = await Promise.all([outboundAudio(page), outboundVideo(page)]);
          const key = label;
          const previous = lastSent.get(key) ?? { audio: 0, video: 0 };
          const advanced = audio.packetsSent > previous.audio || video.packetsSent > previous.video;
          lastSent.set(key, { audio: audio.packetsSent, video: video.packetsSent });
          if (!advanced) {
            stalled = { index, label, audio, video };
            break;
          }
          const known = page.consoleErrors.find((text) => KNOWN_ERRORS.some((re) => re.test(text)));
          if (known) {
            consoleError = { index, label, text: known };
            break;
          }
          // A dropped participant leaves the admitted state.
          const state = await page.getByTestId("conference-state").innerText().catch(() => "");
          if (!/admitted|connected/i.test(state)) {
            stalled = { index, label, audio, video, state };
            break;
          }
        }
        // Control-plane churn from a rotating participant.
        const churn = pages[(Date.now() / 1_000 | 0) % pages.length];
        if (Math.random() < 0.3) await sendReaction(churn, `load-${pages.indexOf(churn) + 1}`);
        if (Math.random() < 0.3) await raiseHand(churn, `load-${pages.indexOf(churn) + 1}`);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }

      if (consoleError) {
        const page = pages[consoleError.index];
        throw new Error(
          `${consoleError.label} surfaced a known negotiation error:\n  ${consoleError.text}\n` +
            `events:\n${await appEvents(page)}`,
        );
      }
      if (stalled) {
        const page = pages[stalled.index];
        const diag = await iceDiagnostics(page);
        throw new Error(
          `${stalled.label} stopped sending media${stalled.state ? ` (state=${stalled.state})` : ""}; ` +
            `audio ${JSON.stringify(stalled.audio)}; video ${JSON.stringify(stalled.video)}; ` +
            `ICE: ${JSON.stringify(diag)}; events:\n${await appEvents(page)}`,
        );
      }

      // Every participant must have received the room's media, not just sent its own.
      for (const [index, page] of pages.entries()) {
        const [audio, video] = await Promise.all([inboundAudio(page), inboundVideo(page)]);
        if (audio.packetsReceived === 0 && video.packetsReceived === 0) {
          throw new Error(
            `load-${index + 1} received no media from the room (freeze): ` +
              `audio ${JSON.stringify(audio)}; video ${JSON.stringify(video)}; ` +
              `events:\n${await appEvents(page)}`,
          );
        }
      }
    },
  );
});
