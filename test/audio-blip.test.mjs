/**
 * How long does a listener actually lose audio when the SPEAKER's uplink blips?
 *
 * Production (VPS, 2026-09-21 16:00-18:00 UTC): 62 ICE Disconnected transitions across 6
 * rooms and ~40 participants, all clients behind Nigerian mobile NATs — "audio goes off
 * for a few seconds while they are speaking". The SFU-side mechanism is confirmed: while
 * a peer is in ICE Disconnected the SFU receives nothing from them, so listeners hear
 * silence for exactly the blip's duration; past the ICE consent timeout + 10s grace the
 * participant is reaped (ice_disconnected_timeout, measured ~32s end to end in
 * forced-reap.test.mjs) and recovery becomes a full rejoin.
 *
 * Two suites, matching the two incident findings:
 *
 * 1. Short blips (2s/5s/8s, media-only partition): the listener-perceived audio gap
 *    measured per-SSRC on the speaker's track (a listener-aggregated count never freezes
 *    — each listener also hears the other listener's mic), and whether packets resume
 *    promptly after the relay reopens or renegotiation stalls stretch the gap.
 * 2. A ~35s outage (media + signaling, the full forced-reap partition): reap at ~32s,
 *    then recovery — the renegotiation counters at reap time (the production
 *    "34 offers received / 1 answer applied" storm), how long audio takes to return,
 *    and whether the room comes back whole.
 *
 * ## Running it
 *
 *   HELLAVE_SFU_ADVERTISE_UDP_PORT=10100 scripts/local-stack.sh up
 *   npm run build
 *   node --env-file=.env.local --test --test-force-exit --test-reporter=spec test/audio-blip.test.mjs
 *
 * The relay partition mechanics and their two hard-won constraints (mDNS/no permissions,
 * port attribution by relay diff) are documented in udp-partition-relay.mjs and
 * forced-reap.test.mjs; this suite reuses them rather than re-deriving them.
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  appEvents,
  createHarness,
  inboundAudio,
  outboundAudio,
  waitFor,
} from "./harness.mjs";
import { createPartitionRelay } from "./udp-partition-relay.mjs";

const RELAY_PORT = Number(process.env["BLIP_RELAY_PORT"] ?? 10100);
const SFU_PORT = Number(process.env["BLIP_SFU_PORT"] ?? 10000);
const SFU_LOG =
  process.env["BLIP_SFU_LOG"] ?? "/Users/johnpaulokoye/make/maiaddy/VOD/Hellave/.local/run/sfu-node.log";

/** Sampling cadence for the per-SSRC listener audio series. */
const SAMPLE_MS = 250;
/** Polling cadence for the audio-resumed probes (waitFor polls at 1s; this is finer). */
const RESUME_POLL_MS = 250;

const harness = createHarness({ port: Number(process.env["BLIP_TEST_PORT"] ?? 3104), mediaWaitMs: 45_000 });
const relay = createPartitionRelay({ listenPort: RELAY_PORT, targetPort: SFU_PORT });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sfuLines() {
  try {
    return readFileSync(SFU_LOG, "utf8").split("\n");
  } catch {
    return [];
  }
}

const glareEvents = (lines) =>
  lines.filter(
    (l) =>
      l.includes("participant offer superseded") ||
      l.includes("no answer to the SFU offer"),
  );

const windowHas = (lines, needle) => lines.some((l) => l.includes(needle));

/**
 * Per-SSRC inbound audio counters for the page's peer connections. rtpTotals aggregates
 * every track — but each listener also hears the other listener's mic, so the aggregate
 * never freezes during one speaker's blip. The speaker's own inbound-rtp report is the
 * measurement surface: per-SSRC packet counts.
 */
async function audioPacketsBySsrc(page) {
  return page.evaluate(async () => {
    const bySsrc = {};
    for (const pc of window.__hellavePCs ?? []) {
      const stats = await pc.getStats();
      stats.forEach((report) => {
        if (report.type !== "inbound-rtp" || report.kind !== "audio") return;
        const key = report.ssrc ?? report.id;
        bySsrc[key] = (bySsrc[key] ?? 0) + (report.packetsReceived ?? 0);
      });
    }
    return bySsrc;
  });
}

function startSampler(listener) {
  const samples = [];
  const timer = setInterval(async () => {
    try {
      const bySsrc = await audioPacketsBySsrc(listener);
      samples.push({ at: Date.now(), bySsrc });
    } catch {
      // A page mid-recovery can fail a getStats; the next tick retries.
    }
  }, SAMPLE_MS);
  return { samples, timer };
}

/**
 * The ssrc whose packet count froze during [fromMs, toMs] — the speaker's flow. The
 * other listener's mic keeps flowing through the whole blip, so the frozen one is the
 * speaker's; if nothing froze, the partition never took effect.
 */
