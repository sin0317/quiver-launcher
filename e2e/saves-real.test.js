/**
 * Save backups in the real app, against the mock catalog: an app is installed and played, the launcher sees where it
 * saved and backs that up, and the Saves tab backs up, restores and survives an uninstall. Runs on Linux and Windows
 * (there with PYTHON=py and NATIVE_DRIVER set to msedgedriver.exe, as live.yml does).
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch } from "./session.js";

const windows = process.platform === "win32";
let s, app, card, until, folder, save, outsideDir, outsideWasThere;

before(async () => {
  const data = mkdtempSync(join(tmpdir(), "quiver-data-"));
  writeFileSync(join(data, "settings.json"), JSON.stringify({ browseShowsLibrary: true, telemetryNoticeSeen: true }));
  s = await launch({ data });
  ({ app, card, until } = s);
  folder = join(s.apps, "test-port");
  save = join(folder, "saves", "slot1.sav");
  // Where the game in the last test keeps a save outside its folder: the app's own localData root.
  // On Windows that's the real %LOCALAPPDATA%, so a folder the test made there goes again at the end.
  outsideDir = join(windows ? process.env.LOCALAPPDATA : `${s.data}-webview`, "Test Port");
  outsideWasThere = existsSync(outsideDir);
});
after(async () => {
  await s?.close();
  if (outsideDir && !outsideWasThere) rmSync(outsideDir, { recursive: true, force: true });
});

/** The manifest inside a backup. Windows ships bsdtar, which reads zips (Git Bash's tar, first on PATH, doesn't). */
const manifestOf = (zip) =>
  windows
    ? execFileSync(join(process.env.SystemRoot, "System32", "tar.exe"), ["-xOf", zip, "quiver-save.json"], { encoding: "utf8" })
    : execFileSync("unzip", ["-p", zip, "quiver-save.json"], { encoding: "utf8" });

/** The backups kept for the app, oldest first, each with its manifest. */
const kept = () => {
  const root = join(s.data, "saves");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((dir) =>
    readdirSync(join(root, dir))
      .filter((f) => f.endsWith(".zip"))
      .sort()
      .map((f) => JSON.parse(manifestOf(join(root, dir, f)))),
  );
};
const panel = () => app.$(".saves-panel");
const groups = () =>
  app.execute(() => [...document.querySelectorAll(".saves-panel .panel-group")].map((g) => [...g.querySelectorAll(".save-row")].map((r) => r.querySelector(".save-main").innerText.trim())));
const said = async () => (await (await panel()).$(".save-said")).getText().catch(() => "");

/**
 * The game: each run writes a save in its own saves folder, with `outside` also a profile under localData. The mock
 * app's zip only holds port.sh, so on Windows the game is a port.cmd beside it, which Play picks when the folder has no
 * .exe (install.rs find_executable).
 */
function game({ outside = false } = {}) {
  if (windows) {
    const lines = ["@echo off", 'cd /d "%~dp0"', "if not exist saves mkdir saves", "echo progress %DATE% %TIME% %RANDOM%> saves\\slot1.sav"];
    if (outside) lines.push('if not exist "%LOCALAPPDATA%\\Test Port" mkdir "%LOCALAPPDATA%\\Test Port"', 'echo profile> "%LOCALAPPDATA%\\Test Port\\profile.dat"');
    writeFileSync(join(folder, "port.cmd"), lines.join("\r\n") + "\r\n");
  } else {
    const extra = outside ? ' && mkdir -p "$XDG_DATA_HOME/Test Port" && echo profile > "$XDG_DATA_HOME/Test Port/profile.dat"' : "";
    writeFileSync(join(folder, "port.sh"), `#!/bin/sh\ncd "$(dirname "$0")" && mkdir -p saves && echo "progress $(date +%s%N)" > saves/slot1.sav${extra}\n`);
    chmodSync(join(folder, "port.sh"), 0o755);
  }
}

async function install() {
  const port = await card("test-port");
  await port.waitForDisplayed({ timeout: 20000 });
  const add = await port.$("button*=Add");
  if (await add.isExisting()) await add.click();
  await s.untilCardShows("test-port", "button*=Install");
  await (await (await card("test-port")).$("button*=Install")).click();
  await until(() => existsSync(join(folder, "port.sh")), 30000);
  game();
}

async function openSaves() {
  await (await (await card("test-port")).$(".card-open")).click();
  await (await app.$('//*[@role="tab"][contains(.,"Saves")]')).click();
  await (await panel()).waitForDisplayed();
}

