import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseKeySpec } from "./keymap.js";
import { describeError } from "./logger.js";

const SCRIPT_PATH = fileURLToPath(new URL("./hotkeys.ps1", import.meta.url));
const MAX_RESTARTS = 3;
const ACTIVATOR_ID = 1;
const UNDO_ID = 99;
const BINDING_ID_BASE = 100;

/**
 * Windows global hotkeys, so the packer can mark a parcel while PackingProof keeps focus.
 *
 * Node cannot register global hotkeys without a native module, so a small PowerShell helper owns the
 * Win32 message loop (RegisterHotKey + WM_HOTKEY) and prints one line per key press.
 *
 * Marking has two styles:
 *   - two-step (default): the activator key arms "marking mode" for a few seconds, then bare digits
 *     1..9 pick the reason (Esc cancels, arming expires on its own)
 *   - direct: one combination per reason
 */
export class HotkeyService {
  #logger;
  #onCommand;
  #onStateChange;
  #scriptPath;
  #process = null;
  #stopped = true;
  #restarts = 0;
  #options = { activator: "", undo: "", bindings: [], armSeconds: 8 };
  #state = { status: "idle", message: "", activator: null, undo: null, bindings: [], armed: false };

  constructor({ logger, onCommand, onStateChange, scriptPath = SCRIPT_PATH } = {}) {
    this.#logger = logger;
    this.#onCommand = onCommand;
    this.#onStateChange = onStateChange;
    this.#scriptPath = scriptPath;
  }

  get snapshot() {
    return {
      ...this.#state,
      activator: this.#state.activator ? { ...this.#state.activator } : null,
      undo: this.#state.undo ? { ...this.#state.undo } : null,
      bindings: this.#state.bindings.map((binding) => ({ ...binding }))
    };
  }

  /**
   * @param {object} options
   * @param {string} options.activator  key spec that arms marking mode, e.g. "F9"
   * @param {string} options.undo       key spec that revokes the last mark
   * @param {number} options.armSeconds how long bare digits stay armed
   * @param {Array<{index:number, reason:string, keys:string}>} options.bindings direct per-reason combos
   */
  start(options = {}) {
    this.stop();
    this.#options = {
      activator: String(options.activator || ""),
      undo: String(options.undo || ""),
      bindings: Array.isArray(options.bindings) ? options.bindings : [],
      armSeconds: Math.min(30, Math.max(3, Number(options.armSeconds) || 8))
    };
    if (process.platform !== "win32") {
      this.#setState({ status: "unsupported", message: "全局快捷键只在 Windows 电脑端可用", activator: null, undo: null, bindings: [] });
      return;
    }

