/**
 * Cloud saves in the real app, against the mock catalog and its stand-in for the account and the bucket: two copies of
 * the launcher with their own data folders are two computers signed in to one account. A save made on one is sent to
 * the account, put in place on the other before the app starts, and when both changed the player is asked. Runs on
 * Linux and Windows (there with PYTHON=py and NATIVE_DRIVER set to msedgedriver.exe, as live.yml does).
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch } from "./session.js";
import { startMockApi } from "./mock-api.js";

const windows = process.platform === "win32";
const ENTRY = "entry_test-port";
let api, a, b;

/** One computer: its launcher, and the app's folder, save and what the game saw there when it last started. */
async function computer(name) {
  const data = mkdtempSync(join(tmpdir(), `quiver-${name}-`));
  writeFileSync(join(data, "settings.json"), JSON.stringify({ browseShowsLibrary: true, telemetryNoticeSeen: true }));
  const s = await launch({ data, api });
  const folder = join(s.apps, "test-port");
  return { name, s, app: s.app, folder, save: join(folder, "saves", "slot1.sav"), seen: join(folder, "seen.txt") };
}

before(async () => {
  api = await startMockApi();
  a = await computer("first");
  b = await computer("second");
});
after(async () => {
  await a?.s.close();
  await b?.s.close();
  api?.close();
});

const read = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim() : null);
const stored = () => api.cloudSaves.rows.filter((r) => r.status === "stored").sort((x, y) => x.createdAt - y.createdAt);

/**
 * The game: each run notes the save it found (seen.txt, "none" without one), then writes a new one. The mock app's
 * zip only holds port.sh, so on Windows the game is a port.cmd beside it, which Play picks when there's no .exe.
 */
function game(c) {
  if (windows) {
    const lines = [
      "@echo off",
      'cd /d "%~dp0"',
      "if not exist saves mkdir saves",
      "if exist saves\\slot1.sav (copy /y saves\\slot1.sav seen.txt >nul) else (echo none> seen.txt)",
      `echo ${c.name} %DATE% %TIME% %RANDOM%> saves\\slot1.sav`,
    ];
    writeFileSync(join(c.folder, "port.cmd"), lines.join("\r\n") + "\r\n");
  } else {
    const script = `#!/bin/sh\ncd "$(dirname "$0")" && mkdir -p saves && { [ -f saves/slot1.sav ] && cp saves/slot1.sav seen.txt || echo none > seen.txt; } && echo "${c.name} $(date +%s%N)" > saves/slot1.sav\n`;
    writeFileSync(join(c.folder, "port.sh"), script);
    chmodSync(join(c.folder, "port.sh"), 0o755);
  }
}

async function signIn(c, create) {
  const { app } = c;
  await (await (await app.$(".account")).$("button*=Sign in")).click();
  const form = await app.$("form");
  await form.waitForDisplayed();
  if (create) await (await app.$("button=Create an account")).click();
  await (await app.$('input[autocomplete="username"]')).setValue("player");
  await (await app.$('input[type="password"]')).setValue("a long enough password");
  await (await form.$("button.primary")).click();
  // The button's label, not its text: in a narrow window the name is hidden and only the icon shows.
  await c.s.until(async () => ((await (await app.$(".account-button")).getAttribute("aria-label").catch(() => "")) ?? "").includes("player"), 20000);
}

async function install(c) {
  const port = await c.s.card("test-port");
  await port.waitForDisplayed({ timeout: 20000 });
  const add = await port.$("button*=Add");
  if (await add.isExisting()) await add.click();
  await c.s.untilCardShows("test-port", "button*=Install");
  await (await (await c.s.card("test-port")).$("button*=Install")).click();
  await c.s.until(() => existsSync(join(c.folder, "port.sh")), 30000);
  game(c);
  await c.s.untilCardShows("test-port", "button*=Play");
}

/** Presses Play and waits for the game to have run: it writes a new save each time. */
async function play(c, { answer } = {}) {
  const before = read(c.save);
  await (await (await c.s.card("test-port")).$("button*=Play")).click();
  if (answer) {
    const dialog = await c.app.$(".saves-conflict");
    await dialog.waitForDisplayed({ timeout: 20000 });
    console.log(`${c.name} was asked:`, (await dialog.getText()).replace(/\s+/g, " "));
    await (await dialog.$(`button*=${answer}`)).click();
  }
  // A copy put in place changes the save too, so wait for one this computer's game wrote.
  await c.s.until(() => read(c.save) !== before && (read(c.save) ?? "").startsWith(`${c.name} `), 30000);
  return read(c.save);
}

async function savesTab(c) {
  await (await (await c.s.card("test-port")).$(".card-open")).click();
  await (await c.app.$('//*[@role="tab"][contains(.,"Saves")]')).click();
  const cloud = await c.app.$(".saves-panel .cloud-saves");
  await cloud.waitForDisplayed();
  return cloud;
}
const back = async (c) => (await c.app.$(".page-layer:not([hidden]) button.back-link")).click();

