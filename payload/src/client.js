import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

export const EXTENSION_IDENTITY = Object.freeze({
  providerId: "369431.inner-mismatch",
  displayName: "内物不符异常标记",
  version: "1.1.8",
  source: "https://github.com/369431/kuaidi-yichang-biaoji",
  requestedPermissions: Object.freeze([
    "recordings.active.read",
    "recording-fields.write",
    "recordings.search",
    "recordings.download"
  ]),
  requestedCapabilities: Object.freeze([])
});

export const SIGNATURE_VERSION = "1";
export const SIGNATURE_PREFIX = "packingproof-extension-request-v1";

export const AUTH_ERROR_CODES = Object.freeze([
  "extension_auth_required",
  "extension_auth_revoked",
  "extension_auth_generation_mismatch",
  "extension_auth_signature_invalid",
  "extension_auth_content_hash_mismatch",
  "extension_auth_timestamp_stale",
  "extension_auth_version_unsupported",
  "extension_disabled"
]);

export class PackingProofError extends Error {
  constructor(message, { status = 0, code = "", body = null } = {}) {
    super(message);
    this.name = "PackingProofError";
    this.status = status;
    this.code = code;
    this.body = body;
  }

  get isAuthFailure() {
    return AUTH_ERROR_CODES.includes(this.code);
  }
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function hexToKey(credential) {
  const normalized = String(credential || "").trim();
  if (normalized.length !== 64 || !/^[0-9a-f]+$/i.test(normalized)) {
    throw new PackingProofError("扩展凭据格式无效，需要 64 位十六进制字符串");
  }
  return Buffer.from(normalized, "hex");
}

/**
 * Canonical string signed by every extension request. Order and newlines are part of the protocol:
 * packingproof-extension-request-v1 \n 1 \n generation \n METHOD \n target \n timestamp \n nonce \n
 * body-sha256 \n extensionInstanceId
 */
export function buildSignaturePayload({ method, target, timestamp, nonce, contentHash, generation, extensionInstanceId }) {
  return [
    SIGNATURE_PREFIX,
    SIGNATURE_VERSION,
    String(generation),
    String(method).toUpperCase(),
    String(target),
    String(timestamp),
    String(nonce).toLowerCase(),
    String(contentHash),
    String(extensionInstanceId)
  ].join("\n");
}

export function signRequest({ credential, method, target, body = Buffer.alloc(0), generation, extensionInstanceId, now = Date.now() }) {
  const timestamp = Math.floor(now / 1000);
  const nonce = randomBytes(16).toString("hex");
  const contentHash = sha256Hex(body);
  const canonical = buildSignaturePayload({ method, target, timestamp, nonce, contentHash, generation, extensionInstanceId });
  const signature = createHmac("sha256", hexToKey(credential)).update(canonical, "utf8").digest("hex");
  return { timestamp, nonce, contentHash, signature };
}

export function signatureHeaders({ credential, method, target, body, generation, extensionInstanceId, now }) {
  const { timestamp, nonce, contentHash, signature } = signRequest({
    credential,
    method,
    target,
    body,
    generation,
    extensionInstanceId,
    now
  });
  return {
    "X-PackingProof-Extension-Version": SIGNATURE_VERSION,
    "X-PackingProof-Extension-Id": String(extensionInstanceId),
    "X-PackingProof-Extension-Credential-Generation": String(generation),
    "X-PackingProof-Extension-Timestamp": String(timestamp),
    "X-PackingProof-Extension-Nonce": nonce,
    "X-PackingProof-Extension-Content-SHA256": contentHash,
    "X-PackingProof-Extension-Signature": signature
  };
}

async function readBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export class PackingProofClient {
  #baseUrl;
  #logger;
  #credential = null;
  #onAuthFailure;

  constructor({ baseUrl, logger, onAuthFailure } = {}) {
    this.#baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.#logger = logger;
    this.#onAuthFailure = onAuthFailure;
  }

  set baseUrl(value) {
    this.#baseUrl = String(value || "").replace(/\/+$/, "");
  }

  get baseUrl() {
    return this.#baseUrl;
  }

  get credentialState() {
    return this.#credential;
  }

  setCredential(state) {
    this.#credential = state || null;
  }

  get isEnrolled() {
    return Boolean(this.#credential?.credential && this.#credential?.extensionInstanceId);
  }

  get credentialGeneration() {
    return this.#credential?.credentialGeneration ?? 1;
  }

  get permissionSummary() {
    return Array.isArray(this.#credential?.permissions) ? this.#credential.permissions : [];
  }

  hasPermission(permission) {
    return this.permissionSummary.includes(permission);
  }

  async capabilities() {
    const response = await fetch(`${this.#baseUrl}/api/extensions/v1/capabilities`, {
      signal: AbortSignal.timeout(8000)
    });
    const data = await readBody(response);
    if (!response.ok) {
      throw new PackingProofError(`读取扩展能力失败：HTTP ${response.status}`, { status: response.status, body: data });
    }
    return data;
  }

  /**
   * Requests authorization. PackingProof shows a confirmation window on the PC: this call can block
   * for as long as the user needs, so it uses a long timeout instead of failing fast.
   */
  async enroll(identity) {
    const payload = {
      requestId: `enroll-${randomBytes(12).toString("hex")}`,
      requestSecret: randomBytes(32).toString("hex"),
      extensionInstanceId: identity.extensionInstanceId,
      providerId: EXTENSION_IDENTITY.providerId,
      displayName: EXTENSION_IDENTITY.displayName,
      version: EXTENSION_IDENTITY.version,
      source: EXTENSION_IDENTITY.source,
      requestedPermissions: [...EXTENSION_IDENTITY.requestedPermissions],
      requestedCapabilities: [...EXTENSION_IDENTITY.requestedCapabilities]
    };
    this.#logger?.info("Enroll", "正在向 PackingProof 申请授权，请在电脑端弹窗中确认");
    const response = await fetch(`${this.#baseUrl}/api/extensions/v1/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300000)
    });
    const data = await readBody(response);
    if (!response.ok || !data?.credential) {
      const code = data?.errorCode || `enroll_http_${response.status}`;
      throw new PackingProofError(data?.error || `授权失败（HTTP ${response.status}）`, {
        status: response.status,
        code,
        body: data
      });
    }
    const state = {
      extensionInstanceId: data.extensionInstanceId || identity.extensionInstanceId,
      credential: data.credential,
      credentialGeneration: Number(data.credentialGeneration) || 1,
      permissions: Array.isArray(data.permissions) ? data.permissions : [],
      capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
      routingScope: data.routingScope || "",
      boundOriginNodeIds: Array.isArray(data.boundOriginNodeIds) ? data.boundOriginNodeIds : [],
      approvedAt: data.approvedAtUtc || new Date().toISOString()
    };
    this.#credential = state;
    this.#logger?.info(
      "Enroll",
      `授权成功，权限=${state.permissions.join(",") || "无"}，绑定=${state.routingScope || "未知"}`
    );
    return state;
  }

  async #signed(method, target, payload, { headers = {}, timeoutMs = 20000, rawBody = null } = {}) {
    if (!this.isEnrolled) {
      throw new PackingProofError("尚未获得授权，请先在电脑端确认扩展授权", { code: "extension_auth_required" });
    }
    const body = rawBody ?? (payload === undefined || payload === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload), "utf8"));
    const signed = signatureHeaders({
      credential: this.#credential.credential,
      method,
      target,
      body,
      generation: this.credentialGeneration,
      extensionInstanceId: this.#credential.extensionInstanceId
    });
    const requestHeaders = { ...signed, ...headers };
    if (body.length > 0) requestHeaders["Content-Type"] = "application/json";
    const response = await fetch(`${this.#baseUrl}${target}`, {
      method,
      headers: requestHeaders,
      body: body.length > 0 ? body : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      const data = await readBody(response).catch(() => null);
      const code = data?.errorCode || `http_${response.status}`;
      const error = new PackingProofError(data?.error || `PackingProof HTTP ${response.status}`, {
        status: response.status,
        code,
        body: data
      });
      if (error.isAuthFailure) {
        this.#logger?.warn("Auth", `扩展签名被拒绝：${code}`);
        this.#onAuthFailure?.(error);
      }
      throw error;
    }
    return response;
  }

  async activeRecordings() {
    const response = await this.#signed("GET", "/api/extensions/v1/recordings/active");
    const data = await readBody(response);
    const recordings = Array.isArray(data?.recordings) ? data.recordings : [];
    return recordings.map((record) => ({
      sessionId: String(record.recordingSessionId || ""),
      recordingId: Number(record.videoRecordId) || 0,
      trackingNumber: String(record.trackingNumber || "").trim(),
      orderId: String(record.orderId || "").trim(),
      mode: String(record.mode || "").trim(),
      startTime: String(record.startTime || "")
    }));
  }

  /** Writes the exception line into the live recording watermark. PackingProof only accepts this while recording. */
  async writeRecordingFields(sessionId, { namespace, field, value }) {
    const target = `/api/extensions/v1/recordings/${encodeURIComponent(sessionId)}/data`;
    const response = await this.#signed("POST", target, {
      namespace,
      providerId: EXTENSION_IDENTITY.providerId,
      fields: { [field]: value }
    });
    return readBody(response);
  }

  async heartbeat({ version = EXTENSION_IDENTITY.version, lastSuccessfulActivityAt = null, dataCount = 0 } = {}) {
    const response = await this.#signed("POST", "/api/extensions/v1/heartbeat", {
      version,
      capabilities: [...EXTENSION_IDENTITY.requestedCapabilities],
      lastSuccessfulActivityAt,
      dataCount
    });
    return readBody(response);
  }

  async createRecordingQuery(trackingNumber) {
    const response = await this.#signed("POST", "/api/extensions/v1/recording-queries", { trackingNumber });
    return readBody(response);
  }

  async recordingQuery(queryId) {
    const response = await this.#signed(
      "GET",
      `/api/extensions/v1/recording-queries/${encodeURIComponent(queryId)}`
    );
    return readBody(response);
  }

  /** Returns the raw response so the panel can stream (and seek within) the video. */
  async downloadRecording(queryId, recordingId, { range } = {}) {
    const target = `/api/extensions/v1/recording-queries/${encodeURIComponent(queryId)}/recordings/${recordingId}/download`;
    const headers = {};
    if (range) headers.Range = range;
    return this.#signed("GET", target, undefined, { headers, timeoutMs: 120000 });
  }
}

export function newRequestId() {
  return randomUUID();
}