    const activatorSpec = parseKeySpec(this.#options.activator);
    const undoSpec = parseKeySpec(this.#options.undo);
    const bindings = [];
    for (const binding of this.#options.bindings) {
      const spec = parseKeySpec(binding.keys);
      if (!spec.ok) continue;
      bindings.push({ index: binding.index, reason: binding.reason, keys: spec.label, spec });
    }
    if (!activatorSpec.ok && !undoSpec.ok && bindings.length === 0) {
      this.#setState({ status: "error", message: "没有可注册的快捷键，请在面板里设置", activator: null, undo: null, bindings: [] });
      return;
    }

    this.#stopped = false;
    this.#state = {
      status: "starting",
      message: "",
      armed: false,
      activator: activatorSpec.ok ? { keys: activatorSpec.label, ok: false } : null,
      undo: undoSpec.ok ? { keys: undoSpec.label, ok: false } : null,
      bindings: bindings.map((binding) => ({ index: binding.index, reason: binding.reason, keys: binding.keys, ok: false }))
    };

    const args = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      this.#scriptPath,
      "-Activator",
      activatorSpec.ok ? `${activatorSpec.modifiers}=${activatorSpec.vk}` : "",
      "-Undo",
      undoSpec.ok ? `${undoSpec.modifiers}=${undoSpec.vk}` : "",
      "-Bindings",
      bindings.map((binding) => `${BINDING_ID_BASE + binding.index}=${binding.spec.modifiers}=${binding.spec.vk}`).join(";"),
      "-ArmSeconds",
      String(this.#options.armSeconds)
    ];

    const child = spawn("powershell.exe", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.#process = child;
    let buffer = "";

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) this.#handleLine(line);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.#logger?.warn("Hotkey", `宿主输出：${text.slice(0, 200)}`);
    });

    child.on("error", (error) => {
      this.#setState({ status: "error", message: describeError(error) });
    });

    child.on("exit", (code) => {
      if (this.#process === child) this.#process = null;
      if (this.#stopped) return;
      if (this.#restarts >= MAX_RESTARTS) {
        this.#setState({ status: "error", message: "快捷键宿主反复退出，已停止重试" });
        return;
      }
      this.#restarts += 1;
      this.#setState({ status: "retrying", message: `快捷键宿主退出（${code}），正在重试` });
      const options2 = this.#options;
      setTimeout(() => {
        if (!this.#stopped) this.start(options2);
      }, 1500 * this.#restarts).unref?.();
    });
  }

  #handleLine(line) {
    if (line.startsWith("BIND ")) {
      const [, rawId, result] = line.split(/\s+/);
      this.#markBound(Number(rawId), result === "ok");
      return;
    }
    if (line === "READY") {
      const failures =
        this.#state.bindings.filter((binding) => !binding.ok).length +
        (this.#state.activator && !this.#state.activator.ok ? 1 : 0) +
        (this.#state.undo && !this.#state.undo.ok ? 1 : 0);
      this.#setState({ status: "ready", message: failures > 0 ? `${failures} 个快捷键注册失败（可能被其他程序占用）` : "" });
      const parts = [];
      if (this.#state.activator) parts.push(`启动键 ${this.#state.activator.keys}`);
      if (this.#state.undo) parts.push(`撤销 ${this.#state.undo.keys}`);
      for (const binding of this.#state.bindings) parts.push(`${binding.keys}→${binding.reason}`);
      this.#logger?.info("Hotkey", `全局快捷键已就绪：${parts.join("，")}`);
      return;
    }
    if (line === "ARMED") {
      this.#setState({ armed: true });
      this.#logger?.info("Hotkey", "已进入标记模式，等待按数字选择原因");
      return;
    }
    if (line === "DISARMED") {
      this.#setState({ armed: false });
      return;
    }
    if (line === "CANCEL") {
      this.#setState({ armed: false });
      this.#logger?.info("Hotkey", "已取消标记模式");
      return;
    }
    if (line.startsWith("PICK ")) {
      const digit = Number(line.slice(5).trim());
      if (!Number.isInteger(digit) || digit < 1) return;
      this.#setState({ armed: false });
      this.#logger?.info("Hotkey", `标记模式选择 ${digit}`);
      this.#onCommand?.({ type: "mark", reasonIndex: digit - 1 });
      return;
    }
    if (line.startsWith("HOTKEY ")) {
      const id = Number(line.slice(7).trim());
      if (id === UNDO_ID) {
        this.#onCommand?.({ type: "undo" });
        return;
      }
      if (id >= BINDING_ID_BASE) {
        this.#onCommand?.({ type: "mark", reasonIndex: id - BINDING_ID_BASE });
        return;
      }
      if (id === ACTIVATOR_ID) {
        // The helper arms itself and reports ARMED; nothing to do here.
        return;
      }
      return;
    }
    if (line === "BYE") this.#logger?.warn("Hotkey", "快捷键宿主已退出");
  }

  #markBound(id, ok) {
    if (id === ACTIVATOR_ID) {
      this.#state = { ...this.#state, activator: this.#state.activator ? { ...this.#state.activator, ok } : null };
    } else if (id === UNDO_ID) {
      this.#state = { ...this.#state, undo: this.#state.undo ? { ...this.#state.undo, ok } : null };
    } else if (id >= BINDING_ID_BASE) {
      const index = id - BINDING_ID_BASE;
      this.#state = {
        ...this.#state,
        bindings: this.#state.bindings.map((binding) => (binding.index === index ? { ...binding, ok } : binding))
      };
    }
    this.#onStateChange?.(this.snapshot);
  }

  /** Plays a short tone: ok / error / undo / arm. Never throws. */
  beep(kind = "ok") {
    const child = this.#process;
    if (!child?.stdin?.writable) return;
    try {
      child.stdin.write(`BEEP ${String(kind).toUpperCase()}\n`);
    } catch {
      // Helper already gone; the panel still reflects the result.
    }
  }

  /** Leaves marking mode (e.g. the reason list no longer has that index). */
  disarm() {
    const child = this.#process;
    if (!child?.stdin?.writable) return;
    try {
      child.stdin.write("DISARM\n");
    } catch {
      // ignore
    }
  }

  stop() {
    this.#stopped = true;
    const child = this.#process;
    this.#process = null;
    if (!child) return;
    try {
      child.stdin.write("QUIT\n");
    } catch {
      // ignore
    }
    setTimeout(() => {
      if (!child.killed) child.kill();
    }, 500).unref?.();
  }

  #setState(patch) {
    this.#state = { ...this.#state, ...patch };
    this.#onStateChange?.(this.snapshot);
  }
}
