import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseKeySpec } from "./keymap.js";

export const DEFAULT_REASONS = ["少件", "错件", "多发", "商品破损", "包装破损", "其他"];

export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: 1,
  host: "http://127.0.0.1:5280",
  panelPort: 8792,
  panelBind: "lan",
  panelToken: "",
  panelAllowedHosts: [],
  firewallAutoAllow: true,
  autoStart: true,
  panelWindow: "app",
  overlayEnabled: true,
  openPanelOnStart: true,
  operator: "",
  pollIntervalMs: 800,
  hotkeysEnabled: true,
  hotkeyActivator: "F9",
  hotkeyArmSeconds: 8,
  hotkeyModifiers: "Ctrl+Alt",
  hotkeyBindings: null,
  hotkeyUndo: null,
  reasons: DEFAULT_REASONS,
  watermarkNamespace: "异常",
  watermarkField: "内物不符",
  keepDays: 0
});

export const HOTKEY_MODIFIERS = Object.freeze(["Ctrl+Alt", "Ctrl+Shift", "Alt+Shift", "Ctrl+Alt+Shift"]);

export function normalizeHost(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("主机地址不能为空");
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`主机地址无法解析：${value}`);
  }
  if (url.pathname && url.pathname !== "/") {
    throw new Error("主机地址不要带路径，只填协议、地址和端口，例如 http://127.0.0.1:5280");
  }
  return `${url.protocol}//${url.host}`;
}

export function normalizeReasons(value) {
  const source = Array.isArray(value) ? value : [];
  const reasons = [];
  for (const item of source) {
    if (typeof item !== "string") continue;
    const reason = item.trim();
    if (!reason || reason.length > 40) continue;
    if (!reasons.includes(reason)) reasons.push(reason);
    if (reasons.length >= 12) break;
  }
  return reasons.length > 0 ? reasons : [...DEFAULT_REASONS];
}

/**
 * Per-reason direct combinations. Absent means "none": the default marking flow is the two-step
 * activator (press F9, then 1-9), which does not need a combination per reason.
 */
export function normalizeBindings(value, reasons, modifiers) {
  if (!Array.isArray(value)) return [];
  void modifiers;

  const byReason = new Map();
  const usedKeys = new Map();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const reason = String(entry.reason || "").trim();
    if (!reasons.includes(reason)) continue;
    const spec = parseKeySpec(entry.keys);
    if (!spec.ok) continue;
    if (usedKeys.has(spec.label) && usedKeys.get(spec.label) !== reason) continue;
    byReason.set(reason, spec.label);
    usedKeys.set(spec.label, reason);
  }
  // Keep the configured reason order so the panel and the helper agree on ids.
  return reasons.filter((reason) => byReason.has(reason)).map((reason) => ({ reason, keys: byReason.get(reason) }));
}

export function normalizeUndoBinding(value, modifiers) {
  const spec = parseKeySpec(value);
  if (spec.ok) return spec.label;
  const fallback = parseKeySpec(`${modifiers}+Z`);
  return fallback.ok ? fallback.label : "Ctrl+Alt+Z";
}

