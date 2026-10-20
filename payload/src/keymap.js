/**
 * Hotkey key specs, e.g. "Ctrl+Alt+1", "Ctrl+Shift+F5", "F8".
 *
 * Windows RegisterHotKey needs a modifier bitmask plus a virtual-key code, so every spec is parsed
 * into that pair and re-formatted for display. Rules that keep people out of trouble:
 *   - letters and digits must carry at least one modifier (a bare "A" would swallow typing)
 *   - function keys and navigation keys may stand alone
 */

export const MODIFIER_BITS = Object.freeze({ alt: 1, ctrl: 2, shift: 4, win: 8 });

const MODIFIER_ALIASES = new Map([
  ["ctrl", "ctrl"],
  ["control", "ctrl"],
  ["alt", "alt"],
  ["option", "alt"],
  ["shift", "shift"],
  ["win", "win"],
  ["meta", "win"],
  ["super", "win"],
  ["cmd", "win"],
  ["command", "win"]
]);

const MODIFIER_LABELS = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", win: "Win" };
const MODIFIER_ORDER = ["ctrl", "alt", "shift", "win"];

const NAMED_KEYS = new Map([
  ["space", { vk: 0x20, label: "Space", requiresModifier: false }],
  ["tab", { vk: 0x09, label: "Tab", requiresModifier: false }],
  ["enter", { vk: 0x0d, label: "Enter", requiresModifier: false }],
  ["esc", { vk: 0x1b, label: "Esc", requiresModifier: false }],
  ["escape", { vk: 0x1b, label: "Esc", requiresModifier: false }],
  ["backspace", { vk: 0x08, label: "Backspace", requiresModifier: false }],
  ["insert", { vk: 0x2d, label: "Insert", requiresModifier: false }],
  ["delete", { vk: 0x2e, label: "Delete", requiresModifier: false }],
  ["del", { vk: 0x2e, label: "Delete", requiresModifier: false }],
  ["home", { vk: 0x24, label: "Home", requiresModifier: false }],
  ["end", { vk: 0x23, label: "End", requiresModifier: false }],
  ["pageup", { vk: 0x21, label: "PageUp", requiresModifier: false }],
  ["pagedown", { vk: 0x22, label: "PageDown", requiresModifier: false }],
  ["up", { vk: 0x26, label: "Up", requiresModifier: false }],
  ["down", { vk: 0x28, label: "Down", requiresModifier: false }],
  ["left", { vk: 0x25, label: "Left", requiresModifier: false }],
  ["right", { vk: 0x27, label: "Right", requiresModifier: false }]
]);

function resolveMainKey(token) {
  const value = String(token || "").trim();
  if (!value) return null;

  if (/^[0-9]$/.test(value)) {
    return { vk: 0x30 + Number(value), label: value, requiresModifier: true };
  }
  if (/^[a-z]$/i.test(value)) {
    return { vk: 0x41 + (value.toUpperCase().charCodeAt(0) - 65), label: value.toUpperCase(), requiresModifier: true };
  }
  const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(value);
  if (functionKey) {
    const index = Number(functionKey[1]);
    return { vk: 0x6f + index, label: `F${index}`, requiresModifier: false };
  }
  return NAMED_KEYS.get(value.toLowerCase()) || null;
}

/** Returns { ok, vk, modifiers, label } or { ok: false, error }. */
export function parseKeySpec(spec) {
  const raw = String(spec || "").trim();
  if (!raw) return { ok: false, error: "快捷键不能为空" };
  const tokens = raw.split("+").map((token) => token.trim()).filter(Boolean);
  if (tokens.length === 0) return { ok: false, error: "快捷键不能为空" };

  const modifiers = { ctrl: false, alt: false, shift: false, win: false };
  let mainKey = null;
  for (const token of tokens) {
    const modifier = MODIFIER_ALIASES.get(token.toLowerCase());
    if (modifier) {
      modifiers[modifier] = true;
      continue;
    }
    if (mainKey) return { ok: false, error: `一个快捷键只能有一个主键：${raw}` };
    mainKey = resolveMainKey(token);
    if (!mainKey) return { ok: false, error: `不支持的按键：${token}` };
  }
  if (!mainKey) return { ok: false, error: `缺少主键：${raw}` };

  const modifierCount = MODIFIER_ORDER.filter((name) => modifiers[name]).length;
  if (mainKey.requiresModifier && modifierCount === 0) {
    return { ok: false, error: `字母和数字必须配合 Ctrl/Alt/Shift/Win 使用：${raw}` };
  }

  let bits = 0;
  for (const name of MODIFIER_ORDER) {
    if (modifiers[name]) bits |= MODIFIER_BITS[name];
  }
  return {
    ok: true,
    vk: mainKey.vk,
    modifiers: bits,
    label: formatKeySpec({ modifiers: bits, keyLabel: mainKey.label })
  };
}

/** Canonical display order: Ctrl+Alt+Shift+Win+Key. */
export function formatKeySpec({ modifiers = 0, keyLabel = "" }) {
  const parts = [];
  for (const name of MODIFIER_ORDER) {
    if (modifiers & MODIFIER_BITS[name]) parts.push(MODIFIER_LABELS[name]);
  }
  parts.push(keyLabel);
  return parts.join("+");
}

export function isValidKeySpec(spec) {
  return parseKeySpec(spec).ok;
}

/** Small helper for logging and the panel: "Ctrl+Alt+1 → 少件". */
export function describeBindings(bindings) {
  return (bindings || []).map((binding) => `${binding.keys} → ${binding.reason}`).join("，");
}
