/**
 * FEC negotiation verification: join a meeting and read the negotiated SDP from both
 * sides, checking whether Opus in-band FEC / DTX fmtp lines survive SFU negotiation.
 *
 *   node --env-file-if-exists=.env test/fec-verify.mjs
 */
import { describe, it, before, after } from "node:test";
import { createHarness, waitFor } from "./harness.mjs";

const harness = createHarness({ port: 3099 });

describe("opus fec negotiation", () => {
  before(() => harness.start());
  after(async () => {
    await harness.closeOpenContexts();
    await harness.stop();
  });

  it("negotiates opus with in-band fec against production", async () => {
    const page = await harness.newPage("fec");
    const roomInstanceId = await harness.createRoom(page, "fec-probe");
    await harness.publishMic(page, "fec");

    // Wait until media is flowing so negotiation has certainly completed.
    await waitFor(
      () => page.evaluate(() => {
        const pc = window.__hellavePCs?.[0];
        return pc ? pc.connectionState : "none";
      }),
      (state) => state === "connected",
      30_000,
      "media peer never connected",
    );

    const sdp = await page.evaluate(() => ({
      local: window.__hellavePCs[0].localDescription?.sdp ?? "",
      remote: window.__hellavePCs[0].remoteDescription?.sdp ?? "",
    }));

    const opus = (sdpText) =>
      sdpText.split("\n").filter((line) => line.includes("opus"));
    console.log("=== LOCAL OFFER (opus lines) ===\n" + opus(sdp.local).join("\n"));
    console.log("=== REMOTE ANSWER (opus/fmtp lines) ===\n" + opus(sdp.remote).join("\n"));

    const result = {
      localOfferHasFec: /useinbandfec=1/.test(sdp.local),
      remoteAnswerHasFec: /useinbandfec=1/.test(sdp.remote),
      remoteAnswerHasDtx: /usedtx=1/.test(sdp.remote),
    };
    console.log("VERDICT:", JSON.stringify(result));
  });
});
