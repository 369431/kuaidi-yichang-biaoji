import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AutoStartManager } from "./autostart.js";
import { PackingProofClient, EXTENSION_IDENTITY } from "./client.js";
import { CredentialStore } from "./credential-store.js";
import { SettingsStore } from "./config.js";
import { EvidenceService } from "./evidence.js";
import { ExceptionService } from "./exceptions.js";
import { FirewallManager } from "./firewall.js";
import { HotkeyService } from "./hotkeys.js";
import { OverlayManager } from "./overlay.js";
import { describeError } from "./logger.js";
import { ExceptionStore } from "./store.js";
import { RecordingWatcher } from "./watcher.js";

const HEARTBEAT_INTERVAL_MS = 15000;

/**
 * Owns everything long-lived: settings, credential, watcher, exception store and heartbeat.
 * The HTTP panel is a thin view over this object.
 */
export class ExtensionRuntime {
  #logger;
  #dataDirectory;
  #settings;
  #credentials;
  #client;
  #watcher;
  #store;
  #exceptions;
  #evidence;
  #auth = { status: "unknown", message: "", permissions: [], capabilities: [] };
  #node = { id: "", name: "", product: "", version: "" };
  #enrolling = null;
  #heartbeatTimer = null;
  #lastActivityAt = null;
  #hotkeys;
  #markChain = Promise.resolve();
  #lastMarkedRecordId = "";
  #recoveryAttempts = 0;
  #recoveryTimer = null;
  #watcherRunning = false;
  #hotkeysSuspended = false;
  #firewall = null;
  #autoStart = null;
  #overlay = null;