/** Extra hostnames (domains) the panel may be reached through, e.g. "pack.example.com". */
export function normalizeHostList(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  const hosts = [];
  for (const item of list) {
    const host = String(item || "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .split("/")[0]
      .replace(/:\d+$/, "");
    if (!host || host.length > 253) continue;
    if (!/^[a-z0-9.-]+$/.test(host)) continue;
    if (!hosts.includes(host)) hosts.push(host);
    if (hosts.length >= 10) break;
  }
  return hosts;
}

/** Applies defaults and clamps every value the panel or settings.json can change. */
export function normalizeSettings(input = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...(input || {}) };
  const port = Number(merged.panelPort);
  const pollInterval = Number(merged.pollIntervalMs);
  const keepDays = Number(merged.keepDays);
  const reasons = normalizeReasons(merged.reasons);
  const hotkeyModifiers = HOTKEY_MODIFIERS.includes(merged.hotkeyModifiers)
    ? merged.hotkeyModifiers
    : DEFAULT_SETTINGS.hotkeyModifiers;
  const hotkeyUndo = normalizeUndoBinding(merged.hotkeyUndo, hotkeyModifiers);
  const hotkeyBindings = normalizeBindings(merged.hotkeyBindings, reasons, hotkeyModifiers).filter(
    (binding) => binding.keys !== hotkeyUndo
  );
  const hotkeyActivatorSpec = parseKeySpec(merged.hotkeyActivator);
  const hotkeyArmSeconds = Number(merged.hotkeyArmSeconds);
  return {
    schemaVersion: 1,
    host: (() => {
      try {
        return normalizeHost(merged.host);
      } catch {
        return DEFAULT_SETTINGS.host;
      }
    })(),
    panelPort: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_SETTINGS.panelPort,
    panelBind: merged.panelBind === "loopback" ? "loopback" : "lan",
    panelToken: String(merged.panelToken ?? "").trim().slice(0, 64),
    panelAllowedHosts: normalizeHostList(merged.panelAllowedHosts),
    firewallAutoAllow: merged.firewallAutoAllow !== false,
    autoStart: merged.autoStart !== false,
    panelWindow: merged.panelWindow === "browser" ? "browser" : "app",
    overlayEnabled: merged.overlayEnabled !== false,
    openPanelOnStart: merged.openPanelOnStart !== false,
    operator: String(merged.operator ?? "").trim().slice(0, 40),
    pollIntervalMs: Number.isFinite(pollInterval) ? Math.min(5000, Math.max(400, Math.round(pollInterval))) : DEFAULT_SETTINGS.pollIntervalMs,
    hotkeysEnabled: merged.hotkeysEnabled !== false,
    hotkeyActivator: hotkeyActivatorSpec.ok ? hotkeyActivatorSpec.label : DEFAULT_SETTINGS.hotkeyActivator,
    hotkeyArmSeconds: Number.isFinite(hotkeyArmSeconds) ? Math.min(30, Math.max(3, Math.round(hotkeyArmSeconds))) : DEFAULT_SETTINGS.hotkeyArmSeconds,
    hotkeyModifiers,
    hotkeyBindings,
    hotkeyUndo,
    reasons,
    watermarkNamespace: sanitizeIdentifier(merged.watermarkNamespace, "异常"),
    watermarkField: sanitizeIdentifier(merged.watermarkField, "内物不符"),
    keepDays: Number.isFinite(keepDays) && keepDays > 0 ? Math.min(3650, Math.round(keepDays)) : 0
  };
}

/** PackingProof only accepts letters, digits, dot, underscore and hyphen in field names. */
export function sanitizeIdentifier(value, fallback) {
  const normalized = String(value || "").trim().slice(0, 64);
  if (!normalized) return fallback;
  const cleaned = normalized.replace(/[^\p{L}\p{N}._-]/gu, "");
  return cleaned || fallback;
}

export class SettingsStore {
  #filePath;
  #settings;

  constructor(dataDirectory, initial = {}) {
    this.#filePath = path.join(dataDirectory, "settings.json");
    this.#settings = normalizeSettings(initial);
  }

  get value() {
    return { ...this.#settings, reasons: [...this.#settings.reasons] };
  }

  async load() {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    try {
      const raw = await readFile(this.#filePath, "utf8");
      this.#settings = normalizeSettings(JSON.parse(raw));
    } catch (error) {
      if (error.code !== "ENOENT") {
        // A broken settings file must not block packing: keep defaults and rewrite on next save.
        this.#settings = normalizeSettings({});
      }
      await this.save();
    }
    return this.value;
  }

  async update(patch) {
    this.#settings = normalizeSettings({ ...this.#settings, ...(patch || {}) });
    await this.save();
    return this.value;
  }

  async save() {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const temporary = `${this.#filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#settings, null, 2)}\n`, "utf8");
    await rename(temporary, this.#filePath);
  }
}
