/**
 * Audio audibility baseline: source-to-listener speech-onset measurement.
 *
 * Baseline instrument, not a release gate: this file collects onset-latency samples
 * and listener-side health distributions and reports p50/p95/p99, but asserts no SLO
 * thresholds. Thresholds get proposed from the report, never the other way round.
 *
 * What it measures, and why it differs from a plain packet test:
 *
 * - Scripted speech-like source. The fake device's default tone is continuous, so it
 *   cannot mark when speech starts. These runs feed Chromium a generated WAV of voiced
 *   bursts separated by true silence (`--use-file-for-fake-audio-capture`), then detect
 *   burst onsets independently on the sender's capture track and on each listener's
 *   remote track. Every publisher still publishes through the normal SDK
 *   publish/republish flow; mute toggles are never used as talk-start (app mute keeps
 *   RTP flowing by design).
 * - Audio-only multipeer rooms. Phases run publishers and quiet listeners with
 *   staggered joins, a leave/rejoin, and one short controlled interruption — the
 *   production incident shape, minus video contention.
 * - Two media paths. `AUDIO_PATH=direct` (default) exercises the local stack as-is;
 *   `AUDIO_PATH=turn` forces relayed candidates and asserts the selected pair is a
 *   TURN relay, so the same onset methodology covers the relay path production uses
 *   on poor networks. Comma-separate to run both (`AUDIO_PATH=direct,turn`). Shaping
 *   and flap cases are direct-path only: the userspace relay sits on the SFU's
 *   advertised UDP port, which relayed TURN flows bypass.
 * - Listener-side proof. Per-listener packet gaps, jitter, loss share, concealment
 *   share, and Web Audio RMS. SFU renegotiation/drop counters are diagnostic only.
 *
 * Run against a local stack with the relay in the media path:
 *
 *   HELLAVE_SFU_ADVERTISE_UDP_PORT=10100 scripts/local-stack.sh up
 *   npm run build
 *   node --env-file=.env.local --test --test-force-exit --test-reporter=spec test/talk-start.test.mjs
 *
 * TURN path additionally needs a local TURN server and an SFU advertising it, e.g.
 * a static-secret turn-server container plus an sfu-node restart with
 * HELLAVE_ICE_TURN_URLS="turn:127.0.0.1:3478?transport=udp,turn:127.0.0.1:5349?transport=tcp"
 * and the matching HELLAVE_TURN_STATIC_AUTH_SECRET. Without relay candidates the
 * TURN phase fails with instructions, never a silent skip.
 *
 * Tunables: TALK_START_PORT (3105), TALK_START_RELAY_PORT (10100),
 * TALK_START_SFU_PORT (10000), TALK_START_WAIT_MS (45000), PHASE_BURST_WINDOW_MS
 * (45000 per publisher phase), SMOOTH_WINDOW_MS (20000), AUDIO_PATH (direct),
 * MIN_ONSET_SAMPLES (30).
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHarness,
  iceDiagnostics,
  inboundAudio,
  outboundAudio,
  waitFor,
} from "./harness.mjs";
import { createPartitionRelay } from "./udp-partition-relay.mjs";

const PORT = Number(process.env["TALK_START_PORT"] ?? 3105);
const RELAY_PORT = Number(process.env["TALK_START_RELAY_PORT"] ?? 10100);
const SFU_PORT = Number(process.env["TALK_START_SFU_PORT"] ?? 10000);
const MEDIA_WAIT_MS = Number(process.env["TALK_START_WAIT_MS"] ?? 45_000);
const PHASE_WINDOW_MS = Number(process.env["PHASE_BURST_WINDOW_MS"] ?? 45_000);
const SMOOTH_WINDOW_MS = Number(process.env["SMOOTH_WINDOW_MS"] ?? 20_000);
const MIN_ONSET_SAMPLES = Number(process.env["MIN_ONSET_SAMPLES"] ?? 30);
const CASE_TIMEOUT = { timeout: 600_000 };
const PATHS = (process.env["AUDIO_PATH"] ?? "direct")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
/** Polling cadence for RMS onset sampling (~±200ms end-to-end quantization). */
const SAMPLE_MS = 100;
/** Hysteresis band for burst-onset detection; the scripted tone peaks near 0.15 RMS. */
const ONSET_RMS = 0.05;
const SILENCE_RMS = 0.02;
/** A listener onset later than this after its sender onset counts as a miss, not data. */
const PAIR_WINDOW_MS = 20_000;
const SFU_LOG =
  process.env["TALK_START_SFU_LOG"] ?? "/Users/johnpaulokoye/make/maiaddy/VOD/Hellave/.local/run/sfu-node.log";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Deterministic speech-like fixture: voiced harmonic bursts separated by true digital
 * silence, 48kHz mono 16-bit PCM. Two bursts per 3s period, so a minute of audio holds
 * ~40 onsets. Written to the OS temp dir (never committed) before the browser
 * launches; Chromium loops fake-capture files.
 */