function frozenSsrc(samples, fromMs, toMs) {
  const window = samples.filter((s) => s.at >= fromMs && s.at <= toMs);
  if (window.length < 2) return null;
  const first = window[0].bySsrc;
  const last = window.at(-1).bySsrc;
  const frozen = Object.keys(first).filter(
    (ssrc) => (last[ssrc] ?? 0) === first[ssrc] && first[ssrc] > 0,
  );
  return frozen[0] ?? null;
}

/**
 * Wall-clock gap for one ssrc around a blackout: from the last sample showing a packet
 * advance before `fromMs` to the first sample showing an advance after it. Sampled at
 * SAMPLE_MS, so the number is quantized to that cadence. `null` = never resumed.
 */
function gapForSsrc(samples, fromMs, ssrc) {
  const before = samples.filter((s) => s.at < fromMs - SAMPLE_MS);
  const baseline = before.length ? (before.at(-1).bySsrc[ssrc] ?? 0) : 0;
  for (const sample of samples) {
    if (sample.at < fromMs - SAMPLE_MS) continue;
    if ((sample.bySsrc[ssrc] ?? 0) > baseline) return sample.at - fromMs;
  }
  return null;
}

/** Wait until the listener's total audio packet count advances, sampled finely. */
async function waitAudioResumed(listener, label) {
  const baseline = (await inboundAudio(listener)).packetsReceived;
  const started = Date.now();
  for (;;) {
    const now = (await inboundAudio(listener)).packetsReceived;
    if (now > baseline) return Date.now();
    assert.ok(Date.now() - started < 120_000, `${label}: listener audio never resumed`);
    await sleep(RESUME_POLL_MS);
  }
}

/** The three participants of every case, listeners first for port attribution. */
async function bringUpRoom(harness, relay) {
  const listeners = [];
  for (const name of ["listener-a", "listener-b"]) {
    listeners.push(await harness.newPage(name, { grantMedia: false }));
  }
  const speaker = await harness.newPage("speaker", { grantMedia: false });

  const roomInstanceId = await harness.createRoom(listeners[0], "listener-a");
  await harness.publishMic(listeners[0], "listener-a");
  await harness.joinRoom(listeners[1], roomInstanceId, "listener-b");
  await harness.publishMic(listeners[1], "listener-b");
  await sleep(3_000);

  const beforeSpeaker = relay.seen().map((c) => c.port);
  await harness.joinRoom(speaker, roomInstanceId, "speaker");
  await harness.publishMic(speaker, "speaker");
  await sleep(3_000);

  const afterSpeaker = relay.seen().map((c) => c.port);
  const speakerPorts = afterSpeaker.filter((p) => !beforeSpeaker.includes(p));
  assert.ok(speakerPorts.length > 0, "could not attribute the speaker's relay flow");
  const speakerPort = speakerPorts[0];
  assert.ok(
    relay.seen().find((c) => c.port === speakerPort)?.toSfu > 0,
    "the attributed speaker port carried no packets to the SFU",
  );

  assert.ok((await outboundAudio(speaker)).packetsSent > 0, "speaker is not sending audio");
  for (const [index, listener] of listeners.entries()) {
    await waitFor(
      () => inboundAudio(listener),
      (s) => s.packetsReceived > 0,
      45_000,
      `listener ${index} received no audio at all before the partition`,
    );
  }

  return { listeners, speaker, roomInstanceId, speakerPort };
}