test("a save made on one computer is sent to the account", async () => {
  await signIn(a, true);
  await install(a);
  const first = await play(a);
  assert.equal(read(a.seen), "none");
  await a.s.until(() => stored().length === 1, 30000);
  const [row] = stored();
  console.log("in the account:", JSON.stringify({ ...row, key: undefined }));
  assert.equal(row.entryId, ENTRY);
  assert.equal(row.os, windows ? "windows" : "linux");
  assert.equal(row.reason, "played");
  assert.equal(api.cloudSaves.objects.get(row.id).length, row.size, "the whole zip arrived");
  assert.ok(first.startsWith("first "));
  const cloud = await savesTab(a);
  await a.s.until(async () => (await cloud.$$(".cloud-row")).length === 1, 10000);
  console.log("first computer's Saves tab:", (await cloud.getText()).replace(/\s+/g, " "));
  assert.match(await cloud.getText(), /of 250(\.0)? MB used/);
  await back(a);
});

test("the other computer gets it before the app starts, and sends its own back", async () => {
  const fromFirst = read(a.save);
  await signIn(b, false);
  await install(b);
  assert.equal(read(b.save), null, "nothing here until the app is played");
  const second = await play(b);
  // The game found the first computer's save where it looks for its own.
  assert.equal(read(b.seen), fromFirst);
  assert.ok(second.startsWith("second "));
  await b.s.until(() => stored().length === 2, 30000);
  // Back on the first computer, whose saves haven't changed since they were sent: the newer ones are put in place.
  const again = await play(a);
  assert.equal(read(a.seen), second);
  assert.ok(again.startsWith("first "));
  await a.s.until(() => stored().length === 3, 30000);
  // What was there before is kept as a backup.
  const cloud = await savesTab(a);
  const panel = await a.app.$(".saves-panel");
  console.log("first computer's backups:", (await panel.getText()).replace(/\s+/g, " ").slice(0, 600));
  await a.s.until(async () => (await cloud.$$(".cloud-row")).length === 3, 10000);
  await back(a);
});

test("when both computers changed, Play asks which saves to keep", async () => {
  const fromFirst = read(a.save);
  // The second computer played offline: its saves moved on from what the account last had from it.
  writeFileSync(b.save, "second, offline\n");
  await play(b, { answer: "Use my cloud saves" });
  assert.equal(read(b.seen), fromFirst);
  await b.s.until(() => stored().length === 4, 30000);
  const fromSecond = read(b.save);
  // And the other way: the first computer keeps its own, which then become the account's newest.
  writeFileSync(a.save, "first, offline\n");
  await play(a, { answer: "Keep this computer" });
  assert.equal(read(a.seen), "first, offline");
  assert.notEqual(read(a.seen), fromSecond);
  // Five copies an app: the oldest went as newer ones arrived.
  await a.s.until(() => stored().length === 5 && stored().at(-1).hash !== undefined, 30000);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  console.log("copies in the account:", stored().length, "objects:", api.cloudSaves.objects.size);
  assert.equal(stored().length, 5);
  assert.equal(api.cloudSaves.objects.size, 5);
});

test("a full account keeps the backup on the computer and says so, and switching an app off stops sending", async () => {
  // No room for another copy, even counting the oldest one it would push out.
  api.cloudSaves.limit = 100;
  const newest = () => stored().at(-1).id;
  const was = newest();
  await play(b);
  // The launcher says so once, and Not now leaves everything as it is.
  const full = await b.app.$(".saves-full");
  await full.waitForDisplayed({ timeout: 30000 });
  await (await full.$("button*=Not now")).click();
  await full.waitForExist({ reverse: true, timeout: 10000 });
  const cloud = await savesTab(b);
  await b.s.until(async () => /cloud saves are full/i.test(await cloud.getText()), 30000);
  console.log("second computer, full:", (await cloud.getText()).replace(/\s+/g, " ").slice(0, 300));
  assert.equal(newest(), was);
  // Room again, and the app switched off on this computer: nothing is sent.
  api.cloudSaves.limit = 250 * 1024 * 1024;
  await (await cloud.$("input[type=checkbox]")).click();
  await b.s.until(async () => !(await (await b.app.$(".saves-panel .cloud-saves input[type=checkbox]")).isSelected()), 10000);
  await back(b);
  await play(b);
  await new Promise((resolve) => setTimeout(resolve, 4000));
  assert.equal(newest(), was);
});