function speechFixturePath() {
  const dir = join(tmpdir(), "hellave-audio-baseline");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "speech-bursts-48k.wav");
  if (existsSync(path)) return path;
  const sampleRate = 48000;
  const seconds = 120;
  const count = sampleRate * seconds;
  const data = Buffer.alloc(44 + count * 2);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + count * 2, 4);
  data.write("WAVE", 8);
  data.write("fmt ", 12);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(sampleRate, 24);
  data.writeUInt32LE(sampleRate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(count * 2, 40);
  const envelope = (t, start, dur) => {
    const local = t - start;
    if (local < 0 || local >= dur) return 0;
    const edge = 0.015;
    const r = Math.min(local, dur - local, edge) / edge;
    return 0.5 - 0.5 * Math.cos(Math.PI * r);
  };
  const voiced = (t) => {
    // Speech-like: 130Hz with decaying harmonics, light vibrato and tremolo.
    const f0 = 130 * (1 + 0.02 * Math.sin(2 * Math.PI * 5 * t));
    const amps = [1, 0.5, 0.3, 0.2, 0.12];
    let v = 0;
    for (let h = 0; h < amps.length; h += 1) {
      v += amps[h] * Math.sin(2 * Math.PI * f0 * (h + 1) * t);
    }
    return v * 0.06 * (0.75 + 0.25 * Math.sin(2 * Math.PI * 3 * t));
  };
  const burstAt = (t) => {
    const cyc = t % 3;
    return voiced(t) * Math.max(envelope(cyc, 0, 0.7), envelope(cyc, 1.2, 0.7));
  };
  for (let i = 0; i < count; i += 1) {
    const sample = Math.max(-1, Math.min(1, burstAt(i / sampleRate)));
    data.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }
  writeFileSync(path, data);
  return path;
}

const SPEECH_WAV = speechFixturePath();

const harness = createHarness({
  port: PORT,
  mediaWaitMs: MEDIA_WAIT_MS,
  browserArgs: [`--use-file-for-fake-audio-capture=${SPEECH_WAV}`],
});
const relay = createPartitionRelay({ listenPort: RELAY_PORT, targetPort: SFU_PORT });

/**
 * Force relayed ICE candidates on pages created afterwards. The SDK builds its own
 * RTCPeerConnection config, so the test wraps the constructor (test-only
 * instrumentation, direct mode never installs it). Installed via addInitScript before
 * the page navigates, next to the harness PC/WS spies.
 */
const RELAY_ONLY_SPY = `
  (() => {
    const Prev = window.RTCPeerConnection;
    window.__forcedRelayConfigs = [];
    window.RTCPeerConnection = function (config, ...rest) {
      const merged = { ...(config || {}), iceTransportPolicy: "relay" };
      window.__forcedRelayConfigs.push(JSON.parse(JSON.stringify(merged)));
      return new Prev(merged, ...rest);
    };
    window.RTCPeerConnection.prototype = Prev.prototype;
    Object.assign(window.RTCPeerConnection, Prev);
  })();
`;

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
 * Install an RMS sampler, retrying until the track exists. A remote track is live
 * and muted until the SFU binds the subscription, so the first attempt right after
 * publish usually finds nothing to sample yet.
 */
async function installRmsSamplerReady(page, which, label) {
  const deadline = Date.now() + MEDIA_WAIT_MS;
  for (;;) {
    if (await installRmsSampler(page, which).catch(() => false)) return;
    assert.ok(
      Date.now() < deadline,
      `${label}: no live ${which === "send" ? "capture" : "remote"} audio track to sample`,
    );
    await sleep(1000);
  }
}
async function installRmsSampler(page, which) {
  return page.evaluate(async (mode) => {
    let track = null;
    for (const pc of window.__hellavePCs ?? []) {
      if (mode === "send") {
        for (const sender of pc.getSenders()) {
          if (sender.track?.kind === "audio" && sender.track.readyState === "live") {
            track = sender.track;
            break;
          }
        }
      } else {
        for (const receiver of pc.getReceivers()) {
          if (receiver.track?.kind !== "audio") continue;
          if (receiver.track.readyState !== "live" || receiver.track.muted) continue;
          if ((receiver.getSynchronizationSources?.() ?? []).length === 0) continue;
          track = receiver.track;
          break;
        }
      }
      if (track) break;
    }
    if (!track) return false;
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
    window.__rmsSampler = { analyser, samples: new Float32Array(analyser.fftSize) };
    return true;
  }, which);
}

