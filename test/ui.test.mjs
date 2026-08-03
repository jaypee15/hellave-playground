/**
 * UI test: the meeting screen renders and every control is reachable.
 *
 * This exists because audio.test.mjs is the only other test that drives the browser, and it
 * cannot pass until inbound UDP 10000 is open — which would otherwise leave the entire
 * interface unverified. Nothing here needs media to cross the network: it asserts the layout,
 * the controls, the panels, and the selectors that the media test depends on.
 *
 *   npm run test:ui
 *
 * Requires a build (`npm run build`) — the express server serves dist/ and /api on one origin.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

const API_KEY = process.env["HELLAVE_API_KEY"];
const PORT = Number(process.env["UI_PORT"] ?? 3097);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CASE_TIMEOUT = { timeout: 120_000 };

let server;
let browser;
let shuttingDown = false;

async function newPage(label) {
  const context = await browser.newContext({ permissions: ["microphone", "camera"] });
  const page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") process.stderr.write(`[${label}] ${msg.text()}\n`);
  });
  return page;
}

/** Create a room through the UI and land in the meeting screen. */
async function hostInRoom(name = "ui-host") {
  const page = await newPage(name);
  await page.goto(ORIGIN);
  await page.getByRole("button", { name: "Create a Room" }).click();
  await page.getByPlaceholder("Your name").fill(name);
  await page.getByRole("button", { name: /Create & Join|Creating/ }).click();
  await page.getByTestId("room-instance-id").waitFor({ timeout: 60_000 });
  // The room id renders as soon as attach resolves, but chat, hands and reactions are only
  // accepted from an admitted attachment — and the controls are disabled until then.
  await page.getByTestId("conference-state").getByText("admitted").waitFor({ timeout: 60_000 });
  return page;
}

