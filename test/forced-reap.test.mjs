/**
 * The reap-recovery contract, exercised against a running system instead of a unit harness.
 *
 * `multi_publisher_stability.md` states it: a transport reap must keep the publication bindable, so
 * a peer that recovers re-binds the SAME publication id rather than minting a new one or hitting
 * the 60s cancellation fence. Three regression tests in `control_attachment.rs` pin that at the
 * unit level, and a seven-peer browser run shows no regression — but neither actually enters the
 * recovery path, because nothing in them reaps a live publisher. That is the gap this closes.
 *
 * ## Why a UDP relay
 *
 * Reaching the required state is fussier than it looks: one peer's ICE has to go *disconnected*
 * while its peer connection stays open and the SFU's control plane stays healthy. Four cheaper
 * levers were tried and each fails for a different reason:
 *
 *   - `context.setOffline(true)` never touches WebRTC's UDP flows; RTP kept climbing right through
 *     it (273 -> 1841 packets), so nothing was interrupted.
 *   - `pc.close()` reaps reliably at ~32s, but leaves the SDK with a *closed* connection, which it
 *     correctly declines to recover from: 90s of silence and no recovery attempt logged.
 *   - `SIGSTOP` on the SFU freezes its control HTTP too, so signaling releases the placement and
 *     the room is torn down — `reason=room_placement_released`, not a reap at all.
 *   - `setConfiguration({iceTransportPolicy:"relay"})` + `restartIce()` does not disturb an
 *     already-selected candidate pair; the page sat at connected/connected for 60s.
 *
 * Dropping datagrams is what is left, and it is also the honest reproduction of the incident — an
 * environment-level network event, not an API call. The SFU keeps binding its usual media port but
 * advertises the relay's, so blocking one browser's source port partitions exactly that peer while
 * the room carries on around it.
 *
 * ## Running it
 *
 * The stack must be started with the relay in the media path, which is not the default:
 *
 *   HELLAVE_SFU_ADVERTISE_UDP_PORT=10100 scripts/local-stack.sh up
 *   npm run build
 *   node --env-file=.env.local --test --test-force-exit --test-reporter=spec test/forced-reap.test.mjs
 *
 * Local only, by construction: it needs a relay in front of the SFU and the SFU's log on disk.
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  appEvents,
  createHarness,
  decodingVideo,
  inboundAudio,
  receivedVideo,
  waitFor,
} from "./harness.mjs";
import { createPartitionRelay } from "./udp-partition-relay.mjs";

const PORT = Number(process.env["FORCED_REAP_PORT"] ?? 3103);
const RELAY_PORT = Number(process.env["FORCED_REAP_RELAY_PORT"] ?? 10100);
const SFU_PORT = Number(process.env["FORCED_REAP_SFU_PORT"] ?? 10000);
const SFU_LOG =
  process.env["FORCED_REAP_SFU_LOG"] ??
  "/Users/johnpaulokoye/make/maiaddy/VOD/Hellave/.local/run/sfu-node.log";

/** Measured at ~32s: a ~22s ICE consent timeout, then the SFU's 10s disconnect grace. */
const REAP_WAIT_MS = 90_000;
const RECOVERY_WAIT_MS = 120_000;
const CASE_TIMEOUT = { timeout: 420_000 };

/** Three, not two: the room has to stay populated so a reap is a reap and not a teardown. */
const PEERS = 3;

const harness = createHarness({ port: PORT, mediaWaitMs: 45_000 });
const relay = createPartitionRelay({ listenPort: RELAY_PORT, targetPort: SFU_PORT });

