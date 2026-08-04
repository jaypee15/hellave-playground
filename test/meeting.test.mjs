/**
 * A meeting the size of a real one: ten people, ten cameras, and somebody sharing their screen.
 *
 * audio.test.mjs never exceeds three participants or three video publications, which is below every
 * limit a real room crosses. The SFU bounds how much video any one subscriber receives — four by
 * default — so a room of ten is the first place where what you see is chosen for you, and where
 * "why can nobody see my screen" becomes a question the suite can answer.
 *
 *   npm run test:meeting        # the local stack
 *   npm run test:meeting:prod   # the deployment
 *
 * MEETING_PEOPLE scales the room down, because ten Chromium contexts publishing video is a real
 * load on the machine running them, and a saturated machine looks exactly like a media bug. Every
 * case records the load average around itself so that can be told apart afterwards.
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appEvents,
  createHarness,
  decodingVideo,
  inboundAudio,
  inboundVideo,
  outboundVideo,
  receivedScreens,
  receivedVideo,
  socketReport,
  waitFor,
} from "./harness.mjs";

const PORT = Number(process.env["MEETING_PORT"] ?? 3096);
const PEOPLE = Number(process.env["MEETING_PEOPLE"] ?? 10);
/**
 * Ninety seconds, not the media suite's thirty.
 *
 * A ten-person room adds its consumers over a run of renegotiations — the SFU reconciles up to
 * thirteen per participant, nine audio and four video — and against a real deployment under load that
 * ramp took longer than forty-five seconds to finish. It is a floor being waited for, not a timeout
 * being papered over: the room does get there.
 */
const MEDIA_WAIT_MS = Number(process.env["MEETING_WAIT_MS"] ?? 90_000);
/** Long: ten browsers have to join, publish, and negotiate before anything is asserted. */
const CASE_TIMEOUT = { timeout: 420_000 };

/**
 * The SFU's default per-subscriber video budget.
 *
 * `DEFAULT_MAX_VIDEO_CONSUMERS` in the SFU, and the playground never raises it — it does not call
 * setSubscriptionPolicy at all. So in a room of ten this is how much video anyone gets, and the
 * assertions below are written against the cap rather than against "everyone sees everyone", which
 * would be asserting a product this is not.
 */
const VIDEO_BUDGET = Number(process.env["MEETING_VIDEO_BUDGET"] ?? 4);

const harness = createHarness({
  port: PORT,
  mediaWaitMs: MEDIA_WAIT_MS,
  browserArgs: ["--auto-select-desktop-capture-source=Entire screen"],
});

const label = (index) => `p${String(index + 1).padStart(2, "0")}`;

/**
 * The state of every inbound video track on the page.
 *
 * A remote track is `muted` until its first frame arrives and again whenever forwarding pauses, and
 * the app renders a tile's video element only while it believes the track is live. So "the tile is
 * blank" has three quite different causes — nothing was sent, something was sent and the track is
 * muted, or the track is live and the element never got it — and only this tells them apart.
 */
async function videoReceivers(page) {
  return page.evaluate(() => {
    const out = [];
    for (const pc of window.__hellavePCs ?? []) {
      for (const receiver of pc.getReceivers()) {
        if (receiver.track?.kind !== "video") continue;
        out.push(`${receiver.track.readyState}${receiver.track.muted ? "/muted" : ""}`);
      }
    }
    return out;
  });
}

/** Load average, recorded around each case so a saturated machine can be told from a bug. */
function loadAverage() {
  try {
    return execFileSync("sysctl", ["-n", "vm.loadavg"], { encoding: "utf8" }).trim();
  } catch {
    return "(unavailable)";
  }
}

/**
 * Build a meeting: everyone in one room, everyone on a microphone, `cameras` of them on camera,
 * and optionally the first of them sharing their screen on top of their own camera.
 *
 * Microphones go up simultaneously because that is both realistic and the case the SFU's glare
 * handling exists for. Cameras go up one at a time on purpose: nine simultaneous video
 * renegotiations are a separate thing to test, and mixing it in here would make a red result
 * ambiguous between the budget and the negotiation.
 */
async function openMeeting({ people = PEOPLE, cameras = PEOPLE, screen = false } = {}) {
  const pages = [];
  for (let index = 0; index < people; index += 1) {
    pages.push(await harness.newPage(label(index)));
  }

  const roomInstanceId = await harness.createRoom(pages[0], label(0));
  for (let index = 1; index < people; index += 1) {
    await harness.joinRoom(pages[index], roomInstanceId, label(index));
  }

  await Promise.all(pages.map((page, index) => harness.publishMic(page, label(index))));
  for (let index = 0; index < cameras; index += 1) {
    await harness.startCamera(pages[index], label(index));
  }
  if (screen) await harness.shareScreen(pages[0], label(0));

  return { pages, roomInstanceId, videoPublications: cameras + (screen ? 1 : 0) };
}

/** Everyone must hear everyone: audio is not bounded, so this is a hard floor. */
async function assertAudioFloor(pages) {
  for (const [index, page] of pages.entries()) {
    const heard = await waitFor(
      () => inboundAudio(page),
      (t) => t.tracks >= pages.length - 1 && t.packetsReceived > 0,
      MEDIA_WAIT_MS,
      `${label(index)} did not hear the other ${pages.length - 1} participants`,
    );
    assert.ok(
      heard.tracks >= pages.length - 1,
      `${label(index)} heard ${heard.tracks} of ${pages.length - 1}: ${JSON.stringify(heard)}`,
    );
  }
}

/** Video each page should receive: the budget, or everything available if that is less. */
function expectedVideo(pages, videoPublications, ownPublications) {
  return Math.min(VIDEO_BUDGET, videoPublications - ownPublications);
}

