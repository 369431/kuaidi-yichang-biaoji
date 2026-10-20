import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describeError } from "./logger.js";

const SCRIPT_PATH = fileURLToPath(new URL("./overlay.ps1", import.meta.url));

/**
 * The floating marking bar: a small always-on-top WPF window that sits next to the recording window.
 * It is a separate process (PowerShell -STA) that talks to this adapter over localhost HTTP, so it can
 * be closed or restarted without touching the marking logic.
 */
export class OverlayManager {
  #logger;
  #baseUrl;
  #token;
  #process = null;
  #scriptPath;

  constructor({ logger, baseUrl, token = "", scriptPath = SCRIPT_PATH }) {
    this.#logger = logger;
    this.#baseUrl = baseUrl;
    this.#token = token;
    this.#scriptPath = scriptPath;
  }

  get running() {
    return Boolean(this.#process);
  }

  start() {
    if (process.platform !== "win32") return { ok: false, message: "悬浮标记条只在 Windows 上可用" };
    if (this.#process) return { ok: true, message: "已在运行" };
    try {
      const child = spawn(
        "powershell.exe",
        [
          "-STA",
          "-NoProfile",
          "-WindowStyle",
          "Hidden",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          this.#scriptPath,
          "-BaseUrl",
          this.#baseUrl,
          "-Token",
          this.#token
        ],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
      );
      this.#process = child;
      child.stdout.on("data", (chunk) => {
        const text = chunk.toString("utf8").trim();
        if (text) this.#logger?.info("Overlay", text.slice(0, 200));
      });
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8").trim();
        if (text) this.#logger?.warn("Overlay", text.slice(0, 200));
      });
      child.on("error", (error) => {
        this.#logger?.warn("Overlay", `启动失败：${describeError(error)}`);
        this.#process = null;
      });
      child.on("exit", (code) => {
        if (this.#process === child) this.#process = null;
        this.#logger?.info("Overlay", `悬浮标记条已退出（${code}）`);
      });
      this.#logger?.info("Overlay", "悬浮标记条已启动");
      return { ok: true, message: "已启动" };
    } catch (error) {
      this.#logger?.warn("Overlay", `启动失败：${describeError(error)}`);
      return { ok: false, message: describeError(error) };
    }
  }

  stop() {
    const child = this.#process;
    this.#process = null;
    if (!child) return;
    try {
      child.kill();
    } catch {
      // ignore
    }
  }
}