const label = (index) => `p${String(index + 1).padStart(2, "0")}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every SFU log line naming this room — the only lines a case may reason about. */
function roomLines(roomInstanceId) {
  try {
    return readFileSync(SFU_LOG, "utf8").split("\n").filter((l) => l.includes(roomInstanceId));
  } catch {
    return [];
  }
}

/** The publication id this page's own camera was published under, per its event log. */
async function ownCameraPublication(page) {
  const events = await appEvents(page);
  const match = events.match(/Camera published \((pub-[0-9a-f-]+)\)/i);
  return match?.[1] ?? null;
}

describe("a reaped publisher", () => {
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

  it("re-binds the same publication id after its transport is reaped", CASE_TIMEOUT, async () => {
    // grantMedia:false is load-bearing, not an oversight. With permissions granted Chrome exposes
    // real host candidates, the SFU probes the browser directly from the port it is actually bound
    // to, and the browser nominates that direct pair — leaving the relay carrying a fraction of the
    // handshake while media flows around it, which would make every assertion below vacuous. Denied
    // permissions put host candidates behind mDNS names the SFU cannot resolve, so the advertised
    // relay is the only path. The fake-device flags still auto-accept getUserMedia, so publishing
    // works exactly as it does elsewhere in the suite.
    const watchers = [];
    for (let index = 0; index < PEERS - 1; index += 1) {
      watchers.push(await harness.newPage(label(index), { grantMedia: false }));
    }
    const victim = await harness.newPage(label(PEERS - 1), { grantMedia: false });

    // The watchers come up first, and the allowlist is taken before the victim exists.
    //
    // Attributing the victim's ports instead does not hold: it opens further flows as the room
    // grows around it, and any of those landing in "everyone else" leaves it connected through the
    // partition and never reaped — which is exactly how this went flaky. A snapshot taken before
    // the victim has joined cannot contain a victim flow, so every flow it ever opens, including
    // the fresh port its ICE restart reaches for, falls outside and stays dropped.
    //
    // Renegotiation alone does not move a peer's port — only an ICE restart does — so the watchers
    // keep these flows when the victim later publishes into the room.
    const roomInstanceId = await harness.createRoom(watchers[0], label(0));
    await harness.publishMic(watchers[0], label(0));
    await harness.startCamera(watchers[0], label(0));
    for (let index = 1; index < watchers.length; index += 1) {
      await harness.joinRoom(watchers[index], roomInstanceId, label(index));
      await harness.publishMic(watchers[index], label(index));
      await harness.startCamera(watchers[index], label(index));
    }
    await sleep(3_000);

    // The instrument, checked before anything is concluded from it. An empty relay means media is
    // not passing through it at all, and every assertion below would be vacuous.
    const watcherPorts = relay.seen().map((client) => client.port);
    assert.ok(
      watcherPorts.length > 0,
      "no media reached the relay — start the stack with " +
        `HELLAVE_SFU_ADVERTISE_UDP_PORT=${RELAY_PORT} scripts/local-stack.sh up`,
    );

    const victimName = label(PEERS - 1);
    await harness.joinRoom(victim, roomInstanceId, victimName);
    await harness.publishMic(victim, victimName);
    await harness.startCamera(victim, victimName);
    await sleep(3_000);

    const victimPublication = await ownCameraPublication(victim);
    assert.ok(victimPublication, "could not read the victim's own camera publication id");

    // What every watcher holds before the outage — the identity the contract says must survive.
    for (const [offset, watcher] of watchers.entries()) {
      const seen = await waitFor(
        () => receivedVideo(watcher),
        (entries) => entries.includes(`camera:${victimPublication}`),
        45_000,
        `${label(offset)} never received the victim's camera before the partition`,
      );
      assert.ok(seen.includes(`camera:${victimPublication}`));
    }

    // ---- the network goes away for exactly one peer ----
    //
    // Expressed as an allowlist rather than a block on the victim's port. Blocking a port only
    // holds for ~20s: ICE restarts, the browser opens a fresh local port, and the relay carries it,
    // so the peer is back before the SFU's 10s grace expires and is never reaped. Carrying only the
    // watchers keeps the victim down however many ports it reaches for.
    //
    // The signaling socket has to go too, and that is fidelity rather than convenience. Cutting
    // media alone leaves the SDK free to renegotiate over signaling, and each ICE restart re-arms
    // the SFU's agent into `Checking` — measured: eight fresh ports over 70s, all dropped, while
    // the SFU never once reached `Disconnected` and so never started the grace that
    // `disconnect_if_ice_grace_expired` needs. What the incident records is an uplink that died,
    // so the peer's whole network goes away here: `setOffline` for WS and HTTP (it provably does
    // not touch WebRTC's UDP), the relay for the media.
    relay.allowOnly(watcherPorts);
    await victim.context().setOffline(true);

    const reap = await waitFor(
      async () => roomLines(roomInstanceId).find((l) => l.includes("removing disconnected participant")) ?? "",
      (line) => line.length > 0,
      REAP_WAIT_MS,
      "the partitioned peer was never reaped",
    );
    assert.match(
      reap,
      /reason=ice_disconnected_timeout/,
      `the reap must be an ICE timeout, not a teardown: ${reap.slice(0, 200)}`,
    );

    // The partition really was in effect, rather than the reap being incidental.
    //
    // Measured at the relay, not from the page: a partitioned browser keeps handing packets to the
    // network and its `packetsSent` climbs the whole time (2006 -> 2033 while fully cut off), so
    // outbound stats cannot tell a working path from a black hole. The relay knows what it dropped.
    const droppedTotal = relay.seen().reduce((sum, client) => sum + client.dropped, 0);
    assert.ok(droppedTotal > 0, "the partition dropped no datagrams — it was never in effect");

    // Exactly one peer was collected: the room, and everyone else in it, survived.
    const reaped = roomLines(roomInstanceId).filter((l) =>
      l.includes("removing disconnected participant"),
    );
    assert.equal(
      reaped.length,
      1,
      `only the partitioned peer may be reaped; got ${reaped.length}`,
    );

    // ---- and comes back ----
    await victim.context().setOffline(false);
    relay.allowAll();

    // The contract itself: the SAME publication id, re-bound, carrying frames again.
    for (const [offset, watcher] of watchers.entries()) {
      const name = label(offset);
      const seen = await waitFor(
        () => receivedVideo(watcher),
        (entries) => entries.includes(`camera:${victimPublication}`),
        RECOVERY_WAIT_MS,
        `${name} never got the victim's publication ${victimPublication} back`,
      );
      assert.ok(
        seen.includes(`camera:${victimPublication}`),
        `${name} must hold the original publication id, not a fresh one: ${JSON.stringify(seen)}`,
      );

      // Every other peer, not merely "something": with three in the room a watcher decoding both
      // of the others is necessarily decoding the victim. `decodingVideo` reports track ids rather
      // than publication ids, so the count is what ties frames back to the recovered publisher.
      const decoding = await waitFor(
        () => decodingVideo(watcher),
        (found) => found.tracks >= PEERS - 1,
        RECOVERY_WAIT_MS,
        `${name} holds the publication but is not decoding frames from every peer`,
      );
      assert.ok(decoding.tracks >= PEERS - 1);

      // Audio is unbounded, so the room being whole again is a hard floor.
      const heard = await waitFor(
        () => inboundAudio(watcher),
        (t) => t.tracks >= PEERS - 1 && t.packetsReceived > 0,
        RECOVERY_WAIT_MS,
        `${name} did not hear the whole room after recovery`,
      );
      assert.ok(heard.tracks >= PEERS - 1);
    }

    // The fence is what turned the incident terminal; it must not have been armed against a
    // publication whose owner was merely reaped.
    const cancelled = roomLines(roomInstanceId).filter((l) => l.includes("publication_cancelled"));
    assert.deepEqual(
      cancelled,
      [],
      `a recovery re-publish hit the cancellation fence:\n${cancelled.join("\n")}`,
    );

    // And no client was told its recoverable failure was terminal.
    for (const [index, page] of [...watchers, victim].entries()) {
      const events = await appEvents(page);
      assert.ok(
        !/authorization_denied/i.test(events),
        `${label(index)} saw a transient media failure classified as authorization:\n${events}`,
      );
    }
  });
});
