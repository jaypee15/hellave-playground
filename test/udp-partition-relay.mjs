/**
 * A UDP relay that can partition one peer's media path on demand.
 *
 * Forcing a reap needs a very specific state: one peer's ICE goes *disconnected* while its peer
 * connection stays open and the SFU's control plane stays healthy. Four cheaper levers were tried
 * and each fails for its own reason (recorded in reap-probe-diag.mjs):
 * `context.setOffline` never touches WebRTC's UDP; `pc.close()` reaps but leaves the SDK with a
 * *closed* connection it correctly declines to recover; SIGSTOP on the SFU also freezes its
 * control HTTP, so signaling releases the placement and the room is torn down instead of reaped;
 * and `setConfiguration` + `restartIce()` does not disturb an already-selected candidate pair.
 *
 * Dropping datagrams is the only thing that produces real packet loss without touching anything
 * else. The SFU binds its usual media port but advertises this relay's port instead
 * (`HELLAVE_SFU_ADVERTISE_UDP_PORT`), so every browser sends here, and blocking one source address
 * partitions exactly that peer while the rest of the room carries on.
 *
 * Shaped like a NAT, because that is what it is: each distinct client address gets its own
 * upstream socket, so the SFU's replies come back on the socket that peer's traffic left from and
 * can be returned to the right browser.
 *
 * Two things are required of the caller, both learned the hard way:
 *
 *   1. Pages must be opened WITHOUT granted media permissions. Chrome then hides host candidates
 *      behind mDNS `.local` names, which the SFU cannot resolve — so it cannot probe the browser
 *      directly. With permissions granted, the SFU's own packets arrive from the port it is really
 *      bound to, the browser learns that as a peer-reflexive candidate and nominates a direct pair,
 *      and the relay ends up carrying only a fraction of the ICE handshake (measured: 13 packets,
 *      then nothing) while media flows around it. A real NAT rewrites that source address; a
 *      userspace relay only rewrites one direction.
 *   2. Which source port belongs to which peer comes from `seen()`, not from the page's getStats.
 *      Under mDNS the two disagree — the page reported local port 63601 for a flow the relay saw
 *      arriving from 54189 — so attribute ports by bringing peers up one at a time and diffing.
 */
import dgram from "node:dgram";

