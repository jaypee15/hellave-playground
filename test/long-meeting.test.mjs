/**
 * A long, real-shaped meeting: seven people arrive staggered, everyone publishes
 * microphone and camera, and the meeting runs for five minutes with mid-meeting churn.
 *
 * This suite exists to watch, not merely to assert: every anomaly observed during the
 * window is recorded into a timeline and dumped with full per-page evidence at the end,
 * so a red result carries its own diagnosis. The incident classes it watches for are the
 * ones production has thrown: an outbound freeze, a dropped participant, a renegotiation
 * error, and a peer that stops hearing the room.
 *
 *   node --env-file=.env --test --test-force-exit --test-reporter=spec test/long-meeting.test.mjs
 *
 * Tunables: LONG_MEETING_PEERS (7), LONG_MEETING_SECS (300), LONG_MEETING_PORT (3099),
 * LONG_MEETING_CHURN_AT_SECS (150 — when the leave/join churn fires),
 * LONG_MEETING_JOIN_STAGGER_MS (6000).
 *
 * Ten cameras would fill the SFU node's video-publication cap exactly, so screen shares
 * are deliberately out of scope here.
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import {
  appEvents,
  createHarness,
  iceDiagnostics,
  inboundAudio,
  inboundVideo,
  outboundAudio,
  outboundVideo,
  socketReport,
  waitFor,
} from "./harness.mjs";

const PORT = Number(process.env["LONG_MEETING_PORT"] ?? 3099);
const PEERS = Number(process.env["LONG_MEETING_PEERS"] ?? 7);
const MEETING_SECS = Number(process.env["LONG_MEETING_SECS"] ?? 300);
const CHURN_AT_SECS = Number(process.env["LONG_MEETING_CHURN_AT_SECS"] ?? 150);
const JOIN_STAGGER_MS = Number(process.env["LONG_MEETING_JOIN_STAGGER_MS"] ?? 6_000);
const CHECK_INTERVAL_SECS = 30;
const MEDIA_WAIT_MS = 45_000;
/** The SFU's per-subscriber video budget (DEFAULT_MAX_VIDEO_CONSUMERS). */
const VIDEO_BUDGET = 4;

const KNOWN_ERRORS = [
  /publication must bind exactly one source/,
  /publication must add exactly one source/,
  /media restart does not match an active publication/,
  /Track kind does not match Sender kind/,
  /publication_cancelled/,
];

const harness = createHarness({ port: PORT, mediaWaitMs: MEDIA_WAIT_MS });

const label = (index) => `p${String(index + 1).padStart(2, "0")}`;

