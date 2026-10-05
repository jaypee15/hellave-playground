/**
 * Talk-start latency and poor-network smoothness, measured the way ears hear it.
 *
 * Two questions production keeps asking, answered against a local stack with real
 * Chromium pages:
 *
 *   1. When a person starts publishing and speaks, how long until another participant
 *      actually hears them — first RTP on the wire AND an audible signal in the graph?
 *   2. How smooth does that audio stay when the speaker's network degrades?
 *
 * Seams, agreed up front: the browser UI/SDK events, browser WebRTC stats plus an
 * audible-signal check, SFU evidence for diagnosis only, and local userspace network
 * shaping in the UDP relay. Packet counters alone never prove audibility, so every
 * talk-start verdict requires cumulative audio energy (which only advances while the
 * flow carries signal), and every smoothness window reports gap statistics, loss share,
 * and concealment share rather than a single pass/fail count.
 *
 * Deliberately not mute/unmute: app mute calls `publication.setLocalMuted()`, which the
 * SDK implements as `track.enabled = false` — RTP keeps flowing. Talk-start here means
 * publication start and republish only, where RTP genuinely begins.
 *
 *   npm run build
 *   node --env-file=.env.local --test --test-force-exit --test-reporter=spec test/talk-start.test.mjs
 *
 * The stack must advertise the relay's port so all media flows through it
 * (HELLAVE_SFU_ADVERTISE_UDP_PORT=10100 scripts/local-stack.sh up), and pages open
 * without granted media permissions so host candidates stay behind mDNS and no direct
 * pair bypasses the relay. The relay runs transparently (allow-all, no profile) unless
 * a case shapes a flow, so the baseline measures the same path the shaped runs take.
 *
 * Tunables (all ms unless noted): TALK_START_PORT (3105), TALK_START_RELAY_PORT (10100),
 * TALK_START_SFU_PORT (10000), TALK_START_WAIT_MS (45000), TALK_START_TRIALS (3),
 * TALK_START_MS (8000, talk-start bound after click; local p95 measures ~1.4-2.4s),
 * FLAP_RESUME_MS (8000; a 2s flap resumes in ~1s, a reap-scale stall would take ~30s),
 * SMOOTH_WINDOW_MS (20000), SMOOTH_MAX_GAP_MS (2000; sampler granularity floors real
 * gaps near 500ms), SMOOTH_MAX_GAPS_OVER_500MS (12; noisy by nature, catches
 * systematic breakdown), SMOOTH_MAX_LOSS_PCT (25; Opus FEC normally holds this at 0,
 * so this is a catastrophic tripwire, not a tuning target), SMOOTH_MAX_CONCEAL_PCT
 * (35; the discriminating metric — clean runs ~0%, shaped runs ~22-26%). Thresholds
 * were calibrated against local runs (see the SMOOTH_RESULTS dumps); tighten them only
 * from new measurements, never to make a red run green.
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createHarness,
  iceDiagnostics,
  inboundAudio,
  outboundAudio,
  socketReport,
  waitFor,
} from "./harness.mjs";
import { createPartitionRelay } from "./udp-partition-relay.mjs";

const PORT = Number(process.env["TALK_START_PORT"] ?? 3105);
const RELAY_PORT = Number(process.env["TALK_START_RELAY_PORT"] ?? 10100);
const SFU_PORT = Number(process.env["TALK_START_SFU_PORT"] ?? 10000);
const MEDIA_WAIT_MS = Number(process.env["TALK_START_WAIT_MS"] ?? 45_000);
const TRIALS = Number(process.env["TALK_START_TRIALS"] ?? 3);
const CASE_TIMEOUT = { timeout: 300_000 };
const TALK_START_MS = Number(process.env["TALK_START_MS"] ?? 8_000);
const FLAP_RESUME_MS = Number(process.env["FLAP_RESUME_MS"] ?? 8_000);
const SMOOTH_WINDOW_MS = Number(process.env["SMOOTH_WINDOW_MS"] ?? 20_000);
const SMOOTH_MAX_GAP_MS = Number(process.env["SMOOTH_MAX_GAP_MS"] ?? 2_000);
const SMOOTH_MAX_GAPS_OVER_500MS = Number(process.env["SMOOTH_MAX_GAPS_OVER_500MS"] ?? 12);
const SMOOTH_MAX_LOSS_PCT = Number(process.env["SMOOTH_MAX_LOSS_PCT"] ?? 25);
const SMOOTH_MAX_CONCEAL_PCT = Number(process.env["SMOOTH_MAX_CONCEAL_PCT"] ?? 35);
/** Polling cadence for audio sampling and the audible-signal gate. */
const SAMPLE_MS = 250;
// Audible-signal floor for the fake-device tone through the listener's graph. The tone
// is quiet (measured ~0.03 peak RMS locally and remotely); 0.005 sits an order of
// magnitude below it and an order above the true-silence floor.
const AUDIBLE_RMS = Number(process.env["TALK_START_RMS"] ?? 0.005);
const SFU_LOG =
  process.env["TALK_START_SFU_LOG"] ?? "/Users/johnpaulokoye/make/maiaddy/VOD/Hellave/.local/run/sfu-node.log";