test("playing an app backs up the saves it wrote, and the Saves tab shows them", async () => {
  await install();
  await s.untilCardShows("test-port", "button*=Play");
  await (await (await card("test-port")).$("button*=Play")).click();
  await until(() => existsSync(save), 20000);
  await until(() => kept().length === 1, 30000);
  const [first] = kept();
  console.log("after playing:", JSON.stringify(first));
  assert.equal(first.reason, "played");
  await openSaves();
  const [places, backups] = await groups();
  console.log("places:", places, "backups:", backups);
  assert.equal(places.length, 1);
  assert.ok(places[0].startsWith(join(folder, "saves")), places[0]);
  assert.match(await (await panel()).getText(), /Quiver saw the app save here\./);
  assert.equal(backups.length, 1);
  assert.match(backups[0], /After playing · 1 file/);
  // With usage data on, the catalog is told the folder once: the system and a path under its folder, nothing else.
  const system = windows ? "windows" : "linux";
  await until(() => s.api.saveReports().length === 1, 10000);
  console.log("reported:", JSON.stringify(s.api.saveReports()));
  assert.deepEqual(s.api.saveReports(), [{ slug: "test-port", os: system, places: ["app/saves"] }]);
});

test("Back up now, then Restore puts the earlier save back and keeps the one it replaced", async () => {
  const original = readFileSync(save, "utf8");
  await (await (await panel()).$("button*=Back up now")).click();
  await until(async () => (await said()) === "Nothing changed since the last backup.");
  writeFileSync(save, "ruined\n");
  await (await (await panel()).$("button*=Back up now")).click();
  await until(async () => (await said()) === "Backed up.");
  assert.equal(kept().length, 2);
  // The older one is the second row.
  const rows = await (await panel()).$$(".panel-group:nth-child(2) .save-row");
  assert.equal(rows.length, 2);
  await (await rows[1].$("button*=Restore")).click();
  await (await (await panel()).$(".save-button.primary")).click();
  await until(async () => (await said()) === "Restored.");
  assert.equal(readFileSync(save, "utf8"), original);
  const all = kept();
  console.log("reasons:", all.map((b) => b.reason));
  assert.deepEqual(all.map((b) => b.reason), ["played", "manual"], "the saves replaced were the newest backup already, so no other is made");
  assert.equal((await groups())[1].length, 2);
});

test("uninstalling backs the saves up first, and they come back after installing again", async () => {
  const original = readFileSync(save, "utf8");
  writeFileSync(save, "further\n");
  await (await app.$("button.danger*=Uninstall")).click();
  const dialog = await app.$("[role=dialog]");
  await dialog.waitForDisplayed();
  const buttons = await dialog.$$("button");
  for (const b of buttons) if (/^Uninstall/.test(await b.getText())) { await b.click(); break; }
  await until(() => !existsSync(folder), 20000);
  const all = kept();
  console.log("reasons:", all.map((b) => b.reason));
  assert.equal(all.at(-1).reason, "uninstall");
  assert.equal(all.length, 3);
  // Back to the catalog and installed again: nothing of the saves is in the new folder until one is restored.
  const back = await app.$(".page-layer:not([hidden]) button.back-link");
  if (await back.isExisting()) await back.click();
  await install();
  assert.ok(!existsSync(save));
  await openSaves();
  const [, backups] = await groups();
  console.log("backups after installing again:", backups);
  assert.equal(backups.length, 3);
  const rows = await (await panel()).$$(".panel-group:nth-child(2) .save-row");
  await (await rows[0].$("button*=Restore")).click();
  await (await (await panel()).$(".save-button.primary")).click();
  await until(async () => (await said()) === "Restored.");
  assert.equal(readFileSync(save, "utf8"), "further\n");
  assert.notEqual(original, "further\n");
});

test("saves outside the app's folder are found too, and an update backs the saves up first", async () => {
  const outside = join(outsideDir, "profile.dat");
  game({ outside: true });
  const before = kept().length;
  await (await app.$(".page-layer:not([hidden]) button.back-link")).click();
  await s.untilCardShows("test-port", "button*=Play");
  await (await (await card("test-port")).$("button*=Play")).click();
  await until(() => existsSync(outside), 20000);
  await until(() => kept().length === before + 1, 30000);
  const played = kept().at(-1);
  console.log("after playing:", JSON.stringify(played.places), played.files.map((f) => f.path));
  assert.deepEqual(played.places.map((p) => p.template).sort(), ["app/saves", "localData/Test Port"]);
  // Only the new folder is reported: the first went after the first play, and playing again didn't send it twice.
  await until(() => s.api.saveReports().length === 2, 10000);
  console.log("reported:", JSON.stringify(s.api.saveReports()));
  assert.deepEqual(s.api.saveReports()[1].places, ["localData/Test Port"]);
  // A newer release, with saves changed since the last backup.
  writeFileSync(save, "before the update\n");
  s.api.release("1.1.0");
  await (await app.$("button*=Library")).click();
  await (await app.$("button=Browse")).click();
  await (await app.$(".topbar .downloads-button")).click();
  const row = await app.$(".downloads-page section[aria-label='Updates available'] .download-row");
  await row.waitForDisplayed({ timeout: 30000 });
  await (await row.$("button*=Update to")).click();
  await until(() => kept().at(-1).reason === "update", 30000);
  console.log("reasons:", kept().map((b) => b.reason));
  assert.equal(readFileSync(save, "utf8"), "before the update\n", "the update leaves the saves alone");
  assert.ok(existsSync(outside));
});
