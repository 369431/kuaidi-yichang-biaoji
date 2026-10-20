import path from "node:path";
import os from "node:os";
import process from "node:process";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Logger } from "./logger.js";
import { EXTENSION_IDENTITY } from "./client.js";
import { ExtensionRuntime } from "./runtime.js";
import { createPanelServer, listenPanel } from "./server.js";
import { bindAddressFor, panelUrls } from "./netguard.js";
import { isOlderVersion } from "./version.js";

const APP_ID = "369431.inner-mismatch";
const DEFAULT_DATA_DIRECTORY = path.join(
  process.env.LOCALAPPDATA || process.env.HOME || ".",
  "ExpressPackingMonitoring",
  "extension-data",
  APP_ID
);

function resolveDataDirectory() {
  const injected = process.env.PACKINGPROOF_EXTENSION_DATA_DIR;
  if (injected && injected.trim()) return path.resolve(injected.trim());
  return path.resolve(DEFAULT_DATA_DIRECTORY);
}

function openPanel(url, mode = "app") {
  if (process.platform !== "win32") {
    try {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    } catch {
      // The URL is printed to the console as well.
    }
    return;
  }
  if (mode === "app") {
    const browser = findChromiumBrowser();
    if (browser) {
      try {
        // A standalone window without tabs or an address bar: it behaves like a small packing app.
        spawn(browser, [`--app=${url}`, "--window-size=1180,900"], {
          detached: true,
          stdio: "ignore",
          windowsHide: false
        }).unref();
        return;
      } catch {
        // Fall through to the default browser.
      }
    }
  }
  try {
    spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    // Opening the browser is a convenience; the URL is also printed to the console.
  }
}

function findChromiumBrowser() {
  const localAppData = process.env.LOCALAPPDATA || "";
  const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const candidates = [
    path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe")
  ];
  return candidates.find((candidate) => existsSync(candidate)) || "";
}

async function probeRunning(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.app === APP_ID ? data : null;
  } catch {
    return null;
  }
}

async function requestShutdown(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/system/shutdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(3000)
    });
    return true;
  } catch {
    return false;
  }
}