describe("playground interface", () => {
  before(async () => {
    assert.ok(API_KEY, "HELLAVE_API_KEY must be set");
    assert.ok(
      existsSync(new URL("../dist/index.html", import.meta.url)),
      "dist/ is missing — run `npm run build` first",
    );

    server = spawn("npx", ["tsx", "server/index.ts"], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    server.stderr.on("data", (chunk) => { stderr += chunk; });
    server.once("exit", (code, signal) => {
      if (shuttingDown || code === 0 || code === null || code === 143 || signal) return;
      throw new Error(`playground server exited with ${code}: ${stderr}`);
    });

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        await fetch(`${ORIGIN}/`);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    browser = await chromium.launch({
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
  });

  after(async () => {
    if (browser) await browser.close().catch(() => {});
    if (server && server.exitCode === null) {
      shuttingDown = true;
      server.kill("SIGTERM");
      await Promise.race([
        once(server, "exit").catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
  });

  it("offers the home screen's two entry points", CASE_TIMEOUT, async () => {
    const page = await newPage("home");
    await page.goto(ORIGIN);

    await page.getByRole("button", { name: "Create a Room" }).waitFor();
    await page.getByRole("button", { name: "Join a Room" }).waitFor();

    // The join form is what a second participant uses, and the media test fills it by
    // placeholder.
    await page.getByRole("button", { name: "Join a Room" }).click();
    await page.getByPlaceholder("Room Instance ID").waitFor();
    await page.getByPlaceholder("Your name").waitFor();
  });

  it("renders the meeting screen with a grid and a control bar", CASE_TIMEOUT, async () => {
    const page = await hostInRoom();

    await page.getByTestId("video-grid").waitFor({ timeout: 30_000 });

    // Every control the meeting screen is supposed to offer, addressed the way a screen
    // reader would: an icon button with no accessible name is unusable.
    for (const name of ["Publish Mic", "Start camera", "Share screen", "Raise Hand", "Chat", "Leave"]) {
      await page.getByRole("button", { name }).waitFor({ timeout: 15_000 });
    }
  });

  it("keeps the selectors the media test depends on visible, not hidden in a drawer", CASE_TIMEOUT, async () => {
    // innerText returns empty for hidden elements, so these two must stay in the header.
    const page = await hostInRoom("ui-selectors");

    const instanceId = await page.getByTestId("room-instance-id").innerText();
    assert.match(instanceId, /^[0-9a-f-]{36}$/, `expected a room instance UUID, got ${instanceId}`);

    // The host token grants recording, so the button must be offered.
    await page.getByTestId("recording-toggle").waitFor({ timeout: 15_000 });
  });

  it("opens the chat panel and sends a message", CASE_TIMEOUT, async () => {
    const page = await hostInRoom("ui-chat");

    await page.getByTestId("chat-toggle").click();
    await page.getByTestId("side-panel").waitFor();

    await page.getByPlaceholder("Send a message").fill("hello from the ui test");
    await page.getByRole("button", { name: "Send" }).click();

    // Echoed locally, because the Public Edge broadcasts to everyone except the sender.
    // Waited for rather than read once: React renders after the click resolves.
    await page.getByTestId("chat-log").getByText("hello from the ui test").waitFor({
      timeout: 15_000,
    });

    // The People tab lists the roster from the same snapshot the grid uses.
    await page.getByRole("button", { name: /people/i }).click();
    await page.getByTestId("people-list").waitFor();
  });

  it("shows reactions and raises a hand", CASE_TIMEOUT, async () => {
    const page = await hostInRoom("ui-reactions");

    await page.getByTestId("reactions-toggle").click();
    await page.getByTestId("reaction-picker").waitFor();
    await page.getByRole("button", { name: "thumbs_up" }).click();
    // The overlay is always mounted; the reaction appears inside it and then fades.
    await page.getByTestId("reactions").waitFor();

    const hand = page.getByTestId("hand-toggle");
    await hand.click();
    await page.getByRole("button", { name: "Lower Hand" }).waitFor({ timeout: 15_000 });
  });

  it("hides diagnostics behind the debug drawer", CASE_TIMEOUT, async () => {
    const page = await hostInRoom("ui-debug");

    assert.equal(
      await page.getByTestId("debug-drawer").count(),
      0,
      "the debug drawer must start closed so the meeting screen stays clean",
    );

    await page.getByTestId("debug-toggle").click();
    await page.getByTestId("debug-drawer").waitFor();
    const contents = await page.getByTestId("debug-drawer").innerText();
    assert.match(contents, /Attaching to room/, "expected the event log inside the drawer");
  });

  it("switches between grid and speaker view", CASE_TIMEOUT, async () => {
    const page = await hostInRoom("ui-view");

    await page.getByTestId("video-grid").waitFor({ timeout: 30_000 });
    await page.getByTestId("view-toggle").click();
    await page.getByTestId("speaker-view").waitFor();
    await page.getByTestId("view-toggle").click();
    await page.getByTestId("video-grid").waitFor();
  });

  it("publishes a camera and shows it in the local tile", CASE_TIMEOUT, async () => {
    // Chromium's fake device makes this work without hardware. It proves the capture and
    // publish path only — remote video still needs inbound UDP 10000.
    const page = await hostInRoom("ui-camera");

    await page.getByRole("button", { name: "Start camera" }).click();
    await page.getByRole("button", { name: "Stop camera" }).waitFor({ timeout: 60_000 });

    const playing = await page.evaluate(async () => {
      const video = document.querySelector("video");
      if (!video) return { found: false };
      for (let attempt = 0; attempt < 40 && video.readyState < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return { found: true, readyState: video.readyState, width: video.videoWidth };
    });
    assert.ok(playing.found, "expected a video element for the local camera");
    assert.ok(playing.width > 0, `expected decoded frames, got ${JSON.stringify(playing)}`);
  });

  // Rooms have no names, so the only way to invite somebody used to be reading a 36-character
  // uuid off the header and retyping it. The link has to actually round-trip for that to change.
  it("shares a room by link, and the link fills the join form in", async () => {
    const host = await hostInRoom("invite-host");
    const roomInstanceId = await host.getByTestId("room-instance-id").innerText();

    // The address bar becomes the invite the moment the room exists, whether or not anyone
    // presses the button.
    const shared = new URL(host.url());
    assert.equal(
      shared.searchParams.get("room"),
      roomInstanceId,
      "the room should be in the address bar once the meeting screen is up",
    );

    // Copying is granted rather than stubbed, so this exercises the real clipboard path.
    await host.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await host.getByTestId("copy-invite").click();
    await host.getByTestId("copy-invite").getByText("Copied").waitFor({ timeout: 10_000 });
    const copied = await host.evaluate(() => navigator.clipboard.readText());
    assert.equal(new URL(copied).searchParams.get("room"), roomInstanceId);

    // What the invited person sees: the join form, already knowing the room.
    const guest = await newPage("invite-guest");
    await guest.goto(copied);
    await guest.getByText("You have been invited").waitFor({ timeout: 30_000 });
    assert.equal(
      await guest.getByTestId("join-room-instance-id").inputValue(),
      roomInstanceId,
      "the invited page should not ask for a room it was told about",
    );

    // And it is a working invite, not just a filled field.
    await guest.getByPlaceholder("Your name").fill("invite-guest");
    await guest.getByRole("button", { name: /^Join$|Joining/ }).click();
    await guest.getByTestId("room-instance-id").waitFor({ timeout: 60_000 });
    assert.equal(await guest.getByTestId("room-instance-id").innerText(), roomInstanceId);
  });
});