async function readRms(page) {
  const value = await page
    .evaluate(() => {
      const sampler = window.__rmsSampler;
      if (!sampler) return null;
      sampler.analyser.getFloatTimeDomainData(sampler.samples);
      let sum = 0;
      for (const v of sampler.samples) sum += v * v;
      return Math.sqrt(sum / sampler.samples.length);
    })
    .catch(() => null);
  return typeof value === "number" ? value : null;
}

/** Rising edges through the hysteresis band: the burst onsets in one RMS series. */
function onsetTimes(series) {
  const onsets = [];
  let armed = false;
  let wasLow = false;
  for (const point of series) {
    if (point.rms === null) continue;
    if (!armed) {
      if (point.rms < SILENCE_RMS) {
        armed = true;
        wasLow = true;
      }
      continue;
    }
    if (wasLow && point.rms >= ONSET_RMS) {
      onsets.push(point.at);
      wasLow = false;
    } else if (!wasLow && point.rms < SILENCE_RMS) {
      wasLow = true;
    }
  }
  return onsets;
}

/**
 * Pair each sender onset with the next listener onset. A listener onset past the pair
 * window — or one that arrives after the next sender onset — is a miss, recorded
 * rather than averaged away.
 */
function pairOnsets(senderOnsets, listenerOnsets) {
  const latencies = [];
  const missedIdx = [];
  let misses = 0;
  let j = 0;
  for (let i = 0; i < senderOnsets.length; i += 1) {
    const t0 = senderOnsets[i];
    const nextSender = senderOnsets[i + 1] ?? Infinity;
    while (j < listenerOnsets.length && listenerOnsets[j] <= t0) j += 1;
    if (j < listenerOnsets.length && listenerOnsets[j] < Math.min(nextSender, t0 + PAIR_WINDOW_MS)) {
      latencies.push(listenerOnsets[j] - t0);
      j += 1;
    } else {
      misses += 1;
      missedIdx.push(i);
    }
  }
  return { latencies, misses, missedIdx };
}

function distribution(values) {
  if (values.length === 0) return { count: 0, p50: null, p95: null, p99: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((sorted.length * p) / 100) - 1)];
  return { count: sorted.length, p50: at(50), p95: at(95), p99: at(99) };
}

/** Peak Web Audio RMS for one-off audible confirmation (early-exits when heard). */
async function audiblePeak(page, measureMs = 4000) {
  const deadline = Date.now() + measureMs;
  for (;;) {
    const peak = await readRms(page).catch(() => null);
    if (peak !== null && peak > ONSET_RMS) return peak;
    if (Date.now() >= deadline) return peak ?? 0;
    await sleep(SAMPLE_MS);
  }
}