test("Settings, Cloud saves shows what the account keeps, and restores, sends and removes from there", async () => {
  const { app } = a;
  const rows = () => app.$$(".settings-pane .cloud-row");
  const paneText = async () => (await (await app.$(".settings-pane")).getText()).replace(/\s+/g, " ");
  const actions = () => app.$(".settings-pane .cloud-app-actions");
  await (await app.$("button.settings-button")).click();
  await (await app.$('.settings-nav button[data-section="cloud"]')).click();
  await (await app.$(".settings-pane .storage-bar")).waitForDisplayed({ timeout: 10000 });
  console.log("Settings, Cloud saves:", (await paneText()).slice(0, 400));
  assert.match(await paneText(), /of 250(\.0)? MB used\. Each app keeps its newest 5 copies\./);
  const appRow = await app.$(".settings-pane .cloud-app-row");
  assert.match((await appRow.getText()).replace(/\s+/g, " "), /Test Port.*5 copies/);
  await appRow.click();
  await a.s.until(async () => (await rows()).length === 5, 10000);
  assert.ok(await (await appRow.$(".cloud-app-icon")).isDisplayed(), "the app's icon is in its row");

  // App page opens the app's page over Settings, and Back returns to the list.
  await (await (await actions()).$("button*=App page")).click();
  await (await app.$('.page-layer:not([hidden]) section.app-page[aria-label="Test Port"]')).waitForDisplayed({ timeout: 10000 });
  await back(a);
  await (await app.$(".settings-pane .storage-bar")).waitForDisplayed({ timeout: 10000 });
  if (!(await rows()).length) await (await app.$(".settings-pane .cloud-app-row")).click();
  await a.s.until(async () => (await rows()).length === 5, 10000);

  // Restoring the oldest copy puts its saves in place.
  const here = read(a.save);
  await (await (await rows())[4].$("button*=Restore")).click();
  await (await app.$(".settings-pane .save-button.primary")).click();
  await a.s.until(async () => (await paneText()).includes("Restored."), 30000);
  assert.notEqual(read(a.save), here);
  console.log("restored on the first computer:", read(a.save));

  // New saves, sent from here without playing.
  writeFileSync(a.save, "first, sent from settings\n");
  const before = stored().at(-1).id;
  await (await (await actions()).$("button*=Send saves now")).click();
  await a.s.until(async () => (await paneText()).includes("Sent to your cloud saves."), 30000);
  assert.notEqual(stored().at(-1).id, before);
  assert.equal(stored().length, 5);

  // One copy removed, then all of them after the question.
  await (await (await rows())[0].$('button[aria-label="Remove this copy from your account"]')).click();
  await a.s.until(async () => (await rows()).length === 4 && stored().length === 4, 10000);
  await (await (await actions()).$("button*=Remove all copies")).click();
  assert.equal(stored().length, 4, "nothing goes before the answer");
  await (await (await actions()).$("button.danger")).click();
  await a.s.until(async () => stored().length === 0 && (await paneText()).includes("Nothing in your account yet"), 10000);
  assert.equal(api.cloudSaves.objects.size, 0);
  assert.equal(read(a.save), "first, sent from settings", "the saves on the computer aren't touched");

  // Paused by Quiver: the page says so.
  api.cloudSaves.why = "paused";
  await (await app.$('.settings-nav button[data-section="general"]')).click();
  await (await app.$('.settings-nav button[data-section="cloud"]')).click();
  await a.s.until(async () => (await paneText()).includes("Cloud saves are paused for now"), 10000);
  api.cloudSaves.why = undefined;
  await back(a);
});

test("a full account is said once, Free up space leads to the copies, and the backup is sent once there's room", async () => {
  const { app } = a;
  const dialog = () => app.$(".saves-full");
  // One copy in the account, and room for no more than it.
  await play(a);
  await a.s.until(() => stored().length === 1, 30000);
  const first = stored()[0];
  api.cloudSaves.keep = 5;
  api.cloudSaves.limit = first.size + 10;
  await play(a);
  await (await dialog()).waitForDisplayed({ timeout: 30000 });
  const asked = (await (await dialog()).getText()).replace(/\s+/g, " ");
  console.log("full account:", asked);
  assert.ok(asked.includes("Your cloud saves are full"));
  assert.ok(asked.includes("Turn off cloud saves for Test Port"));
  assert.equal(stored().length, 1);
  assert.equal(stored()[0].id, first.id);

  // Free up space opens Settings at Cloud saves. Removing the copy there makes room, and what didn't fit goes up.
  await (await (await dialog()).$("button*=Free up space")).click();
  await (await app.$(".settings-pane .storage-bar")).waitForDisplayed({ timeout: 10000 });
  await (await app.$(".settings-pane .cloud-app-row")).click();
  await (await app.$('.settings-pane button[aria-label="Remove this copy from your account"]')).click();
  await a.s.until(() => stored().length === 1 && stored()[0].id !== first.id, 30000);
  console.log("sent once there was room:", stored()[0].id);
  await back(a);

  // Full again after a backup got there: asked again, and this time the app is switched off and its copies go.
  const second = stored()[0];
  await play(a);
  await (await dialog()).waitForDisplayed({ timeout: 30000 });
  await (await (await dialog()).$("button*=Turn off cloud saves for Test Port")).click();
  await a.s.until(() => stored().length === 0, 20000);
  assert.notEqual(second.id, undefined);
  const cloud = await savesTab(a);
  await a.s.until(async () => !(await (await cloud.$("input[type=checkbox]")).isSelected()), 10000);
  // Off now: playing sends nothing, and nothing is asked.
  await back(a);
  await play(a);
  await new Promise((resolve) => setTimeout(resolve, 4000));
  assert.equal(stored().length, 0);
  assert.equal(await (await dialog()).isExisting(), false);
});
