/**
 * Mute-resume: a publisher that stops its mic for a while, then talks again,
 * must be heard — the Oct 12 "mic-off, unmute, silence" shape.
 *
 * Stop (not Local Mute) ends the track and RTP, tripping the SFU's 15s
 * publisher-stall path; republish must re-open the track and resume
 * forwarding without a rejoin. MUTE_WAIT_MS sits past the stall notice so a
 * stuck consumer or a lost re-offer shows up as silence here.
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createHarness,
  inboundAudio,
  outboundAudio,
  waitFor,
} from "./harness.mjs";

const PORT = Number(process.env["MUTE_RESUME_PORT"] ?? 3108);
const MEDIA_WAIT_MS = Number(process.env["AUDIO_WAIT_MS"] ?? 30_000);
const MUTE_WAIT_MS = Number(process.env["MUTE_WAIT_MS"] ?? 35_000);
const CASE_TIMEOUT = { timeout: 300_000 };

const harness = createHarness({ port: PORT, mediaWaitMs: MEDIA_WAIT_MS });
const newPage = (...args) => harness.newPage(...args);
const createRoom = (...args) => harness.createRoom(...args);
const joinRoom = (...args) => harness.joinRoom(...args);

describe("mute then talk again", () => {
  before(() => harness.start());
  after(() => harness.stop());
  afterEach(() => harness.closeOpenContexts());

  it("a listener hears the host again after a long mic stop", CASE_TIMEOUT, async () => {
    const host = await newPage("mute-host");
    const listener = await newPage("mute-listener");

    const roomInstanceId = await createRoom(host, "mute-host");
    await joinRoom(listener, roomInstanceId, "mute-listener");

    const publish = host.getByRole("button", { name: "Publish Mic" });
    await publish.waitFor({ timeout: 60_000 });
    await publish.click();
    await waitFor(
      () => outboundAudio(host),
      (t) => t.packetsSent > 0,
      MEDIA_WAIT_MS,
      "host never sent audio RTP",
    );
    const firstHeard = await waitFor(
      () => inboundAudio(listener),
      (t) => t.packetsReceived > 0,
      MEDIA_WAIT_MS,
      "listener never heard the host before the mute",
    );

    // Full stop: track ends, RTP stops — the MaiMail mute shape, not Local Mute.
    const stop = host.getByRole("button", { name: "Stop Mic" });
    await stop.waitFor({ timeout: 60_000 });
    await stop.click();
    await host
      .getByRole("button", { name: "Publish Mic" })
      .waitFor({ timeout: 60_000 });
    // Past the 15s publisher-stall notice: any stuck consumer or wedged
    // publication is now the steady state, not a race.
    await host.waitForTimeout(MUTE_WAIT_MS);

    // Talk again: republish on the same session, no rejoin.
    const republish = host.getByRole("button", { name: "Publish Mic" });
    await republish.click();
    await waitFor(
      () => outboundAudio(host),
      (t) => t.packetsSent > 0,
      MEDIA_WAIT_MS,
      "host sent no audio RTP after republishing",
    );
    const heardAgain = await waitFor(
      () => inboundAudio(listener),
      (t) => t.packetsReceived > firstHeard.packetsReceived,
      MEDIA_WAIT_MS,
      "listener heard nothing after the host unmuted",
    );
    assert.ok(
      heardAgain.bytesReceived > firstHeard.bytesReceived,
      "listener received no new audio after unmute",
    );

    // The precise regression: a re-described inbound track must resume, never
    // die on a stale-transaction conflict.
    for (const [page, label] of [
      [host, "host"],
      [listener, "listener"],
    ]) {
      const errors = page.consoleErrors.join(" | ");
      assert.ok(
        !/unknown media transaction/i.test(errors),
        `${label} hit a stale media transaction on resume: ${errors}`,
      );
    }
  });
});