/** Fine-grained per-SSRC audio sampler: packets, loss, jitter, and playout health. */
function startAudioSampler(page, sampleMs = 250) {
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
 * a second, and the loss share across the window. Single-flow rooms only.
 */
function smoothnessStats(samples, fromMs, toMs) {
  const window = samples.filter((s) => s.at >= fromMs && s.at <= toMs);
  let maxGapMs = 0;
  let gapsOver500 = 0;
  let first = null;
  let last = null;
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
  const trailing = toMs - lastAdvance;
  if (trailing > maxGapMs) maxGapMs = trailing;
  if (trailing > 500) gapsOver500 += 1;
  let lossPct = 0;
  if (first && last) {
    const packets = last.packets - first.packets;
    const lost = last.lost - first.lost;
    if (packets + lost > 0) lossPct = (lost / (packets + lost)) * 100;
  }
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

/**
 * Selected-path snapshot for one page: local/remote candidate kinds per peer
 * connection, used to prove which path (direct or relay) a phase actually took.
 */
async function mediaPaths(page) {
  const diag = await iceDiagnostics(page).catch(() => []);
  return diag.map((pc) => ({
    local: pc.local ?? [],
    remote: pc.remote ?? [],
  }));
}

async function assertRelayPath(page, label) {
  const paths = await waitFor(
    async () => mediaPaths(page),
    (list) =>
      list.some((pc) =>
        [...(pc.local ?? []), ...(pc.remote ?? [])].some((entry) => String(entry).includes("relay")),
      ),
    60_000,
    `${label}: no relayed candidate pair appeared`,
  ).catch(async (error) => {
    throw new Error(
      `${error.message}\n${label} ICE: ${JSON.stringify(await iceDiagnostics(page))}\n` +
        "TURN path needs a local TURN server plus an SFU advertising it, e.g. a " +
        "static-secret turn-server container and an sfu-node restart with " +
        "HELLAVE_ICE_TURN_URLS and the matching HELLAVE_TURN_STATIC_AUTH_SECRET.",
    );
  });
  return paths;
}

/**
 * Sample RMS series from a set of pages for `durationMs`. Each entry is
 * `{ page, role, series: [{ at, rms }] }`.
 */
async function samplePhase(entries, durationMs) {
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    // Timestamped per read, not per loop: sequential evaluates pages apart by tens of
    // ms, and stamping them identically would bias every latency low by that skew.
    for (const entry of entries) {
      const rms = await readRms(entry.page).catch(() => null);
      entry.series.push({ at: Date.now(), rms });
    }
    await sleep(SAMPLE_MS);
  }
}

async function runBaseline(pathLabel, { forceRelay }) {
  const tag = (name) => `${pathLabel}-${name}`;
  const listenerA = await harness.newPage(tag("listener-a"), { grantMedia: false });
  const listenerB = await harness.newPage(tag("listener-b"), { grantMedia: false });
  if (forceRelay) {
    await listenerA.addInitScript(RELAY_ONLY_SPY);
    await listenerB.addInitScript(RELAY_ONLY_SPY);
  }
  const roomInstanceId = await harness.createRoom(listenerA, tag("listener-a"));
  await harness.joinRoom(listenerB, roomInstanceId, tag("listener-b"));
  if (forceRelay) {
    await assertRelayPath(listenerA, `${tag("listener-a")} TURN pair`);
  }

  const latencies = [];
  const pairSummaries = [];
  let misses = 0;
  const mark = sfuMark();
  // Two publishers take turns so bursts never overlap: per-pair attribution stays exact.
  for (const speakerName of [tag("speaker-a"), tag("speaker-b")]) {
    const beforePorts = relay.seen().map((c) => c.port);
    const speaker = await harness.newPage(speakerName, { grantMedia: false });
    if (forceRelay) await speaker.addInitScript(RELAY_ONLY_SPY);
    await harness.joinRoom(speaker, roomInstanceId, speakerName);
    await harness.publishMic(speaker, speakerName);
    await waitFor(
      () => outboundAudio(speaker),
      (t) => t.packetsSent > 0,
      MEDIA_WAIT_MS,
      `${speakerName} never sent audio RTP after publishing`,
    );
    await installRmsSamplerReady(speaker, "send", speakerName);
    // Late join churn mid-phase: a third listener arrives while audio is flowing.
    let late = null;
    if (speakerName.endsWith("speaker-b")) {
      late = await harness.newPage(tag("listener-c"), { grantMedia: false });
      if (forceRelay) await late.addInitScript(RELAY_ONLY_SPY);
      await harness.joinRoom(late, roomInstanceId, tag("listener-c"));
    }
    const listeners = late ? [listenerA, listenerB, late] : [listenerA, listenerB];
    for (const listener of listeners) {
      await installRmsSamplerReady(listener, "recv", "listener");
    }
    const entries = [
      { page: speaker, role: "send", series: [] },
      ...listeners.map((page) => ({ page, role: "recv", series: [] })),
    ];
    const phaseStart = Date.now();
    await samplePhase(entries, PHASE_WINDOW_MS);
    const senderOnsets = onsetTimes(entries[0].series);
    assert.ok(
      senderOnsets.length > 0,
      `${speakerName}: scripted bursts produced no detectable source onsets`,
    );
    for (const entry of entries.slice(1)) {
      const listenerOnsets = onsetTimes(entry.series);
      const paired = pairOnsets(senderOnsets, listenerOnsets);
      misses += paired.misses;
      for (const ms of paired.latencies) latencies.push(ms);
      pairSummaries.push({
        speaker: speakerName,
        senderBursts: senderOnsets.length,
        listenerBursts: listenerOnsets.length,
        paired: paired.latencies.length,
        misses: paired.misses,
        latencies: paired.latencies,
        missedIdx: paired.missedIdx,
        senderOnsets: senderOnsets.slice(0, 8).map((t) => t - phaseStart),
        listenerOnsets: listenerOnsets.slice(0, 8).map((t) => t - phaseStart),
      });
    }
    if (forceRelay) {
      await assertRelayPath(speaker, `${speakerName} TURN pair`);
    }
    await speaker.context().close().catch(() => {});
    if (late) await late.context().close().catch(() => {});
  }

  const stats = {
    path: pathLabel,
    onsetLatencyMs: distribution(latencies),
    misses,
    pairs: pairSummaries,
    sfu: sfuWindow(mark),
    paths: {
      listenerA: await mediaPaths(listenerA),
    },
  };
  console.log("ONSET_BASELINE", JSON.stringify(stats, null, 2));
  assert.ok(
    stats.onsetLatencyMs.count >= MIN_ONSET_SAMPLES,
    `only ${stats.onsetLatencyMs.count} onset samples (need ${MIN_ONSET_SAMPLES}); see ONSET_BASELINE above`,
  );
  return stats;
}

async function runShapedWindows() {
  // Direct path only: the userspace relay sits on the SFU's advertised UDP port, which
  // relayed TURN flows bypass. Shaping TURN would need a relay in front of TURN itself.
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
  await installRmsSamplerReady(listener, "recv", "smooth listener");
  const speakerPort = await attributeSpeakerPort(beforePorts, "smooth speaker");

  const profiles = {
    poor: { lossPercent: 5, delayMs: 120, jitterMs: 40, seed: 7 },
    veryPoor: { lossPercent: 15, delayMs: 250, jitterMs: 120, seed: 7 },
  };
  const outcomes = [];
  for (const [name, profile] of Object.entries(profiles)) {
    relay.setFlowProfile(speakerPort, profile);
    const sampler = startAudioSampler(listener);
    const rmsSeries = [];
    const fromMs = Date.now();
    const toMs = fromMs + Number(process.env["SMOOTH_WINDOW_MS"] ?? SMOOTH_WINDOW_MS);
    while (Date.now() < toMs) {
      const rms = await readRms(listener).catch(() => null);
      rmsSeries.push({ at: Date.now(), rms });
      await sleep(SAMPLE_MS);
    }
    clearInterval(sampler.timer);
    const stats = smoothnessStats(sampler.samples, fromMs, Date.now());
    const shaped = relay.profileStats(speakerPort);
    assert.ok(
      (shaped?.shapedDropped ?? 0) + (shaped?.shapedDelayed ?? 0) > 0,
      `${name}: the profile shaped no datagrams — check the media path`,
    );
    relay.clearFlowProfiles();
    const audible = rmsSeries.some((p) => p.rms !== null && p.rms >= ONSET_RMS);
    outcomes.push({ profile: name, ...stats, audibleInWindow: audible, shaped });
    console.log("SMOOTH_BASELINE", JSON.stringify({ profile: name, ...stats, audibleInWindow: audible, shaped }));
  }
  return outcomes;
}

async function runFlap() {
  // Direct path only, same relay-placement reason as the shaped windows.
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
  const baseline = (await inboundAudio(listener)).packetsReceived;
  await waitFor(
    () => inboundAudio(listener),
    (t) => t.packetsReceived > baseline,
    60_000,
    "listener audio never resumed after the flap",
  );
  const result = {
    flapMs,
    blockedForMs: unblockedAt - blockedAt,
    resumeMs: Date.now() - unblockedAt,
    ...sfuWindow(mark),
  };
  console.log("FLAP_BASELINE", JSON.stringify(result));
  return result;
}

describe("audio audibility baseline", () => {
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

  for (const pathLabel of PATHS) {
    const forceRelay = pathLabel === "turn";
    it(`collects source-to-listener onset latencies over ${pathLabel} media`, CASE_TIMEOUT, async () => {
      const stats = await runBaseline(pathLabel, { forceRelay });
      assert.ok(stats.onsetLatencyMs.count >= MIN_ONSET_SAMPLES, "onset baseline incomplete");
    });
  }

  it("records resume timing for one short controlled interruption", CASE_TIMEOUT, async () => {
    if (PATHS.some((p) => p !== "direct")) {
      console.log("FLAP_BASELINE", JSON.stringify({ skipped: "shaping/flap cases are direct-path only" }));
      return;
    }
    await runFlap();
  });

  it("records listener health under shaped poor networks", CASE_TIMEOUT, async () => {
    if (PATHS.some((p) => p !== "direct")) {
      console.log("SMOOTH_BASELINE", JSON.stringify({ skipped: "shaping cases are direct-path only" }));
      return;
    }
    const outcomes = await runShapedWindows();
    console.log("SMOOTH_BASELINES", JSON.stringify(outcomes, null, 2));
  });
});