  constructor({ dataDirectory, logger }) {
    this.#dataDirectory = dataDirectory;
    this.#logger = logger;
    this.#settings = new SettingsStore(dataDirectory);
    this.#credentials = new CredentialStore(dataDirectory, logger);
    this.#client = new PackingProofClient({
      baseUrl: this.#settings.value.host,
      logger,
      onAuthFailure: (error) => this.#handleAuthFailure(error)
    });
    this.#watcher = new RecordingWatcher({
      client: this.#client,
      logger,
      intervalMs: this.#settings.value.pollIntervalMs,
      onScan: (scan) => this.#logger.info("Scan", `当前单号 ${scan.trackingNumber}`),
      onStop: (scan) => this.#logger.info("Scan", `录像结束 ${scan.trackingNumber}`)
    });
    this.#store = new ExceptionStore(dataDirectory, logger);
    this.#exceptions = new ExceptionService({
      store: this.#store,
      client: this.#client,
      settings: this.#settings,
      watcher: this.#watcher,
      logger,
      // Falls back to the workstation name PackingProof reports (e.g. "电脑1") before "未署名".
      nodeName: () => this.#node.name || os.hostname()
    });
    this.#evidence = new EvidenceService({ client: this.#client, logger });
    this.#hotkeys = new HotkeyService({
      logger,
      onCommand: (command) => {
        void this.#handleHotkey(command);
      }
    });
  }

  get settings() {
    return this.#settings.value;
  }

  get dataDirectory() {
    return this.#dataDirectory;
  }

  get exceptions() {
    return this.#exceptions;
  }

  get evidence() {
    return this.#evidence;
  }

  get watcher() {
    return this.#watcher;
  }

  get client() {
    return this.#client;
  }

  async init() {
    await mkdir(this.#dataDirectory, { recursive: true });
    await this.#settings.load();
    this.#client.baseUrl = this.#settings.value.host;
    await this.#store.load();
    const pruned = this.#store.prune(this.#settings.value.keepDays);
    if (pruned > 0) {
      this.#logger.info("Store", `按保留天数清理了 ${pruned} 条历史异常记录`);
      await this.#store.flush();
    }
    await this.ensureAuthorized();
    this.#watcher.setIntervalMs(this.#settings.value.pollIntervalMs);
    // Only poll while the host accepts our signature: a revoked credential would otherwise spam
    // 403s every second and never bring the authorization window back.
    if (this.#auth.status === "authorized") this.#startWatcher();
    this.#startHeartbeat();
    this.#startHotkeys();
  }

  #startWatcher() {
    if (this.#watcherRunning) return;
    this.#watcherRunning = true;
    this.#watcher.start();
  }

  /**
   * Makes "install the extension and open http://<this-pc>:8792" actually work: adds the inbound
   * firewall rule once (one UAC prompt) and puts the panel into the user's Startup folder.
   */
  async attachSystemAccess({ port, startCmdPath }) {
    this.#firewall = new FirewallManager({ logger: this.#logger, port });
    this.#autoStart = new AutoStartManager({ logger: this.#logger, startCmd: startCmdPath });
    const settings = this.#settings.value;
    try {
      if (settings.autoStart) {
        await this.#autoStart.enable();
      } else {
        await this.#autoStart.disable();
      }
    } catch (error) {
      this.#logger.warn("AutoStart", `设置开机自启失败：${describeError(error)}`);
    }
    if (settings.panelBind === "lan" && settings.firewallAutoAllow) {
      await this.#firewall.ensure();
    } else if (settings.panelBind !== "lan") {
      this.#firewall.markUnmanaged("只在本机访问，不需要防火墙规则");
    } else {
      this.#firewall.markUnmanaged("已关闭自动放行（firewallAutoAllow=false），需要时点「重试放行防火墙」");
    }
    return this.systemSnapshot();
  }

  systemSnapshot() {
    return {
      firewall: this.#firewall?.snapshot ?? null,
      autoStart: this.#autoStart?.snapshot ?? null
    };
  }

  /** Floating marking bar next to the recording window (separate process, same marking path). */
  attachOverlay({ baseUrl }) {
    this.#overlay = new OverlayManager({
      logger: this.#logger,
      baseUrl,
      token: this.#settings.value.panelToken
    });
    if (this.#settings.value.overlayEnabled) this.#overlay.start();
    return this.overlaySnapshot();
  }

  startOverlay() {
    if (!this.#overlay) return { ok: false, message: "悬浮标记条尚未初始化" };
    return this.#overlay.start();
  }

  stopOverlay() {
    this.#overlay?.stop();
    return { ok: true, message: "已关闭" };
  }

  overlaySnapshot() {
    return { enabled: this.#settings.value.overlayEnabled, running: this.#overlay?.running ?? false };
  }

  /** Panel button: try the firewall rule again after the user declined the UAC prompt. */
  async retryFirewall() {
    if (!this.#firewall) return null;
    return this.#firewall.ensure();
  }

  async setAutoStart(enabled) {
    if (!this.#autoStart) return null;
    const result = enabled ? await this.#autoStart.enable() : await this.#autoStart.disable();
    return { ...this.#autoStart.snapshot, ...result };
  }

  #stopWatcher() {
    if (!this.#watcherRunning) return;
    this.#watcherRunning = false;
    this.#watcher.stop();
  }

  #startHotkeys() {
    const settings = this.#settings.value;
    if (!settings.hotkeysEnabled) {
      this.#logger.info("Hotkey", "全局快捷键已在 settings.json 中关闭");
      return;
    }
    if (this.#hotkeysSuspended) {
      this.#logger.info("Hotkey", "正在录制新快捷键，暂时挂起全局快捷键");
      return;
    }
    const reasons = settings.reasons;
    this.#hotkeys.start({
      activator: settings.hotkeyActivator,
      undo: settings.hotkeyUndo,
      armSeconds: settings.hotkeyArmSeconds,
      bindings: settings.hotkeyBindings
        .map((binding) => ({ index: reasons.indexOf(binding.reason), reason: binding.reason, keys: binding.keys }))
        .filter((binding) => binding.index >= 0)
    });
  }

  /** The panel suspends global hotkeys while the user records a new combination. */
  suspendHotkeys() {
    this.#hotkeysSuspended = true;
    this.#hotkeys.stop();
    return this.#hotkeys.snapshot;
  }

  resumeHotkeys() {
    this.#hotkeysSuspended = false;
    this.#startHotkeys();
    return this.#hotkeys.snapshot;
  }

  /**
   * Hotkey path: mark the parcel that is being recorded right now, without leaving PackingProof.
   * A tone tells the packer whether it worked, so no window has to be visible.
   */
  async #handleHotkey(command) {
    if (command?.type === "undo") {
      const id = this.#lastMarkedRecordId;
      if (!id) {
        this.#hotkeys.beep("error");
        this.#logger.warn("Hotkey", "没有可撤销的标记");
        return;
      }
      this.#markChain = this.#markChain.then(async () => {
        try {
          await this.#exceptions.revoke(id, this.#settings.value.operator);
          this.#lastMarkedRecordId = "";
          this.#hotkeys.beep("undo");
          this.#logger.info("Hotkey", `已撤销标记 ${id}`);
        } catch (error) {
          this.#hotkeys.beep("error");
          this.#logger.warn("Hotkey", `撤销失败：${describeError(error)}`);
        }
      });
      await this.#markChain;
      return;
    }

    const index = Number(command?.reasonIndex);
    const reason = Number.isInteger(index) ? this.#settings.value.reasons[index] : "";
    if (!reason) {
      this.#hotkeys.beep("error");
      this.#logger?.warn("Hotkey", `快捷键选择了第 ${index + 1} 个原因，但原因清单里没有这一项`);
      this.#hotkeys.disarm();
      return;
    }

    this.#markChain = this.#markChain.then(async () => {
      const scan = this.#watcher.state.current;
      if (!scan?.trackingNumber) {
        this.#hotkeys.beep("error");
        this.#logger.warn("Hotkey", `快捷键（${reason}）按下，但当前没有正在录制的单号`);
        return;
      }
      try {
        const result = await this.mark({
          trackingNumber: scan.trackingNumber,
          sessionId: scan.sessionId,
          recordingId: scan.recordingId,
          reason,
          operator: this.#settings.value.operator
        });
        this.#lastMarkedRecordId = result.record.id;
        this.#hotkeys.beep("ok");
        this.#logger.info("Hotkey", `快捷键标记 ${scan.trackingNumber} → ${reason}（水印${result.watermark.written ? "已写入" : "未写入"}）`);
      } catch (error) {
        this.#hotkeys.beep("error");
        this.#logger.warn("Hotkey", `快捷键标记失败：${describeError(error)}`);
      }
    });
    await this.#markChain;
  }

  async shutdown() {
    this.#watcher.stop();
    this.#hotkeys.stop();
    this.#overlay?.stop();
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
    await this.#store.flush();
  }

  /**
   * Reuses the stored credential, but only after proving the host still accepts it: installing or
   * reinstalling a package revokes previous authorizations, and then the old credential silently
   * fails forever. A revoked credential is dropped and a fresh authorization is requested, which is
   * what brings the confirmation window back.
   */
  async ensureAuthorized({ force = false } = {}) {
    if (this.#enrolling) return this.#enrolling;
    this.#enrolling = (async () => {
      try {
        const capabilities = await this.#client.capabilities();
        this.#node = {
          id: String(capabilities?.nodeId || ""),
          name: String(capabilities?.nodeName || ""),
          product: String(capabilities?.product || ""),
          version: String(capabilities?.apiVersion || "")
        };
        const identity = await this.#credentials.ensureIdentity();
        if (!force) {
          const saved = await this.#credentials.loadCredential();
          if (saved) {
            this.#client.setCredential(saved);
            const probe = await this.#probeCredential();
            if (probe !== "revoked") {
              this.#auth = {
                status: "authorized",
                message: probe === "unreachable" ? "主机暂时不可达，稍后自动重试" : "",
                permissions: saved.permissions || [],
                capabilities: saved.capabilities || []
              };
              this.#recoveryAttempts = 0;
              this.#logger.info(
                "Auth",
                probe === "ok" ? "已载入本机保存的扩展授权（校验通过）" : "已载入本机保存的扩展授权（主机暂时不可达）"
              );
              this.#startWatcher();
              return this.#auth;
            }
            this.#logger.warn("Auth", "本机保存的授权已被电脑端撤销，正在重新申请授权");
            this.#client.setCredential(null);
            await this.#credentials.clearCredential();
          }
        }

        this.#auth = { status: "enrolling", message: "等待在电脑端确认授权", permissions: [], capabilities: [] };
        const state = await this.#client.enroll(identity);
        await this.#credentials.saveCredential(state);
        this.#auth = {
          status: "authorized",
          message: "",
          permissions: state.permissions,
          capabilities: state.capabilities
        };
        this.#recoveryAttempts = 0;
        this.#warnAboutMissingPermissions(state.permissions);
        this.#logger.info("Auth", "授权完成，已恢复扫码监听");
        this.#startWatcher();
        return this.#auth;
      } catch (error) {
        const code = String(error?.code || "");
        const denied = code.includes("enrollment_denied") || code.includes("enrollment_invalid");
        this.#auth = {
          status: denied ? "denied" : "error",
          message: describeError(error),
          permissions: [],
          capabilities: []
        };
        this.#logger.warn("Auth", `授权未完成：${describeError(error)}`);
        if (!denied) this.#scheduleRecovery();
        return this.#auth;
      } finally {
        this.#enrolling = null;
      }
    })();
    return this.#enrolling;
  }

  async #probeCredential() {
    try {
      await this.#client.activeRecordings();
      return "ok";
    } catch (error) {
      if (error?.isAuthFailure) return "revoked";
      return "unreachable";
    }
  }

  #warnAboutMissingPermissions(permissions) {
    const missing = EXTENSION_IDENTITY.requestedPermissions.filter((permission) => !permissions.includes(permission));
    if (missing.length > 0) {
      this.#logger.warn("Auth", `电脑端未批准以下权限，相关功能会降级：${missing.join(", ")}`);
    }
  }

  /** A revocation must stop polling first, then bring the authorization window back automatically. */
  #handleAuthFailure(error) {
    const code = String(error?.code || "");
    if (!["extension_auth_revoked", "extension_auth_generation_mismatch"].includes(code)) return;
    if (this.#auth.status === "expired" || this.#auth.status === "enrolling") return;
    this.#stopWatcher();
    this.#client.setCredential(null);
    this.#auth = {
      status: "expired",
      message: "电脑端已撤销授权，正在重新申请；请在 PackingProof 弹窗里点允许",
      permissions: [],
      capabilities: []
    };
    this.#logger.warn("Auth", "电脑端撤销了授权，已暂停扫码监听并重新申请授权");
    void this.#credentials.clearCredential();
    this.#scheduleRecovery();
  }

  #scheduleRecovery() {
    if (this.#recoveryTimer || this.#recoveryAttempts >= 3) return;
    this.#recoveryAttempts += 1;
    const delay = 2000 * this.#recoveryAttempts;
    this.#recoveryTimer = setTimeout(() => {
      this.#recoveryTimer = null;
      void this.#recoverAuthorization();
    }, delay);
    this.#recoveryTimer.unref?.();
  }

  async #recoverAuthorization() {
    this.#logger.info("Auth", `重新申请授权（第 ${this.#recoveryAttempts} 次）`);
    await this.ensureAuthorized({ force: true });
  }

  async reauthorize() {
    if (this.#recoveryTimer) {
      clearTimeout(this.#recoveryTimer);
      this.#recoveryTimer = null;
    }
    this.#recoveryAttempts = 0;
    await this.#credentials.clearCredential();
    this.#client.setCredential(null);
    return this.ensureAuthorized({ force: true });
  }

  async reauthorize() {
    await this.#credentials.clearCredential();
    this.#client.setCredential(null);
    return this.ensureAuthorized({ force: true });
  }

  async updateSettings(patch) {
    const before = this.#settings.value;
    const next = await this.#settings.update(patch);
    if (next.host !== this.#client.baseUrl) {
      this.#client.baseUrl = next.host;
      this.#client.setCredential(null);
      await this.#credentials.clearCredential();
      this.#auth = { status: "unknown", message: "主机地址已变更，需要重新授权", permissions: [], capabilities: [] };
      await this.ensureAuthorized({ force: true });
    }
    this.#watcher.setIntervalMs(next.pollIntervalMs);
    const hotkeySignature = (settings) =>
      JSON.stringify([
        settings.hotkeysEnabled,
        settings.hotkeyActivator,
        settings.hotkeyArmSeconds,
        settings.hotkeyUndo,
        settings.hotkeyBindings
      ]);
    if (hotkeySignature(next) !== hotkeySignature(before)) {
      this.#hotkeys.stop();
      this.#startHotkeys();
    }
    if (next.autoStart !== before.autoStart) {
      void this.setAutoStart(next.autoStart);
    }
    if (next.overlayEnabled !== before.overlayEnabled) {
      if (next.overlayEnabled) this.startOverlay();
      else this.stopOverlay();
    }
    return next;
  }

  #startHeartbeat() {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = setInterval(() => {
      void this.#sendHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
    this.#heartbeatTimer.unref?.();
  }

  async #sendHeartbeat() {
    if (!this.#client.isEnrolled) return;
    try {
      await this.#client.heartbeat({
        lastSuccessfulActivityAt: this.#lastActivityAt,
        dataCount: this.#store.all().filter((record) => !record.voided).length
      });
    } catch (error) {
      this.#logger.warn("Heartbeat", `心跳失败：${describeError(error)}`);
    }
  }

  async mark(payload) {
    const result = await this.#exceptions.mark(payload);
    this.#lastActivityAt = new Date().toISOString();
    return result;
  }

  state() {
    return {
      ok: true,
      host: this.#settings.value.host,
      node: this.#node,
      auth: { ...this.#auth },
      settings: {
        operator: this.#settings.value.operator,
        reasons: this.#settings.value.reasons,
        watermarkNamespace: this.#settings.value.watermarkNamespace,
        watermarkField: this.#settings.value.watermarkField,
        panelPort: this.#settings.value.panelPort,
        hotkeysEnabled: this.#settings.value.hotkeysEnabled,
        hotkeyActivator: this.#settings.value.hotkeyActivator,
        hotkeyArmSeconds: this.#settings.value.hotkeyArmSeconds,
        hotkeyModifiers: this.#settings.value.hotkeyModifiers,
        hotkeyBindings: this.#settings.value.hotkeyBindings,
        hotkeyUndo: this.#settings.value.hotkeyUndo,
        panelWindow: this.#settings.value.panelWindow,
        panelBind: this.#settings.value.panelBind,
        autoStart: this.#settings.value.autoStart,
        firewallAutoAllow: this.#settings.value.firewallAutoAllow,
        panelAllowedHosts: this.#settings.value.panelAllowedHosts
      },
      hotkeys: this.#hotkeys.snapshot,
      system: this.systemSnapshot(),
      overlay: this.overlaySnapshot(),
      watcher: this.#watcher.snapshot(),
      stats: this.#exceptions.stats(),
      recent: this.#exceptions.list({}).slice(0, 8),
      dataDirectory: this.#dataDirectory
    };
  }
}
