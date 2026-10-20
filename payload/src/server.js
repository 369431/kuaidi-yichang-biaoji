import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createHostGuard, createTokenGuard } from "./netguard.js";
import { EXTENSION_IDENTITY } from "./client.js";
import { UserError } from "./exceptions.js";
import { parseKeySpec } from "./keymap.js";
import { describeError } from "./logger.js";

const PUBLIC_DIRECTORY = fileURLToPath(new URL("./public/", import.meta.url));
const MAX_BODY_BYTES = 256 * 1024;

const STATIC_ROUTES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/manage", { file: "manage.html", type: "text/html; charset=utf-8" }],
  ["/manage.html", { file: "manage.html", type: "text/html; charset=utf-8" }],
  ["/assets/style.css", { file: "style.css", type: "text/css; charset=utf-8" }],
  ["/assets/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/assets/manage.js", { file: "manage.js", type: "text/javascript; charset=utf-8" }]
]);

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'"
};

export function createPanelServer({ runtime, logger, access = {} }) {
  const isAllowedHost = createHostGuard({
    extraHostnames: access.extraHostnames || [],
    allowAnyAddress: access.bind === "any"
  });
  const tokenGuard = createTokenGuard(access.token || "");
  // Kept by reference so the caller can fill in URLs after the listener knows its port.
  const accessState = access;
  accessState.tokenRequired = tokenGuard.required;
  accessState.bind = access.bind || "loopback";
  if (!Array.isArray(accessState.urls)) accessState.urls = [];
  const server = createServer((request, response) => {
    void handleRequest({ runtime, logger, request, response, isAllowedHost, tokenGuard, accessState });
  });
  server.keepAliveTimeout = 5000;
  return server;
}

/** Binds the panel to loopback or, when LAN access is on, to every interface. */
export async function listenPanel(server, preferredPort, logger, { address = "127.0.0.1" } = {}) {
  // Port 0 means "any free port" (used by tests); otherwise try the configured port and the next few.
  const candidates = preferredPort === 0 ? [0] : [preferredPort, ...Array.from({ length: 9 }, (_, index) => preferredPort + index + 1)];
  for (const port of candidates) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, address);
      });
      const actual = server.address();
      return typeof actual === "object" && actual ? actual.port : port;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
      logger?.warn("Panel", `端口 ${port} 已被占用，尝试下一个`);
    }
  }
  throw new Error("面板端口 8792-8801 全部被占用，请先关闭占用程序或修改 settings.json");
}

