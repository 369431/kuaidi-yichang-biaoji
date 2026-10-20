import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { HotkeyService } from "../payload/src/hotkeys.js";
import { normalizeSettings } from "../payload/src/config.js";

const silentLogger = { info() {}, warn() {}, error() {} };
const windowsOnly = process.platform === "win32" ? test : test.skip;

function waitFor(predicate, timeoutMs = 8000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("等待超时"));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function writeFakeHelper(lines) {
  const directory = await mkdtemp(path.join(tmpdir(), "inm-hotkey-"));
  const script = path.join(directory, "fake-helper.ps1");
  await writeFile(script, lines.join("\r\n"), "utf8");
  return { directory, script };
}

windowsOnly("the two-step flow: activator arms, digits pick the reason", async () => {
  const { directory, script } = await writeFakeHelper([
    "Write-Output 'BIND 1 ok'",
    "Write-Output 'BIND 99 ok'",
    "Write-Output 'BIND 100 fail'",
    "Write-Output 'READY'",
    "Start-Sleep -Milliseconds 200",
    "Write-Output 'ARMED'",
    "Start-Sleep -Milliseconds 200",
    "Write-Output 'DISARMED'",
    "Write-Output 'PICK 2'",
    "Start-Sleep -Seconds 5"
  ]);

  const commands = [];
  const service = new HotkeyService({
    logger: silentLogger,
    scriptPath: script,
    onCommand: (command) => commands.push(command)
  });
  try {
    service.start({
      activator: "F9",
      undo: "Ctrl+Alt+Z",
      armSeconds: 5,
      bindings: [{ index: 0, reason: "少件", keys: "Ctrl+Alt+1" }]
    });
    await waitFor(() => service.snapshot.status === "ready");

    const state = service.snapshot;
    assert.deepEqual(state.activator, { keys: "F9", ok: true });
    assert.deepEqual(state.undo, { keys: "Ctrl+Alt+Z", ok: true });
    assert.deepEqual(state.bindings, [{ index: 0, reason: "少件", keys: "Ctrl+Alt+1", ok: false }]);
    assert.match(state.message, /1 个快捷键注册失败/);

    await waitFor(() => commands.length === 1);
    assert.deepEqual(commands[0], { type: "mark", reasonIndex: 1 }, "PICK 2 表示原因清单里的第 2 项");
    assert.equal(service.snapshot.armed, false);
  } finally {
    service.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

windowsOnly("a direct per-reason combination maps back to its reason index", async () => {
  const { directory, script } = await writeFakeHelper([
    "Write-Output 'BIND 1 ok'",
    "Write-Output 'BIND 100 ok'",
    "Write-Output 'READY'",
    "Start-Sleep -Milliseconds 200",
    "Write-Output 'HOTKEY 100'",
    "Start-Sleep -Seconds 5"
  ]);
  const commands = [];
  const service = new HotkeyService({ logger: silentLogger, scriptPath: script, onCommand: (c) => commands.push(c) });
  try {
    service.start({ activator: "F9", undo: "", bindings: [{ index: 0, reason: "少件", keys: "Ctrl+Shift+F5" }] });
    await waitFor(() => service.snapshot.status === "ready");
    await waitFor(() => commands.length === 1);
    assert.deepEqual(commands[0], { type: "mark", reasonIndex: 0 });
  } finally {
    service.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

windowsOnly("without any usable binding the service reports an error", async () => {
  const service = new HotkeyService({ logger: silentLogger, scriptPath: path.join(tmpdir(), "nope.ps1") });
  try {
    service.start({ activator: "", undo: "", bindings: [] });
    await waitFor(() => service.snapshot.status === "error");
    assert.match(service.snapshot.message, /没有可注册的快捷键/);
  } finally {
    service.stop();
  }
});

test("defaults are the two-step flow: F9 arms, digits pick, Ctrl+Alt+Z undoes", () => {
  const defaults = normalizeSettings({});
  assert.equal(defaults.hotkeyActivator, "F9");
  assert.equal(defaults.hotkeyArmSeconds, 8);
  assert.equal(defaults.hotkeyUndo, "Ctrl+Alt+Z");
  assert.deepEqual(defaults.hotkeyBindings, [], "默认不占用每原因一个组合键");
});

test("activator and arming window are normalised", () => {
  const custom = normalizeSettings({ hotkeyActivator: "ctrl+alt+m", hotkeyArmSeconds: 3 });
  assert.equal(custom.hotkeyActivator, "Ctrl+Alt+M");
  assert.equal(custom.hotkeyArmSeconds, 3);

  const bogus = normalizeSettings({ hotkeyActivator: "A", hotkeyArmSeconds: 999 });
  assert.equal(bogus.hotkeyActivator, "F9", "字母不带修饰键的启动键回落到默认");
  assert.equal(bogus.hotkeyArmSeconds, 30, "上限 30 秒");

  const tooSmall = normalizeSettings({ hotkeyArmSeconds: 1 });
  assert.equal(tooSmall.hotkeyArmSeconds, 3);
});

test("optional direct bindings are kept, normalised and deduplicated", () => {
  const settings = normalizeSettings({
    hotkeyBindings: [
      { reason: "少件", keys: "ctrl+shift+f5" },
      { reason: "错件", keys: "Alt+Q" },
      { reason: "多发", keys: "Alt+Q" },
      { reason: "不存在", keys: "Alt+W" }
    ],
    hotkeyUndo: "Ctrl+Alt+Z"
  });
  assert.deepEqual(settings.hotkeyBindings, [
    { reason: "少件", keys: "Ctrl+Shift+F5" },
    { reason: "错件", keys: "Alt+Q" }
  ]);
});