const harness = createHarness({ port: PORT, mediaWaitMs: MEDIA_WAIT_MS });
const relay = createPartitionRelay({ listenPort: RELAY_PORT, targetPort: SFU_PORT });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** SFU lines appended since `mark`: renegotiation/drop evidence, diagnosis only. */
function sfuWindow(mark) {
  let lines = [];
  try {
    lines = readFileSync(SFU_LOG, "utf8").split("\n").slice(mark);
  } catch {
    return { dropping: 0, offers: 0, available: false };
  }
  return {
    dropping: lines.filter((l) => l.includes("dropping media for a subscribed consumer")).length,
    offers: lines.filter((l) => l.includes("prepared renegotiation offer")).length,
    available: true,
  };
}

function sfuMark() {
  try {
    return readFileSync(SFU_LOG, "utf8").split("\n").length;
  } catch {
    return 0;
  }
}

/**
 * Peak Web Audio RMS out of the listener's live remote audio track.
 *
 * Stats-level audio energy stays zero for this content in current Chromium even while
 * the graph carries signal (measured 0.03 peak against 0 energy), so the audible proof
 * has to come from the graph itself. The analyser must reach the destination — Web
 * Audio is pull-based and a dangling analyser reports zeros however loud its input —
 * and the track must be live, unmuted, and carrying RTP, which rules out recvonly
 * slots the SFU has not bound yet. Returns 0 when no such track exists yet.
 */
async function audiblePeak(page, measureMs = 1500) {
  return page.evaluate(async (budgetMs) => {
    let track = null;
    for (const pc of window.__hellavePCs ?? []) {
      for (const receiver of pc.getReceivers()) {
        if (receiver.track?.kind !== "audio") continue;
        if (receiver.track.readyState !== "live" || receiver.track.muted) continue;
        if ((receiver.getSynchronizationSources?.() ?? []).length === 0) continue;
        track = receiver.track;
        break;
      }
      if (track) break;
    }
    if (!track) return 0;
    const context = new AudioContext();
    if (context.state === "suspended") {
      await context.resume().catch(() => {});
    }
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    const silent = context.createGain();
    silent.gain.value = 0;
    source.connect(analyser);
    analyser.connect(silent);
    silent.connect(context.destination);
    const samples = new Float32Array(analyser.fftSize);
    let peak = 0;
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const value of samples) sum += value * value;
      peak = Math.max(peak, Math.sqrt(sum / samples.length));
      if (peak > 0.005) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    source.disconnect();
    silent.disconnect();
    await context.close().catch(() => {});
    return peak;
  }, measureMs);
}

/**
 * Milliseconds from now until the listener's graph carries measurable signal.
 * Early-exits on the first audible read; the budget is a cap, not a fixed cost.
 */
async function firstAudibleAt(page, timeoutMs, label) {
  const started = Date.now();
  for (;;) {
    const peak = await audiblePeak(page, 1500).catch(() => 0);
    if (peak > AUDIBLE_RMS) return Date.now() - started;
    assert.ok(
      Date.now() - started < timeoutMs,
      `${label}: listener audio never became audible (peak still ${peak})`,
    );
    await sleep(SAMPLE_MS);
  }
}

/** Click Publish Mic and return the click instant; the caller waits for the results. */
async function clickPublishMic(page, label) {
  const button = page.getByRole("button", { name: "Publish Mic" });
  await button.waitFor({ timeout: 60_000 });
  const clickedAt = Date.now();
  await button.click();
  return clickedAt;
}

/**
 * One talk-start trial: a fresh speaker joins an already-listening room, publishes, and
 * the listener's first RTP arrival and first audible signal are both timed from the
 * click. The trial closes the speaker page when done.
 */
