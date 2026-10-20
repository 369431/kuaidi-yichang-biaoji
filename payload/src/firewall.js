import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describeError } from "./logger.js";

const SCRIPT_PATH = fileURLToPath(new URL("./firewall.ps1", import.meta.url));
export const RULE_NAME = "PackingProof InnerMismatch Panel";

function run(command, args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: "", stderr: describeError(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim()
      });
    });
  });
}

/**
 * Windows firewall helper. The panel is reachable on the LAN only if an inbound rule exists for its
 * port; adding one always needs elevation, so the adapter asks for it once (UAC) and remembers the result.
 */
export class FirewallManager {
  #logger;
  #port;
  #ruleName;
  #runner;
  #status = { state: "unknown", message: "" };

  constructor({ logger, port, ruleName = RULE_NAME, runner = run } = {}) {
    this.#logger = logger;
    this.#port = Number(port) || 8792;
    this.#ruleName = ruleName;
    this.#runner = runner;
  }

  get snapshot() {
    return { ...this.#status, port: this.#port, ruleName: this.#ruleName };
  }

  /** Used when the adapter is configured not to touch the firewall (or binds loopback only). */
  markUnmanaged(message) {
    this.#status = { state: "unmanaged", message };
    return this.#status;
  }

  async isAllowed() {
    const result = await this.#runner("netsh.exe", [
      "advfirewall",
      "firewall",
      "show",
      "rule",
      `name=${this.#ruleName}`
    ]);
    return result.code === 0 && /PackingProof/i.test(result.stdout);
  }

  /**
   * Adds the rule when missing. Elevation is requested through Start-Process -Verb RunAs, so the user
   * sees one standard UAC prompt; declining it is reported, not retried automatically.
   */
  async ensure() {
    if (process.platform !== "win32") {
      this.#status = { state: "unsupported", message: "只有 Windows 需要配置防火墙" };
      return this.#status;
    }
    if (await this.isAllowed()) {
      this.#status = { state: "ready", message: "入站规则已存在" };
      return this.#status;
    }

    this.#status = { state: "asking", message: "等待管理员确认（UAC）" };
    const elevation = await this.#runner(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `$p = Start-Process -Verb RunAs -PassThru -Wait -FilePath 'powershell.exe' ` +
          `-ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${SCRIPT_PATH}','-Port','${this.#port}'); exit $p.ExitCode`
      ],
      { timeoutMs: 120000 }
    );

    if (await this.isAllowed()) {
      this.#status = { state: "ready", message: "已自动放行 TCP 端口" };
      this.#logger?.info("Firewall", `已添加防火墙入站规则（TCP ${this.#port}）`);
      return this.#status;
    }

    const denied = elevation.code === 1 && /cancel|取消/i.test(elevation.stderr);
    this.#status = denied
      ? { state: "denied", message: "你取消了管理员确认，局域网访问会被防火墙挡住" }
      : { state: "failed", message: "自动放行失败，可点「重试放行」或手动运行 scripts\\allow-firewall.cmd" };
    this.#logger?.warn("Firewall", `${this.#status.message}（${elevation.stderr || elevation.code}）`);
    return this.#status;
  }

  async remove() {
    await this.#runner("netsh.exe", ["advfirewall", "firewall", "delete", "rule", `name=${this.#ruleName}`]);
    this.#status = { state: "removed", message: "已删除入站规则" };
    return this.#status;
  }
}
