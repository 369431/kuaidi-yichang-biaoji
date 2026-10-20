import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_REASONS, SettingsStore, normalizeHost, normalizeSettings, sanitizeIdentifier } from "../payload/src/config.js";

test("defaults are usable without a settings file", () => {
  const settings = normalizeSettings({});
  assert.equal(settings.host, "http://127.0.0.1:5280");
  assert.equal(settings.panelPort, 8792);
  assert.deepEqual(settings.reasons, DEFAULT_REASONS);
  assert.equal(settings.watermarkNamespace, "异常");
  assert.equal(settings.watermarkField, "内物不符");
});

test("host input is normalised and paths are rejected", () => {
  assert.equal(normalizeHost("127.0.0.1:5280"), "http://127.0.0.1:5280");
  assert.equal(normalizeHost("http://192.168.1.9:5280/"), "http://192.168.1.9:5280");
  assert.throws(() => normalizeHost("http://127.0.0.1:5280/api"), /不要带路径/);
  assert.throws(() => normalizeHost("   "), /不能为空/);
});

test("invalid values fall back instead of breaking the adapter", () => {
  const settings = normalizeSettings({
    host: "not a url",
    panelPort: 99,
    pollIntervalMs: 5,
    reasons: ["少件", "", "少件", "x".repeat(60), 5],
    watermarkField: "内物 不符!",
    operator: "  张三  "
  });
  assert.equal(settings.host, "http://127.0.0.1:5280");
  assert.equal(settings.panelPort, 8792);
  assert.equal(settings.pollIntervalMs, 400);
  assert.deepEqual(settings.reasons, ["少件"]);
  assert.equal(settings.operator, "张三");
  assert.equal(settings.watermarkField, "内物不符");
});

test("watermark identifiers keep letters, numbers and separators only", () => {
  assert.equal(sanitizeIdentifier("异常", "x"), "异常");
  assert.equal(sanitizeIdentifier("a b!c", "x"), "abc");
  assert.equal(sanitizeIdentifier("", "fallback"), "fallback");
});

test("settings round-trip through settings.json", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "inm-settings-"));
  try {
    const store = new SettingsStore(directory);
    await store.load();
    await store.update({ operator: "李四", reasons: ["少件", "错件"] });
    const raw = await readFile(path.join(directory, "settings.json"), "utf8");
    assert.equal(JSON.parse(raw).operator, "李四");

    const reloaded = new SettingsStore(directory);
    const settings = await reloaded.load();
    assert.equal(settings.operator, "李四");
    assert.deepEqual(settings.reasons, ["少件", "错件"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