async function talkStartTrial(listener, roomInstanceId, trial, label) {
  const speaker = await harness.newPage(`talk-speaker-${trial}`, { grantMedia: false });
  await harness.joinRoom(speaker, roomInstanceId, `talk-speaker-${trial}`);
  const baseline = (await inboundAudio(listener)).packetsReceived;
  const clickedAt = await clickPublishMic(speaker, label);
  await waitFor(
    () => outboundAudio(speaker),
    (t) => t.packetsSent > 0,
    MEDIA_WAIT_MS,
    `${label}: speaker never sent audio RTP after publishing`,
  );
  await waitFor(
    () => inboundAudio(listener),
    (t) => t.packetsReceived > baseline,
    MEDIA_WAIT_MS,
    `${label}: listener received no new audio after the speaker published`,
  );
  const rtpMs = Date.now() - clickedAt;
  const audibleMs = await firstAudibleAt(listener, MEDIA_WAIT_MS, label);
  await speaker.context().close().catch(() => {});
  return { rtpMs, audibleMs: audibleMs + rtpMs };
}

/** Fine-grained per-SSRC audio sampler: packets, loss, jitter, and playout health. */
function startAudioSampler(page, sampleMs = SAMPLE_MS) {
  const samples = [];
  const timer = setInterval(async () => {
    try {
      const snapshot = await page.evaluate(async () => {
        const out = {};
        for (const pc of window.__hellavePCs ?? []) {
          const stats = await pc.getStats();
          stats.forEach((report) => {
            if (report.type !== "inbound-rtp" || report.kind !== "audio") return;
            const key = report.ssrc ?? report.id;
            out[key] = {
              packets: report.packetsReceived ?? 0,
              lost: report.packetsLost ?? 0,
              jitter: report.jitter ?? 0,
              concealed: report.concealedSamples ?? 0,
              emitted: report.jitterBufferEmittedCount ?? 0,
            };
          });
        }
        return out;
      });
      samples.push({ at: Date.now(), bySsrc: snapshot });
    } catch {
      // A page mid-recovery can fail a getStats; the next tick retries.
    }
  }, sampleMs);
  return { samples, timer };
}

/** Aggregate packet/series view across every audio SSRC in one sample. */
function aggregateSample(sample) {
  let packets = 0;
  let lost = 0;
  let jitter = 0;
  let concealed = 0;
  let emitted = 0;
  for (const entry of Object.values(sample.bySsrc)) {
    packets += entry.packets;
    lost += entry.lost;
    jitter = Math.max(jitter, entry.jitter);
    concealed += entry.concealed;
    emitted += entry.emitted;
  }
  return { packets, lost, jitter, concealed, emitted };
}

/**
 * Gap statistics over one window: the longest silence, how many silences exceeded half
 * a second, and the loss share across the window. Single-flow rooms only — every
 * smoothness case below keeps exactly one publisher sending.
 */
function smoothnessStats(samples, fromMs, toMs) {
  const window = samples.filter((s) => s.at >= fromMs && s.at <= toMs);
  let maxGapMs = 0;
  let gapsOver500 = 0;
  let first = null;
  let last = null;
  // Walk the window with running totals: any sample that advances the packet count ends
  // the silence that preceded it.
  let running = 0;
  let initialized = false;
  let lastAdvance = fromMs;
  for (const sample of window) {
    const total = aggregateSample(sample);
    if (!initialized) {
      running = total.packets;
      initialized = true;
    }
    first ??= total;
    last = total;
    if (total.packets > running) {
      running = total.packets;
      const gap = sample.at - lastAdvance;
      if (gap > maxGapMs) maxGapMs = gap;
      if (gap > 500) gapsOver500 += 1;
      lastAdvance = sample.at;
    }
  }
  // Trailing silence to the window edge counts too.
  const trailing = toMs - lastAdvance;
  if (trailing > maxGapMs) maxGapMs = trailing;
  if (trailing > 500) gapsOver500 += 1;
  let lossPct = 0;
  if (first && last) {
    const packets = last.packets - first.packets;
    const lost = last.lost - first.lost;
    if (packets + lost > 0) lossPct = (lost / (packets + lost)) * 100;
  }
  // Share of played-out samples the jitter buffer concealed (packet-loss concealment):
  // the closest stats-level proxy for audible glitches.
  let concealPct = 0;
  if (first && last) {
    const emitted = last.emitted - first.emitted;
    const concealed = last.concealed - first.concealed;
    if (emitted > 0) concealPct = (concealed / emitted) * 100;
  }
  return { maxGapMs, gapsOver500, lossPct, concealPct };
}