async function handleRequest({ runtime, logger, request, response, isAllowedHost, tokenGuard, accessState }) {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const pathname = decodeURIComponent(url.pathname).replace(/\/+$/, "") || "/";
  try {
    // The panel may be reachable from the LAN, so the Host header must belong to this machine.
    // Otherwise a hostile web page could point its own domain at 192.168.x.x and talk to us.
    if (!isAllowedHost(request.headers.host)) {
      sendJson(response, 403, { ok: false, error: "拒绝访问：请用本机地址或本机局域网 IP 打开面板" });
      return;
    }

    const tokenResult = tokenGuard.check(url, request.headers);
    if (!tokenResult.ok) {
      const body = Buffer.from(
        "<!doctype html><meta charset=\"utf-8\"><title>需要访问令牌</title><body style=\"font-family:system-ui;padding:40px\"><h2>需要访问令牌</h2><p>请在地址后面加上 <code>?token=你的令牌</code>，令牌在插件控制台或 settings.json 里。</p></body>",
        "utf8"
      );
      response.writeHead(401, { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length });
      response.end(body);
      return;
    }
    if (tokenResult.setCookie) response.setHeader("Set-Cookie", tokenResult.setCookie);

    if (request.method === "OPTIONS") {
      response.writeHead(204, { ...SECURITY_HEADERS, Allow: "GET, POST" });
      response.end();
      return;
    }

    const staticEntry = STATIC_ROUTES.get(pathname);
    if (staticEntry && (request.method === "GET" || request.method === "HEAD")) {
      await serveStatic(response, staticEntry);
      return;
    }

    if (!pathname.startsWith("/api/")) {
      sendJson(response, 404, { ok: false, error: "未找到该页面" });
      return;
    }

    if (request.method === "POST" && !isSameOrigin(request)) {
      sendJson(response, 403, { ok: false, error: "拒绝跨站请求" });
      return;
    }

    if (pathname === "/api/state" && request.method === "GET") {
      sendJson(response, 200, { ...runtime.state(), access: accessState });
      return;
    }

    if (pathname === "/api/health" && request.method === "GET") {
      sendJson(response, 200, {
        ok: true,
        app: "369431.inner-mismatch",
        version: EXTENSION_IDENTITY.version,
        pid: process.pid,
        at: new Date().toISOString()
      });
      return;
    }

    // A newly started version asks the old instance to exit, so upgrading never leaves the old panel
    // holding the port and the shortcuts. Loopback only.
    if (pathname === "/api/system/shutdown" && request.method === "POST") {
      const remote = String(request.socket.remoteAddress || "");
      const isLocal = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
      if (!isLocal) {
        sendJson(response, 403, { ok: false, error: "只允许本机请求关闭" });
        return;
      }
      sendJson(response, 200, { ok: true });
      setTimeout(() => accessState.onShutdown?.(), 150).unref?.();
      return;
    }

    // Restart in a hidden window (the panel process replaces itself).
    if (pathname === "/api/system/restart" && request.method === "POST") {
      const remote = String(request.socket.remoteAddress || "");
      const isLocal = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
      if (!isLocal) {
        sendJson(response, 403, { ok: false, error: "只允许本机请求重启" });
        return;
      }
      sendJson(response, 200, { ok: true });
      setTimeout(() => accessState.onRestart?.(), 150).unref?.();
      return;
    }

    if (pathname === "/api/settings" && request.method === "POST") {
      const body = await readJson(request);
      const patch = {
        operator: body.operator,
        reasons: body.reasons,
        panelPort: body.panelPort,
        autoStart: body.autoStart,
        firewallAutoAllow: body.firewallAutoAllow,
        panelAllowedHosts: body.panelAllowedHosts
      };
      if (body.resetHotkeys === true) {
        patch.hotkeyBindings = [];
        patch.hotkeyUndo = null;
        patch.hotkeyActivator = null;
        patch.hotkeyArmSeconds = null;
      } else {
        if (body.hotkeyBindings !== undefined) patch.hotkeyBindings = body.hotkeyBindings;
        if (body.hotkeyUndo !== undefined) patch.hotkeyUndo = body.hotkeyUndo;
        if (body.hotkeyActivator !== undefined) patch.hotkeyActivator = body.hotkeyActivator;
        if (body.hotkeyArmSeconds !== undefined) patch.hotkeyArmSeconds = body.hotkeyArmSeconds;
      }
      const updated = await runtime.updateSettings(patch);
      sendJson(response, 200, { ok: true, settings: updated, state: runtime.state() });
      return;
    }

    if (pathname === "/api/hotkeys/suspend" && request.method === "POST") {
      const hotkeys = runtime.suspendHotkeys();
      sendJson(response, 200, { ok: true, hotkeys });
      return;
    }

    if (pathname === "/api/hotkeys/resume" && request.method === "POST") {
      const hotkeys = runtime.resumeHotkeys();
      sendJson(response, 200, { ok: true, hotkeys });
      return;
    }

    if (pathname === "/api/hotkeys/validate" && request.method === "POST") {
      const body = await readJson(request);
      const spec = parseKeySpec(body.keys);
      sendJson(response, 200, { ok: true, valid: spec.ok, label: spec.ok ? spec.label : "", error: spec.ok ? "" : spec.error });
      return;
    }

    if (pathname === "/api/overlay-ui" && request.method === "GET") {
      // Labels live here (not in overlay.ps1) so the PowerShell file can stay pure ASCII.
      sendJson(response, 200, {
        ok: true,
        labels: {
          title: "内物不符标记",
          waiting: "等待扫码…",
          waitingHint: "在 PackingProof 里扫码开始录制",
          recording: "录像中 · 点原因即可标记",
          stopped: "录像已结束 · 标记只保存，不写水印",
          notRecording: "当前没有正在录制的单号",
          notAuthorized: "未授权，请在面板里重新授权",
          offline: "面板未连接，正在重试…",
          undo: "撤销上一条",
          revoked: "已撤销上一条",
          nothingToUndo: "还没有可撤销的标记",
          failed: "标记失败"
        },
        reasons: runtime.state().settings.reasons
      });
      return;
    }

    if (pathname === "/api/overlay" && request.method === "POST") {
      const body = await readJson(request);
      const enabled = body.enabled !== false;
      await runtime.updateSettings({ overlayEnabled: enabled });
      const result = enabled ? runtime.startOverlay() : runtime.stopOverlay();
      sendJson(response, 200, { ok: true, overlay: result, state: runtime.state() });
      return;
    }

    if (pathname === "/api/system/firewall" && request.method === "POST") {
      const status = await runtime.retryFirewall();
      sendJson(response, 200, { ok: status?.state === "ready", firewall: status, state: runtime.state() });
      return;
    }

    if (pathname === "/api/enroll" && request.method === "POST") {
      const auth = await runtime.reauthorize();
      sendJson(response, 200, { ok: auth.status === "authorized", auth, state: runtime.state() });
      return;
    }

    if (pathname === "/api/mark" && request.method === "POST") {
      const body = await readJson(request);
      const result = await runtime.mark({
        trackingNumber: body.trackingNumber,
        reason: body.reason,
        note: body.note,
        operator: body.operator,
        sessionId: body.sessionId,
        recordingId: body.recordingId
      });
      sendJson(response, 200, { ok: true, ...result, state: runtime.state() });
      return;
    }

    if (pathname === "/api/revoke" && request.method === "POST") {
      const body = await readJson(request);
      const result = await runtime.exceptions.revoke(body.id, body.operator);
      sendJson(response, 200, { ok: true, ...result, state: runtime.state() });
      return;
    }

    if (pathname === "/api/status" && request.method === "POST") {
      const body = await readJson(request);
      const record = await runtime.exceptions.setStatus(body.id, body.status, {
        operator: body.operator,
        handlingNote: body.handlingNote
      });
      sendJson(response, 200, { ok: true, record, stats: runtime.exceptions.stats() });
      return;
    }

    if (pathname === "/api/note" && request.method === "POST") {
      const body = await readJson(request);
      const record = await runtime.exceptions.addHandlingNote(body.id, {
        note: body.note,
        operator: body.operator
      });
      sendJson(response, 200, { ok: true, record, stats: runtime.exceptions.stats() });
      return;
    }

    if (pathname === "/api/records" && request.method === "GET") {
      const records = runtime.exceptions.list({
        status: url.searchParams.get("status") || "",
        from: url.searchParams.get("from") || "",
        to: url.searchParams.get("to") || "",
        q: url.searchParams.get("q") || ""
      });
      const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
      const size = Math.min(200, Math.max(10, Number(url.searchParams.get("size")) || 50));
      sendJson(response, 200, {
        ok: true,
        total: records.length,
        page,
        size,
        records: records.slice((page - 1) * size, page * size),
        stats: runtime.exceptions.stats()
      });
      return;
    }

    if (pathname === "/api/export.csv" && request.method === "GET") {
      const records = runtime.exceptions.list({
        status: url.searchParams.get("status") || "",
        from: url.searchParams.get("from") || "",
        to: url.searchParams.get("to") || "",
        q: url.searchParams.get("q") || "",
        includeVoided: true
      });
      const csv = runtime.exceptions.csv(records);
      const stamp = new Date().toISOString().slice(0, 10);
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="inner-mismatch-${stamp}.csv"`,
        "Cache-Control": "no-store"
      });
      response.end(`\uFEFF${csv}`);
      return;
    }

    if (pathname === "/api/evidence" && request.method === "POST") {
      const body = await readJson(request);
      const snapshot = await runtime.evidence.start(String(body.trackingNumber || "").trim());
      sendJson(response, 200, { ok: true, snapshot });
      return;
    }

    const evidenceMatch = /^\/api\/evidence\/([A-Za-z0-9]+)(?:\/(\d+)\/stream)?$/.exec(pathname);
    if (evidenceMatch) {
      const [, queryId, recordingId] = evidenceMatch;
      if (recordingId && request.method === "GET") {
        await streamEvidence({ runtime, request, response, queryId, recordingId });
        return;
      }
      if (request.method === "GET") {
        const snapshot = await runtime.evidence.poll(queryId);
        sendJson(response, 200, { ok: true, snapshot });
        return;
      }
    }

    sendJson(response, 404, { ok: false, error: "接口不存在" });
  } catch (error) {
    const statusCode = error instanceof UserError ? error.statusCode : 500;
    if (statusCode >= 500) {
      logger?.error("Panel", `${request.method} ${pathname} 处理失败`, error);
    }
    if (!response.headersSent) {
      sendJson(response, statusCode, {
        ok: false,
        error: describeError(error),
        code: error?.code || ""
      });
    } else {
      response.end();
    }
  }
}

async function serveStatic(response, entry) {
  const filePath = path.join(PUBLIC_DIRECTORY, entry.file);
  try {
    const info = await stat(filePath);
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": entry.type,
      "Content-Length": info.size,
      "Cache-Control": "no-store"
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
    response.end("资源不存在");
  }
}

async function streamEvidence({ runtime, request, response, queryId, recordingId }) {
  const range = request.headers.range;
  const upstream = await runtime.evidence.stream(queryId, recordingId, range);
  const headers = { ...SECURITY_HEADERS, "Cache-Control": "no-store" };
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  if (!headers["content-type"]) headers["content-type"] = "video/mp4";
  response.writeHead(upstream.status, headers);
  if (!upstream.body) {
    response.end();
    return;
  }
  const stream = Readable.fromWeb(upstream.body);
  stream.on("error", () => response.destroy());
  request.on("close", () => stream.destroy());
  stream.pipe(response);
}

function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const host = request.headers.host || "";
    return parsed.host === host && ["127.0.0.1", "localhost"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new UserError("请求内容过大", 413));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", reject);
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        const value = JSON.parse(text);
        resolve(value && typeof value === "object" ? value : {});
      } catch {
        reject(new UserError("请求内容不是有效 JSON"));
      }
    });
  });
}

function sendJson(response, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store"
  });
  response.end(body);
}

/** Reads a static asset once; used by tests and by the launcher's self-check. */
export async function readAsset(name) {
  return readFile(path.join(PUBLIC_DIRECTORY, name), "utf8");
}
