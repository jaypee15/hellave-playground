/**
 * CLI wrapper over the partition relay for scripted load runs: sits between the load
 * harness and the SFU's advertised media port, forwards everything, and — with
 * `--flap-after-ms`/`--flap-ms` — blocks all flows for one synchronized mass blip at a
 * fixed offset, without needing stdin.
 *
 *   node test/udp-flap-relay-cli.mjs --port 10100 --sfu-port 10000 \
 *     --flap-after-ms 60000 --flap-ms 5000
 *
 * Or stdin line protocol: "block" / "unblock" / "seen" / "stop". Prints a timestamped
 * BLOCKED/UNBLOCKED line for each transition.
 */
import { createInterface } from "node:readline";
import { createPartitionRelay } from "./udp-partition-relay.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? Number(args[index + 1]) : null;
};
const relay = createPartitionRelay({
  listenPort: flag("--port") ?? Number(process.env["FLAP_RELAY_PORT"] ?? 10100),
  targetPort: flag("--sfu-port") ?? 10000,
});

await relay.start();
console.log("relay ready", JSON.stringify({ at: Date.now() }));

const flapAfterMs = flag("--flap-after-ms");
const flapMs = flag("--flap-ms");
if (flapAfterMs !== null && flapMs !== null) {
  setTimeout(async () => {
    relay.allowOnly([]);
    console.log("BLOCKED", JSON.stringify({ at: Date.now() }));
    await new Promise((resolve) => setTimeout(resolve, flapMs));
    relay.allowAll();
    console.log("UNBLOCKED", JSON.stringify({ at: Date.now() }));
  }, flapAfterMs);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const command = line.trim();
  if (command === "block") {
    relay.allowOnly([]);
    console.log("BLOCKED", JSON.stringify({ at: Date.now() }));
  } else if (command === "unblock") {
    relay.allowAll();
    console.log("UNBLOCKED", JSON.stringify({ at: Date.now() }));
  } else if (command === "seen") {
    console.log("SEEN", JSON.stringify(relay.seen()));
  } else if (command === "stop") {
    void relay.stop().then(() => process.exit(0));
  }
});