/** Attribute the speaker's relay flow by diffing relay ports across its join. */
async function attributeSpeakerPort(beforePorts, speakerLabel) {
  await sleep(3_000);
  const after = relay.seen().map((c) => c.port);
  const ports = after.filter((p) => !beforePorts.includes(p));
  assert.ok(ports.length > 0, `${speakerLabel}: could not attribute the speaker's relay flow`);
  const port = ports[0];
  assert.ok(
    relay.seen().find((c) => c.port === port)?.toSfu > 0,
    `${speakerLabel}: the attributed port carried no packets to the SFU`,
  );
  return port;
}

describe("talk-start latency and poor-network smoothness", () => {
  before(async () => {
    await relay.start();
    await harness.start();
  });
  afterEach(() => {
    relay.clearFlowProfiles();
    relay.unblockAll();
    return harness.closeOpenContexts();
  });
  after(async () => {
    await harness.stop();
    await relay.stop();
  });

  it("a listener hears a fresh publication within seconds, audibly", CASE_TIMEOUT, async () => {
    const listener = await harness.newPage("talk-listener", { grantMedia: false });
    const roomInstanceId = await harness.createRoom(listener, "talk-listener");
    // The listener stays quiet: with exactly one publisher sending, any inbound audio
    // on this page is the speaker under test.
    const results = [];
    for (let trial = 1; trial <= TRIALS; trial += 1) {
      const mark = sfuMark();
      const { rtpMs, audibleMs } = await talkStartTrial(
        listener,
        roomInstanceId,
        trial,
        `talk-start trial ${trial}`,
      );
      const window = sfuWindow(mark);
      results.push({ trial, rtpMs, audibleMs, ...window });
      assert.ok(
        audibleMs <= TALK_START_MS,
        `trial ${trial}: first audible audio took ${audibleMs}ms (bound ${TALK_START_MS}ms)`,
      );
    }
    const sorted = results.map((r) => r.audibleMs).sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil((sorted.length * 95) / 100) - 1)];
    console.log("TALK_START_RESULTS", JSON.stringify({ results, p95Ms: p95 }, null, 2));
    assert.ok(p95 <= TALK_START_MS, `talk-start p95 ${p95}ms exceeds ${TALK_START_MS}ms`);
  });

  it("a listener hears late joiners and rejoins within seconds", CASE_TIMEOUT, async () => {
    const listener = await harness.newPage("churn-listener", { grantMedia: false });
    const roomInstanceId = await harness.createRoom(listener, "churn-listener");
    const first = await harness.newPage("churn-first", { grantMedia: false });
    await harness.joinRoom(first, roomInstanceId, "churn-first");
    await harness.publishMic(first, "churn-first");
    await waitFor(
      () => inboundAudio(listener),
      (t) => t.packetsReceived > 0,
      MEDIA_WAIT_MS,
      "listener never heard the settled speaker",
    );

    // A late joiner is a fresh publication: the listener must hear them promptly.
    const lateMark = sfuMark();
    const late = await talkStartTrial(listener, roomInstanceId, "late", "late joiner");
    console.log("LATE_JOIN_RESULT", JSON.stringify({ ...late, ...sfuWindow(lateMark) }));
    assert.ok(late.audibleMs <= TALK_START_MS, `late joiner audible after ${late.audibleMs}ms`);

    // A rejoin is the same shape after a leave: the speaker drops out, comes back on a
    // fresh page, and the listener's audio must resume promptly.
    await first.context().close().catch(() => {});
    const rejoin = await talkStartTrial(listener, roomInstanceId, "rejoin", "rejoined speaker");
    console.log("REJOIN_RESULT", JSON.stringify({ ...rejoin }));
    assert.ok(rejoin.audibleMs <= TALK_START_MS, `rejoined speaker audible after ${rejoin.audibleMs}ms`);
  });

  it("a short uplink flap resumes audibly within seconds", CASE_TIMEOUT, async () => {
    const listener = await harness.newPage("flap-listener", { grantMedia: false });
    const roomInstanceId = await harness.createRoom(listener, "flap-listener");
    const beforePorts = relay.seen().map((c) => c.port);
    const speaker = await harness.newPage("flap-speaker", { grantMedia: false });
    await harness.joinRoom(speaker, roomInstanceId, "flap-speaker");
    await harness.publishMic(speaker, "flap-speaker");
    await waitFor(
      () => inboundAudio(listener),
      (t) => t.packetsReceived > 0,
      MEDIA_WAIT_MS,
      "listener never heard the speaker before the flap",
    );
    const speakerPort = await attributeSpeakerPort(beforePorts, "flap speaker");

    const mark = sfuMark();
    const flapMs = 2_000;
    const blockedAt = Date.now();
    relay.block(speakerPort);
    await sleep(flapMs);
    relay.unblock(speakerPort);
    const unblockedAt = Date.now();
    {
      const baseline = (await inboundAudio(listener)).packetsReceived;
      await waitFor(
        () => inboundAudio(listener),
        (t) => t.packetsReceived > baseline,
        FLAP_RESUME_MS,
        "listener audio never resumed after the flap",
      );
      const resumeMs = Date.now() - unblockedAt;
      const audibleMs = await firstAudibleAt(listener, FLAP_RESUME_MS, "flap recovery");
      console.log(
        "FLAP_RESULT",
        JSON.stringify({ flapMs, blockedForMs: unblockedAt - blockedAt, resumeMs, audibleMs, ...sfuWindow(mark) }),
      );
      assert.ok(resumeMs <= FLAP_RESUME_MS, `audio resumed ${resumeMs}ms after unblock`);
    }
  });

  it("audio stays continuous under shaped poor networks", CASE_TIMEOUT, async () => {
    const profiles = {
      clean: null,
      poor: { lossPercent: 5, delayMs: 120, jitterMs: 40, seed: 7 },
      veryPoor: { lossPercent: 15, delayMs: 250, jitterMs: 120, seed: 7 },
    };
    const listener = await harness.newPage("smooth-listener", { grantMedia: false });
    const roomInstanceId = await harness.createRoom(listener, "smooth-listener");
    const beforePorts = relay.seen().map((c) => c.port);
    const speaker = await harness.newPage("smooth-speaker", { grantMedia: false });
    await harness.joinRoom(speaker, roomInstanceId, "smooth-speaker");
    await harness.publishMic(speaker, "smooth-speaker");
    await waitFor(
      () => inboundAudio(listener),
      (t) => t.packetsReceived > 0,
      MEDIA_WAIT_MS,
      "listener never heard the speaker before shaping",
    );
    const speakerPort = await attributeSpeakerPort(beforePorts, "smooth speaker");

    const outcomes = [];
    for (const [name, profile] of Object.entries(profiles)) {
      if (profile) relay.setFlowProfile(speakerPort, profile);
      const sampler = startAudioSampler(listener);
      const fromMs = Date.now();
      await sleep(Number(process.env["SMOOTH_WINDOW_MS"] ?? SMOOTH_WINDOW_MS));
      const toMs = Date.now();
      clearInterval(sampler.timer);
      const stats = smoothnessStats(sampler.samples, fromMs, toMs);
      const shaped = profile ? relay.profileStats(speakerPort) : null;
      if (profile) {
        // The instrument check: a green run where the profile shaped nothing proves
        // nothing — media may have bypassed the relay entirely.
        assert.ok(
          (shaped?.shapedDropped ?? 0) + (shaped?.shapedDelayed ?? 0) > 0,
          `${name}: the profile shaped no datagrams — check the media path`,
        );
        relay.clearFlowProfiles();
      }
      outcomes.push({ profile: name, ...stats, shaped });
      console.log("SMOOTH_RESULT", JSON.stringify({ profile: name, ...stats, shaped }));
      // Packets flowing is not audibility: confirm the graph itself carries signal in
      // this window. Early-exits on the first audible read.
      const peak = await audiblePeak(listener, 4_000);
      assert.ok(
        peak > AUDIBLE_RMS,
        `${name}: no audible signal in the window (peak RMS ${peak})`,
      );
      assert.ok(
        stats.maxGapMs <= SMOOTH_MAX_GAP_MS,
        `${name}: longest audio gap ${stats.maxGapMs}ms exceeds ${SMOOTH_MAX_GAP_MS}ms`,
      );
      assert.ok(
        stats.gapsOver500 <= SMOOTH_MAX_GAPS_OVER_500MS,
        `${name}: ${stats.gapsOver500} gaps over 500ms exceeds ${SMOOTH_MAX_GAPS_OVER_500MS}`,
      );
      assert.ok(
        stats.lossPct <= SMOOTH_MAX_LOSS_PCT,
        `${name}: loss ${stats.lossPct.toFixed(1)}% exceeds ${SMOOTH_MAX_LOSS_PCT}%`,
      );
      assert.ok(
        stats.concealPct <= SMOOTH_MAX_CONCEAL_PCT,
        `${name}: concealment ${stats.concealPct.toFixed(1)}% exceeds ${SMOOTH_MAX_CONCEAL_PCT}%`,
      );
    }
    console.log("SMOOTH_RESULTS", JSON.stringify(outcomes, null, 2));
  });
});