async function waitForPortFree(port, timeoutMs = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!(await probeRunning(port))) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function main() {
  const dataDirectory = resolveDataDirectory();
  const logger = new Logger(dataDirectory);
  const args = new Set(process.argv.slice(2));
  let stopNow = () => {};

  logger.info("Start", `内物不符异常标记 ${APP_ID} 启动，数据目录 ${dataDirectory}`);

  const settingsPreview = await loadPortPreview(dataDirectory);
  const running = await probeRunning(settingsPreview);
  if (running) {
    const ours = EXTENSION_IDENTITY.version;
    if (!isOlderVersion(running.version, ours)) {
      const localUrl = `http://127.0.0.1:${settingsPreview}/`;
      const urls = panelUrls(settingsPreview, "lan");
      logger.info("Start", `插件已在运行（${running.version}）：${localUrl}，本次不再重复启动`);
      console.log("");
      console.log(`  内物不符异常标记已在运行（${running.version}），直接在 PackingProof 里按快捷键即可标记`);
      for (const [index, value] of urls.entries()) {
        console.log(`  ${index === 0 ? "面板（本机）：  " : "面板（局域网）："}${value}`);
      }
      console.log("");
      if (!args.has("--no-open")) openPanel(localUrl, "app");
      return;
    }

    // Newer build: take over the port and the hotkeys from the running instance.
    logger.info("Start", `检测到旧版本 ${running.version}，正在让它退出以便升级到 ${ours}`);
    console.log("");
    console.log(`  检测到旧版本 ${running.version} 仍在运行，正在切换到这个版本（${ours}）…`);
    await requestShutdown(settingsPreview);
    if (!(await waitForPortFree(settingsPreview))) {
      logger.warn("Start", "旧实例没有退出（旧版本不支持自动接管），将在下一个端口启动");
      console.log("  旧版本不支持自动接管：请手动关闭它的窗口，或先卸载旧版本再启动");
    }
  }

  const runtime = new ExtensionRuntime({ dataDirectory, logger });
  await runtime.init();

  const settings = runtime.settings;
  const bindAddress = bindAddressFor(settings.panelBind);
  const effective = settings;
  const hiddenLauncher = fileURLToPath(new URL("../start-hidden.vbs", import.meta.url));
  const access = {
    bind: effective.panelBind,
    token: effective.panelToken,
    extraHostnames: effective.panelAllowedHosts,
    urls: [],
    onShutdown: () => void stopNow("panel stop"),
    onRestart: () => {
      try {
        // Give this process time to exit before the hidden launcher starts a fresh one.
        const command = `timeout /t 2 /nobreak >nul & wscript.exe "${hiddenLauncher}"`;
        spawn("cmd.exe", ["/c", command], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      } catch (error) {
        logger.warn("Panel", `重启失败：${error.message}`);
      }
      void stopNow("panel restart");
    }
  };
  const server = createPanelServer({ runtime, logger, access });
  const port = await listenPanel(server, settingsPreview, logger, { address: bindAddress });
  const urls = panelUrls(port, effective.panelBind);
  access.urls = urls.map((value) => `${value}manage`);

  // Firewall + autostart: this is what makes "install, then open http://<this-pc>:8792" work.
  const startCmdPath = fileURLToPath(new URL("../start.cmd", import.meta.url));
  const system = await runtime.attachSystemAccess({ port, startCmdPath });
  const overlay = runtime.attachOverlay({ baseUrl: `http://127.0.0.1:${port}` });
  const url = urls[0];
  const tokenSuffix = effective.panelToken ? `?token=${encodeURIComponent(effective.panelToken)}` : "";

  console.log("");
  console.log("  PackingProof 内物不符异常标记");
  console.log(`  主机：      ${effective.host}`);
  console.log(`  授权状态：  ${runtime.state().auth.status === "authorized" ? "已授权" : runtime.state().auth.message || runtime.state().auth.status}`);
  const hotkeys = runtime.state().hotkeys;
  if (hotkeys.status === "ready") {
    const direct = (hotkeys.bindings || []).map((binding) => `${binding.keys} ${binding.reason}`).join(" · ");
    const arm = hotkeys.activator?.keys ? `按 ${hotkeys.activator.keys} 进入标记模式，再按 1-${effective.reasons.length} 选原因` : "";
    const undo = hotkeys.undo?.keys ? `${hotkeys.undo.keys} 撤销` : "";
    console.log(`  快捷键：    ${[arm, direct, undo].filter(Boolean).join(" · ") || "无"}`);
  } else {
    console.log(`  快捷键：    未启用（${hotkeys.message || hotkeys.status}）`);
  }
  console.log(`  面板（本机）：    ${urls[0]}`);
  if (urls.length > 1) {
    for (const lanUrl of urls.slice(1)) console.log(`  面板（局域网）：  ${lanUrl}${tokenSuffix}`);
    console.log(`  面板（计算机名）：http://${os.hostname()}:${port}/${tokenSuffix}`);
  } else {
    console.log("  仅本机访问（settings.json 里 panelBind 设为 lan 可打开局域网）");
  }
  const firewallText =
    system.firewall?.state === "ready"
      ? "已放行（局域网/手机可访问）"
      : system.firewall?.state === "unsupported"
        ? "不适用"
        : `${system.firewall?.message || "未配置"}（点面板「重试放行」或运行 scripts\\allow-firewall.cmd）`;
  console.log(`  防火墙：        ${firewallText}`);
  console.log(`  开机自启：      ${system.autoStart?.enabled ? "已添加到当前用户启动项" : "未启用"}`);
  console.log(`  悬浮标记条：    ${overlay.running ? "已显示（贴在录制窗口旁边，可直接点原因）" : overlay.enabled ? "启动失败" : "已关闭"}`);
  if (effective.panelToken) console.log(`  访问令牌：  已启用（地址后加 ?token=${effective.panelToken}）`);
  console.log("");
  console.log("  提示：扫码后在 PackingProof 窗口里直接按快捷键即可标记，不需要切到这个面板");
  console.log("");

  logger.info("Panel", `面板已启动 ${urls.join(" , ")}（bind=${bindAddress}）`);
  if (effective.openPanelOnStart && !args.has("--no-open")) openPanel(url, settings.panelWindow);

  await new Promise((resolve) => {
    let stopping = false;
    stopNow = async (reason = "shutdown") => {
      if (stopping) return;
      stopping = true;
      logger.info("Stop", `收到 ${reason}，正在退出`);
      server.close();
      await runtime.shutdown();
      resolve();
    };
    process.once("SIGINT", () => void stopNow("SIGINT"));
    process.once("SIGTERM", () => void stopNow("SIGTERM"));
  });
}

async function loadPortPreview(dataDirectory) {
  try {
    const { SettingsStore } = await import("./config.js");
    const store = new SettingsStore(dataDirectory);
    const settings = await store.load();
    return settings.panelPort;
  } catch {
    return 8792;
  }
}

process.on("unhandledRejection", (error) => {
  console.error("[FATAL] 未处理的 Promise 异常：", error);
});

main().catch((error) => {
  console.error("");
  console.error("  [启动失败]", error?.message || error);
  console.error("  请检查 Node.js 版本（需要 20+）和 settings.json 中的主机地址");
  console.error("");
  process.exitCode = 1;
});