describe(`a meeting of ${PEOPLE}`, () => {
  before(() => harness.start());
  afterEach(() => harness.closeOpenContexts());
  after(() => harness.stop());

  /**
   * The reported bug: a screen share looks like it is working and nobody else can see it.
   *
   * Two separate failures produce that, and this case distinguishes them. `received-video` is the
   * app's list of publications it actually holds a track for, so a screen share missing from it was
   * never delivered by the SFU; a screen share present in it but with no tile was delivered and not
   * rendered. Asserting only "I can see a screen tile" would conflate the two.
   */
  it("carries a screen share to everyone in a full meeting", CASE_TIMEOUT, async () => {
    process.stderr.write(`[load] before: ${loadAverage()}\n`);
    const { pages, videoPublications } = await openMeeting({ screen: true });
    const [sharer, ...viewers] = pages;

    // The sharer is sending two videos: its camera and its screen.
    const sent = await outboundVideo(sharer);
    assert.ok(
      sent.tracks >= 2,
      `the sharer should send a camera and a screen, sent ${JSON.stringify(sent)}`,
    );
    assert.equal(
      videoPublications,
      PEOPLE + 1,
      "ten cameras and one screen share is what this case is about",
    );

    await assertAudioFloor(pages);

    const missing = [];
    for (const [offset, viewer] of viewers.entries()) {
      const index = offset + 1;
      const screens = await waitFor(
        () => receivedScreens(viewer),
        (found) => found.length > 0,
        MEDIA_WAIT_MS,
        `${label(index)} never received the screen share`,
      ).catch(async () => {
        missing.push(`${label(index)} received ${JSON.stringify(await receivedVideo(viewer))}`);
        return [];
      });
      if (screens.length === 0) continue;

      // Delivered — now is it on screen? A tile of its own, carrying decoded frames rather than a
      // negotiated track that never painted.
      //
      // Re-read on every poll rather than held: the tile renders a video element only while it
      // considers the track live, and a remote track goes `mute` whenever forwarding pauses, so
      // React swaps the element out and back. A handle taken once keeps reporting readyState 0
      // from an element that has already been detached.
      const tile = viewer.getByTestId(`tile-screen-${screens[0]}`);
      await tile.waitFor({ timeout: 30_000 });
      const painted = await waitFor(
        async () => ({
          ...await tile
            .locator("video")
            .evaluate((video) => ({
              readyState: video.readyState,
              width: video.videoWidth,
              hasSrc: Boolean(video.srcObject),
              // Reported, and deliberately not nudged with play(): a tile that has the stream and
              // stays paused is the app failing to start playback, which is what a person sees as a
              // blank tile. Calling play() here would have hidden exactly that.
              paused: video.paused,
            }))
            // -1 means the tile is showing its avatar instead, so the app does not consider the
            // track live — a different failure from an element that has one and paints nothing.
            .catch(() => ({ readyState: -1, width: 0, hasSrc: false, paused: null })),
          receivers: await videoReceivers(viewer),
        }),
        (frame) => frame.width > 0,
        MEDIA_WAIT_MS,
        `${label(index)}'s screen tile never painted a frame`,
      );
      assert.ok(
        painted.width > 0,
        `${label(index)} has a screen tile with no frames: ${JSON.stringify(painted)}`,
      );
    }

    process.stderr.write(`[load] after: ${loadAverage()}\n`);
    assert.deepEqual(
      missing,
      [],
      `every viewer must receive the screen share; ${missing.length} of ${viewers.length} did not`,
    );

    // The cap is the cap: each viewer holds the budget, not all eleven publications. Asserted after
    // the screen share so a failure here is about the budget rather than about the share.
    //
    // The budget is a ceiling, and that is what gets asserted. Filling it is a matter of the network:
    // ten publishers and forty inbound streams on one machine is enough to lose packets, and the SFU
    // then drops layers and pauses consumers exactly as it should — 216 subscriber downgrades with
    // loss_recovery_active=true in one production run. Demanding exactly the budget would be
    // asserting an ideal network, and would go red for a reason that is not a defect.
    //
    // What must hold is that nobody exceeds the cap, everybody is watching something, and the screen
    // share is among it — the last of those asserted per viewer above, which is stronger than a
    // count. The fill is reported so a quality regression is still visible.
    //
    // Measured as frames still arriving, not as tracks held or m-lines negotiated: both of those
    // overcount, because a page keeps spent m-lines and the app keeps a publication until its track
    // ends, which an unsubscribed track never does.
    const budget = expectedVideo(pages, videoPublications, 1);
    const fill = [];
    for (const [offset, viewer] of viewers.entries()) {
      const index = offset + 1;
      const watching = await waitFor(
        () => decodingVideo(viewer),
        (found) => found.tracks > 0,
        MEDIA_WAIT_MS,
        `${label(index)} is watching no video at all`,
      );
      assert.ok(
        watching.tracks <= budget,
        `${label(index)} is watching ${watching.tracks} videos, past the budget of ${budget}: ${
          JSON.stringify(await receivedVideo(viewer))
        }`,
      );
      fill.push(`${label(index)}:${watching.tracks}/${budget}`);
    }
    process.stderr.write(`[video budget] ${fill.join(" ")}\n`);

    for (const [index, page] of pages.entries()) {
      const events = await appEvents(page);
      assert.ok(
        !/control_error|Hellave error/i.test(events),
        `${label(index)} reported a control error:\n${events}`,
      );
      const closed = (await socketReport(page)).map((s) => s.closed).filter(Boolean);
      assert.deepEqual(
        closed.filter((c) => c.code !== 1000 && c.code !== 1005),
        [],
        `${label(index)} had a control socket close unexpectedly: ${JSON.stringify(closed)}`,
      );
    }
  });
});
