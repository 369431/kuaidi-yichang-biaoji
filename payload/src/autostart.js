import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describeError } from "./logger.js";

const SCRIPT_PATH = fileURLToPath(new URL("./shortcut.ps1", import.meta.url));

function runShortcut(action, startCmd) {
  return new Promise((resolve) => {
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT_PATH, "-Action", action];
    if (startCmd) args.push("-StartCmd", startCmd);
    const child = spawn("powershell.exe", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => child.kill(), 30000);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, message: describeError(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(stdout).toString("utf8").trim();
      if (code === 0) {
        resolve({ ok: true, message: text });
        return;
      }
      resolve({ ok: false, message: Buffer.concat(stderr).toString("utf8").trim() || `exit ${code}` });
    });
  });
}

/**
 * Per-user Startup shortcut so the panel is already running after sign-in ("install and it just works").
 * It writes only to the current user's Startup folder, so no administrator rights are involved.
 */
export class AutoStartManager {
  #logger;
  #startCmd;
  #enabled = false;

  constructor({ logger, startCmd }) {
    this.#logger = logger;
    this.#startCmd = startCmd;
  }

  get snapshot() {
    return { enabled: this.#enabled, startCmd: this.#startCmd };
  }

  async enable() {
    if (process.platform !== "win32") return { ok: false, message: "只有 Windows 支持开机自启" };
    const result = await runShortcut("create", this.#startCmd);
    this.#enabled = result.ok;
    if (result.ok) this.#logger?.info("AutoStart", "已添加开机自启快捷方式（当前用户）");
    else this.#logger?.warn("AutoStart", `添加开机自启失败：${result.message}`);
    return result;
  }

  async disable() {
    if (process.platform !== "win32") return { ok: false, message: "只有 Windows 支持开机自启" };
    const result = await runShortcut("remove");
    if (result.ok) this.#enabled = false;
    return result;
  }
}