/**
 * Deterministic PRNG (mulberry32) so a shaped profile drops and jitters the same
 * datagrams on every run for the same seed and packet order. Wall-clock delivery is
 * still approximate — setTimeout is not exact — but the loss decisions are stable.
 */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param listenPort  where browsers send (the SFU's advertised port)
 * @param targetPort  where the SFU actually binds
 */
export function createPartitionRelay({
  listenPort = 10100,
  targetPort = 10000,
  targetHost = "127.0.0.1",
  listenHost = "127.0.0.1",
} = {}) {
  const inbound = dgram.createSocket("udp4");
  /** clientKey -> { socket, address, port, toSfu, toClient, dropped } */
  const clients = new Map();
  /**
   * Blocked source ports.
   *
   * Keyed on port alone rather than address:port: the source address a browser's media arrives
   * from varies with how the page was opened (the machine's LAN address when permissions are
   * granted, loopback under mDNS), while the port identifies the socket either way. Ports are
   * unique per socket, so this is both simpler and immune to the two sides disagreeing about
   * which address to name.
   */
  const blocked = new Set();
  /**
   * Per-flow shaped-network profiles: source port -> profile. A profile degrades one
   * peer's path like a poor network instead of cutting it: probabilistic loss plus a
   * base delay with uniform jitter, applied in both directions of that flow. Partition
   * (block/allowOnly) still wins: a shaped datagram due for delivery is dropped on
   * arrival if its port has since been blocked.
   */
  const profiles = new Map();

  function shapeDelayMs(profile) {
    if (profile.delayMs <= 0 && profile.jitterMs <= 0) return 0;
    const jitter =
      profile.jitterMs > 0 ? (profile.rng() * 2 - 1) * profile.jitterMs : 0;
    return Math.max(0, profile.delayMs + jitter);
  }

  /**
   * Deliver one datagram through the flow's profile, if any. Counters only move for
   * datagrams actually handed to a socket, so `toSfu`/`toClient` stay comparable with
   * unshaped runs and profile effects are visible separately in `profileStats()`.
   */
  function shapeSend(port, entry, send) {
    const profile = profiles.get(port);
    if (!profile) {
      send();
      return;
    }
    if (profile.lossPercent > 0 && profile.rng() * 100 < profile.lossPercent) {
      entry.dropped += 1;
      profile.shapedDropped += 1;
      return;
    }
    const delay = shapeDelayMs(profile);
    if (delay <= 0) {
      send();
      return;
    }
    profile.shapedDelayed += 1;
    setTimeout(() => {
      if (isDropped(port)) {
        entry.dropped += 1;
        return;
      }
      send();
    }, delay);
  }
  /**
   * When set, the ONLY source ports carried; every other flow is dropped.
   *
   * A blocklist cannot hold a peer down. Blocking its port works for about twenty seconds, and
   * then ICE restarts, the browser opens a fresh local port, and the relay forwards it happily —
   * the peer is back before the SFU's 10s disconnect grace ever expires (measured: a new port
   * appeared at t+20s carrying thousands of packets). Partitioning one peer therefore has to be
   * expressed as "keep carrying these known-good flows and nothing else", so the peer stays down
   * across however many ports it tries.
   */
  let allowlist = null;

  const keyOf = (address, port) => `${address}:${port}`;
  const isDropped = (port) => blocked.has(port) || (allowlist !== null && !allowlist.has(port));

  function upstreamFor(address, port) {
    const key = keyOf(address, port);
    const existing = clients.get(key);
    if (existing) return existing;

    const socket = dgram.createSocket("udp4");
    const entry = { socket, address, port, toSfu: 0, toClient: 0, dropped: 0 };
    // The SFU answers on this socket; forward it back to the browser this socket belongs to.
    socket.on("message", (message) => {
      if (isDropped(port)) {
        entry.dropped += 1;
        return;
      }
      shapeSend(port, entry, () => {
        entry.toClient += 1;
        inbound.send(message, port, address);
      });
    });
    socket.on("error", () => {});
    clients.set(key, entry);
    return entry;
  }

  inbound.on("message", (message, rinfo) => {
    const key = keyOf(rinfo.address, rinfo.port);
    const entry = upstreamFor(rinfo.address, rinfo.port);
    if (isDropped(rinfo.port)) {
      entry.dropped += 1;
      return;
    }
    shapeSend(rinfo.port, entry, () => {
      entry.toSfu += 1;
      entry.socket.send(message, targetPort, targetHost);
    });
  });
  inbound.on("error", () => {});

  return {
    async start() {
      await new Promise((resolve) => inbound.bind(listenPort, listenHost, resolve));
    },

    /** Stop carrying this peer's datagrams in both directions — the network going away. */
    block(port) {
      blocked.add(port);
    },

    /** The network coming back. */
    unblock(port) {
      blocked.delete(port);
    },

    /**
     * Carry only these source ports; drop everything else, including flows that appear later.
     *
     * This is how one peer is partitioned: pass the ports belonging to everyone *else*.
     */
    allowOnly(ports) {
      allowlist = new Set(ports);
    },

    /** Carry everything again — the network coming back for whoever was cut off. */
    allowAll() {
      allowlist = null;
    },

    unblockAll() {
      blocked.clear();
      allowlist = null;
    },

    /**
     * Shape one flow like a poor network instead of cutting it.
     *
     * `lossPercent` drops that share of datagrams (0-100), `delayMs` holds every kept
     * datagram that long, `jitterMs` spreads the hold uniformly over
     * `delayMs ± jitterMs`, and `seed` makes the loss/jitter draws repeatable per port.
     * Applies to both directions of the flow. Bandwidth shaping is deliberately out of
     * scope: pacing UDP without per-flow queues turns the relay into a bottleneck rather
     * than a network.
     */
    setFlowProfile(
      port,
      { lossPercent = 0, delayMs = 0, jitterMs = 0, seed = 1 } = {},
    ) {
      if (
        !(lossPercent >= 0 && lossPercent <= 100) ||
        !(delayMs >= 0) ||
        !(jitterMs >= 0)
      ) {
        throw new Error(
          `invalid flow profile: ${JSON.stringify({ lossPercent, delayMs, jitterMs, seed })}`,
        );
      }
      profiles.set(port, {
        lossPercent,
        delayMs,
        jitterMs,
        rng: mulberry32(((seed * 2654435761) ^ port) >>> 0),
        shapedDropped: 0,
        shapedDelayed: 0,
      });
    },

    /** Remove every flow profile; partitioning state is untouched. */
    clearFlowProfiles() {
      profiles.clear();
    },

    /** How many datagrams one flow's profile has dropped and delayed so far. */
    profileStats(port) {
      const profile = profiles.get(port);
      return profile
        ? { shapedDropped: profile.shapedDropped, shapedDelayed: profile.shapedDelayed }
        : null;
    },

    /**
     * Which source ports have actually sent through the relay, busiest first.
     *
     * The instrument check: if this is empty, media is not passing through the relay at all and
     * no partition here could mean anything.
     */
    seen() {
      return [...clients.values()]
        .map(({ address, port, toSfu, toClient, dropped }) => ({
          address,
          port,
          toSfu,
          toClient,
          dropped,
        }))
        .sort((a, b) => b.toSfu - a.toSfu);
    },

    counters(port) {
      const entry = [...clients.values()].find((c) => c.port === port);
      return entry ? { toSfu: entry.toSfu, toClient: entry.toClient, dropped: entry.dropped } : null;
    },

    async stop() {
      for (const { socket } of clients.values()) socket.close();
      clients.clear();
      await new Promise((resolve) => inbound.close(resolve));
    },
  };
}