describe("audio during a speaker uplink blip", () => {
  before(async () => {
    await relay.start();
    await harness.start();
  });
  afterEach(() => {
    relay.unblockAll();
    return harness.closeOpenContexts();
  });
  after(async () => {
    await harness.stop();
    await relay.stop();
  });

  it("a short blip silences the speaker for its duration and resumes without renegotiation churn", { timeout: 300_000 }, async () => {
    const { listeners, speaker, speakerPort } = await bringUpRoom(harness, relay);

    const sampler = startSampler(listeners[0]);
    const results = [];
    try {
      for (const blipMs of [2_000, 5_000, 8_000]) {
        const logMark = sfuLines().length;
        const startedAt = Date.now();
        relay.block(speakerPort);
        await sleep(blipMs);
        relay.unblock(speakerPort);
        const unblockedAt = Date.now();

        const resumedAt = await waitAudioResumed(listeners[0], "short blip");
        await sleep(3_000);

        const window = sfuLines().slice(logMark);
        const frozen = frozenSsrc(sampler.samples, startedAt, unblockedAt + 2_000);
        results.push({
          blipMs,
          listenerGapMs: frozen ? gapForSsrc(sampler.samples, startedAt, frozen) : null,
          frozenSsrc: frozen,
          resumeAfterUnblockMs: resumedAt - unblockedAt,
          iceDisconnected: windowHas(window, 'ice_state=Some("Disconnected")') || windowHas(window, "ice_state=Disconnected"),
          reaped: window.filter((l) => l.includes("removing disconnected participant")).length,
          sfuOffersPrepared: window.filter((l) => l.includes("prepared renegotiation offer")).length,
          glareEvents: glareEvents(sfuLines().slice(logMark)).length,
        });

        for (const [index, page] of [speaker, ...listeners].entries()) {
          const events = await appEvents(page);
          assert.ok(
            !/authorization_denied/i.test(events),
            `participant ${index} saw the blip classified as terminal:\n${events}`,
          );
        }
      }
    } finally {
      clearInterval(sampler.timer);
    }

    console.log("BLIP_RESULTS", JSON.stringify(results, null, 2));

    // The floor: every short blip recovered without a reap and without renegotiation
    // churn — the production symptom must be explainable by the network alone.
    for (const result of results) {
      assert.equal(result.reaped, 0, `a ${result.blipMs}ms blip must not reap the speaker`);
      assert.equal(
        result.sfuOffersPrepared,
        0,
        `a ${result.blipMs}ms blip must not trigger SFU renegotiation offers`,
      );
      assert.equal(
        result.glareEvents,
        0,
        `a ${result.blipMs}ms blip must not produce glare events`,
      );
    }
  });

  it("a partition past the reap threshold tears down and recovers via a rebind", { timeout: 420_000 }, async () => {
    // The full forced-reap choreography, instrumented for audio: watchers up first, the
    // allowlist taken before the speaker joins (so its ICE-restart ports stay dropped),
    // both media and signaling cut, reap at ~32s, then recovery.
    const watchers = [];
    for (const name of ["watcher-a", "watcher-b"]) {
      watchers.push(await harness.newPage(name, { grantMedia: false }));
    }
    const victim = await harness.newPage("victim", { grantMedia: false });

    const roomInstanceId = await harness.createRoom(watchers[0], "watcher-a");
    await harness.publishMic(watchers[0], "watcher-a");
    await harness.joinRoom(watchers[1], roomInstanceId, "watcher-b");
    await harness.publishMic(watchers[1], "watcher-b");
    await sleep(3_000);

    const watcherPorts = relay.seen().map((c) => c.port);
    assert.ok(watcherPorts.length > 0, "no media reached the relay");

    await harness.joinRoom(victim, roomInstanceId, "victim");
    await harness.publishMic(victim, "victim");
    await sleep(3_000);
    assert.ok((await outboundAudio(victim)).packetsSent > 0, "victim is not sending audio");
    for (const listener of watchers) {
      await waitFor(
        () => inboundAudio(listener),
        (s) => s.packetsReceived > 0,
        45_000,
        "a watcher heard nothing before the partition",
      );
    }

    const sampler = startSampler(watchers[0]);
    const logMark = sfuLines().length;
    const startedAt = Date.now();
    try {
      relay.allowOnly(watcherPorts);
      await victim.context().setOffline(true);
      await sleep(35_000);

      const reapLine =
        sfuLines()
          .slice(logMark)
          .find((l) => l.includes("removing disconnected participant")) ?? null;
      assert.ok(reapLine, "the partitioned speaker was never reaped within the window");
      assert.match(reapLine, /reason=ice_disconnected_timeout/);

      const counters = reapLine.match(
        /renegotiation_offers_sent=\d+ renegotiation_offers_received=\d+ renegotiation_answers_applied=\d+ control_offers_superseded=\d+/,
      )?.[0];
      console.log("REAP_COUNTERS", counters ?? "none-found");

      const frozen = frozenSsrc(sampler.samples, startedAt, Date.now());
      const gap = frozen ? gapForSsrc(sampler.samples, startedAt, frozen) : null;
      console.log("REAP_GAP", JSON.stringify({ listenerGapMs: gap, ssrc: frozen }));

      // ---- the network comes back ----
      await victim.context().setOffline(false);
      relay.allowAll();
      await waitAudioResumed(watchers[0], "after reap");
      const recoveredAtMs = Date.now() - startedAt;
      const renegotiationAfter = sfuLines()
        .slice(logMark)
        .filter((l) => l.includes("prepared renegotiation offer")).length;
      console.log("REAP_RECOVERY", JSON.stringify({
        totalMsFromPartitionStart: recoveredAtMs,
        renegotiationOffersAfterReap: renegotiationAfter,
      }));

      for (const listener of watchers) {
        const heard = await inboundAudio(listener);
        assert.ok(heard.packetsReceived > 0 && heard.tracks >= 2, "the room did not come back whole");
      }
    } finally {
      clearInterval(sampler.timer);
      relay.unblockAll();
    }
  });
});