describe("long meeting", () => {
  before(() => harness.start());

  afterEach(() => harness.closeOpenContexts());

  after(() => harness.stop());

  it(
    `${PEERS} participants hold a ${Math.round(MEETING_SECS / 60)}-minute meeting with churn and stay healthy`,
    { timeout: (MEETING_SECS + 240) * 1_000 + 120_000 },
    async () => {
      const pages = [];
      for (let index = 0; index < PEERS; index += 1) {
        pages.push(await harness.newPage(label(index)));
      }
      const [host, ...rest] = pages;

      const roomInstanceId = await harness.createRoom(host, label(0));
      // People arrive one at a time, not as a burst.
      for (const [index, page] of rest.entries()) {
        await new Promise((resolve) => setTimeout(resolve, JOIN_STAGGER_MS));
        await harness.joinRoom(page, roomInstanceId, label(index + 1));
      }

      // Everyone publishes microphone then camera, arrival order.
      for (const [index, page] of pages.entries()) {
        const name = label(index);
        const publish = page.getByRole("button", { name: "Publish Mic" });
        await publish.waitFor({ timeout: 60_000 });
        await publish.click();
        await waitFor(
          () => outboundAudio(page),
          (t) => t.packetsSent > 0,
          MEDIA_WAIT_MS,
          `${name} never sent microphone RTP`,
        );
        await harness.startCamera(page, name);
      }
      const load = os.loadavg().map((value) => value.toFixed(1)).join(" ");
      process.stderr.write(
        `\n[long-meeting] everyone is publishing (load ${load}); starting the ${Math.round(MEETING_SECS / 60)}-minute window\n`,
      );

      const anomalies = [];
      const note = (text) => {
        const stamped = `[t+${Math.round((Date.now() - startedAt) / 1_000)}s] ${text}`;
        anomalies.push(stamped);
        process.stderr.write(`[long-meeting] ${stamped}\n`);
      };

      const audioFloorTimeline = [];
      const lastSent = new Map();
      const startedAt = Date.now();
      const churnAt = startedAt + CHURN_AT_SECS * 1_000;
      const churn = { done: false };
      /** Stable display name for a page, churn-aware (the late joiner replaces the leaver). */
      const nameOf = (index) => {
        if (!churn.done) return label(index);
        return index === pages.length - 1 ? "late-joiner" : label(index);
      };

      while (Date.now() - startedAt < MEETING_SECS * 1_000) {
        // Mid-meeting churn: one participant leaves via the real Leave button, one joins late.
        if (!churn.done && Date.now() >= churnAt) {
          const leaver = pages[pages.length - 1];
          const leaverName = label(pages.length - 1);
          process.stderr.write(`[long-meeting] ${leaverName} is leaving the meeting\n`);
          await leaver.getByRole("button", { name: /Leave/i }).click();
          pages.pop();
          process.stderr.write(`[long-meeting] ${leaverName} left; a late joiner arrives\n`);
          const late = await harness.newPage("late-joiner");
          await harness.joinRoom(late, roomInstanceId, "late-joiner");
          // A real late joiner turns on their mic and camera too — the whole point is to
          // watch the room re-converge around the newcomer.
          // A real late joiner turns on their mic and camera too — the whole point is to
          // watch the room re-converge around the newcomer.
          const latePublish = late.getByRole("button", { name: "Publish Mic" });
          await latePublish.waitFor({ timeout: 60_000 });
          await latePublish.click();
          await waitFor(
            () => outboundAudio(late),
            (t) => t.packetsSent > 0,
            MEDIA_WAIT_MS,
            "the late joiner never sent microphone RTP",
          );
          await harness.startCamera(late, "late-joiner");
          await harness.startCamera(late, "late-joiner");
          pages.push(late);
          churn.done = true;
          churn.settledAt = Date.now() + 60_000; // convergence grace before floor checks resume
        }
        const floorChecksActive = !churn.done || Date.now() >= churn.settledAt;

        // Health sampling across every live page.
        const active = pages.length;
        for (const [index, page] of pages.entries()) {
          const tag = nameOf(index);
          const [audio, video] = await Promise.all([outboundAudio(page), outboundVideo(page)]);
          const previous = lastSent.get(tag) ?? { audio: 0, video: 0 };
          const advanced = audio.packetsSent > previous.audio || video.packetsSent > previous.video;
          lastSent.set(tag, { audio: audio.packetsSent, video: video.packetsSent });

          const inbound = await inboundAudio(page);
          const videoIn = await inboundVideo(page);
          const state = await page.getByTestId("conference-state").innerText().catch(() => "gone");
          audioFloorTimeline.push({
            at: Math.round((Date.now() - startedAt) / 1000),
            peer: tag,
            tracks: inbound.tracks,
            expected: active - 1,
            packets: inbound.packetsReceived,
          });

          if (!advanced) {
            note(`${tag} stopped sending media (audio ${JSON.stringify(audio)}, video ${JSON.stringify(video)})`);
          }
          if (!/admitted|connected/i.test(state)) {
            note(`${tag} left the admitted state (state=${state})`);
          }
          if (floorChecksActive && inbound.tracks < active - 1) {
            note(`${tag} audio floor short: ${inbound.tracks}/${active - 1} tracks, ${inbound.packetsReceived} packets`);
          }
          if (inbound.tracks === 0 && inbound.packetsReceived === 0) {
            note(`${tag} receives no audio at all (total media loss)`);
          }
          const known = page.consoleErrors.find((text) => KNOWN_ERRORS.some((re) => re.test(text)));
          if (known) {
            note(`${tag} surfaced a negotiation/publication error: ${known}`);
          }
        }

        // Ephemeral control-plane churn from a rotating participant.
        const churnPage = pages[(Date.now() / 1_000 | 0) % pages.length];
        if (Math.random() < 0.4) {
          await churnPage.getByTestId("hand-toggle").click().catch(() => {});
          await churnPage.getByTestId("hand-toggle").click().catch(() => {});
        }
        if (Math.random() < 0.4) {
          await churnPage.getByTestId("reactions-toggle").click().catch(() => {});
          await churnPage.getByRole("button", { name: "thumbs_up" }).click().catch(() => {});
        }

        await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL_SECS * 1_000));
      }

      // Final audit: after churn settles, every live participant must hear the other actives.
      const active = pages.length;
      for (const [index, page] of pages.entries()) {
        const name = nameOf(index);
        await waitFor(
          () => inboundAudio(page),
          (t) => t.tracks >= active - 1 && t.packetsReceived > 0,
          MEDIA_WAIT_MS,
          `${name} did not hear the other ${active - 1} participants — last observed: ${JSON.stringify(await inboundAudio(page))}`,
        );
        const videoIn = await inboundVideo(page);
        assert.ok(videoIn.packetsReceived > 0, `${name} received no video: ${JSON.stringify(videoIn)}`);
      }

      // The timeline is the point of this suite: dump it even on a clean pass, and fail
      // with full per-page evidence if anything anomalous was observed during the window.
      process.stderr.write(`\n[long-meeting] audio floor timeline:\n${JSON.stringify(audioFloorTimeline)}\n`);
      if (anomalies.length > 0) {
        const evidence = [];
        for (const [index, page] of pages.entries()) {
          evidence.push(
            `\n===== ${nameOf(index)} =====\n` +
              `events:\n${await appEvents(page)}\nsockets: ${JSON.stringify(await socketReport(page))}\n` +
              `ICE: ${JSON.stringify(await iceDiagnostics(page))}\n`,
          );
        }
        throw new Error(
          `the long meeting observed ${anomalies.length} anomalies:\n  ${anomalies.join("\n  ")}\n${evidence.join("")}`,
        );
      }
    },
  );
});
