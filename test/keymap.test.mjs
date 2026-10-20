import assert from "node:assert/strict";
import test from "node:test";
import { formatKeySpec, isValidKeySpec, parseKeySpec } from "../payload/src/keymap.js";

test("modifier + key specs map to a Win32 modifier mask and virtual key", () => {
  const spec = parseKeySpec("Ctrl+Alt+1");
  assert.equal(spec.ok, true);
  assert.equal(spec.vk, 0x31);
  assert.equal(spec.modifiers, 0b0011); // Alt=1, Ctrl=2
  assert.equal(spec.label, "Ctrl+Alt+1");

  const functionKey = parseKeySpec("Ctrl+Shift+F5");
  assert.equal(functionKey.vk, 0x74); // F5 = VK_F5
  assert.equal(functionKey.modifiers, 0b0110); // Ctrl=2, Shift=4
  assert.equal(functionKey.label, "Ctrl+Shift+F5");
});

test("the canonical label always orders modifiers the same way", () => {
  assert.equal(parseKeySpec("shift+ctrl+a").label, "Ctrl+Shift+A");
  assert.equal(parseKeySpec("ALT+win+q").label, "Alt+Win+Q");
  assert.equal(parseKeySpec("control+option+z").label, "Ctrl+Alt+Z");
  assert.equal(formatKeySpec({ modifiers: 0b1001, keyLabel: "F2" }), "Alt+Win+F2");
});

test("function and navigation keys may stand alone, letters and digits may not", () => {
  assert.equal(parseKeySpec("F8").ok, true);
  assert.equal(parseKeySpec("F24").ok, true);
  assert.equal(parseKeySpec("PageDown").ok, true);
  assert.equal(parseKeySpec("Space").ok, true);

  const bare = parseKeySpec("A");
  assert.equal(bare.ok, false);
  assert.match(bare.error, /必须配合/);
  assert.equal(parseKeySpec("5").ok, false);
});

test("nonsense specs are rejected with a message instead of crashing the adapter", () => {
  assert.equal(parseKeySpec("").ok, false);
  assert.equal(parseKeySpec("Ctrl+").ok, false);
  assert.equal(parseKeySpec("Ctrl+Alt+Ctrl").ok, false);
  assert.equal(parseKeySpec("Ctrl+Alt+A+B").ok, false);
  assert.equal(parseKeySpec("Ctrl+Hyper+1").ok, false);
  assert.equal(parseKeySpec("F25").ok, false);
});

test("validity helper agrees with the parser", () => {
  assert.equal(isValidKeySpec("Ctrl+Alt+6"), true);
  assert.equal(isValidKeySpec("Ctrl+Alt+Nope"), false);
});
