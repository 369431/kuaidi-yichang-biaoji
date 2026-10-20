import { randomBytes } from "node:crypto";
import { describeError } from "./logger.js";

export const STATUSES = Object.freeze(["pending", "processing", "resolved", "ignored"]);

export const STATUS_LABELS = Object.freeze({
  pending: "待处理",
  processing: "处理中",
  resolved: "已处理",
  ignored: "已忽略"
});

const TRACKING_PATTERN = /^[A-Za-z0-9_-]{3,128}$/;
const MAX_NOTE_LENGTH = 300;
const MAX_HANDLING_NOTE_LENGTH = 1000;

export class UserError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "UserError";
    this.statusCode = statusCode;
  }
}

export function normalizeTrackingNumber(value) {
  const trackingNumber = String(value ?? "")
    .trim()
    .replace(/\s+/g, "");
  if (!TRACKING_PATTERN.test(trackingNumber)) {
    throw new UserError("单号格式无效：只允许字母、数字、- 和 _，长度 3-128");
  }
  return trackingNumber;
}

export function localDateKey(isoValue) {
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatClock(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Text that PackingProof draws as one watermark line: "异常.内物不符: 少件 · 扫码人 · 14:32". */
export function buildWatermarkValue({ reason, note, operator, at = new Date() }) {
  const parts = [String(reason || "").trim()];
  const cleanNote = String(note || "").trim();
  if (cleanNote) parts.push(cleanNote);
  const cleanOperator = String(operator || "").trim();
  parts.push(cleanOperator || "未署名");
  parts.push(formatClock(at));
  return parts.filter(Boolean).join(" · ").slice(0, 200);
}

export class ExceptionService {
  #store;
  #client;
  #settings;
  #watcher;
  #logger;
  #nodeName;

  constructor({ store, client, settings, watcher, logger, nodeName = () => "" }) {
    this.#store = store;
    this.#client = client;
    this.#settings = settings;
    this.#watcher = watcher;
    this.#logger = logger;
    this.#nodeName = nodeName;
  }

  /**
   * Who did it: the explicit operator, then the configured default, then the workstation name that
   * PackingProof reports for this PC (e.g. "电脑1"). Keeps "未署名" only as a last resort.
   */
  #resolveOperator(value) {
    const explicit = String(value || "").trim() || String(this.#settings.value.operator || "").trim();
    if (explicit) return explicit.slice(0, 40);
    const nodeName = String(this.#nodeName() || "").trim();
    return nodeName.slice(0, 40);
  }

  get store() {
    return this.#store;
  }

  /**
   * Marks one parcel as "inner contents do not match". When the matching recording is still running
   * the marker is also written into the video watermark, so the evidence itself carries the reason.
   */
  async mark({ trackingNumber, reason, note = "", operator = "", sessionId = "", recordingId = 0 }) {
    const normalizedTracking = normalizeTrackingNumber(trackingNumber);
    const settings = this.#settings.value;
    const cleanReason = String(reason || "").trim();
    if (!cleanReason) throw new UserError("请选择异常原因");
    if (!settings.reasons.includes(cleanReason)) {
      throw new UserError(`异常原因不在配置清单中：${cleanReason}`);
    }
    const cleanNote = String(note || "").trim().slice(0, MAX_NOTE_LENGTH);
    const cleanOperator = this.#resolveOperator(operator);

    const active = this.#watcher.state.current;
    const effectiveSessionId = String(sessionId || active?.sessionId || "").trim();
    const isActiveSession = Boolean(active && effectiveSessionId && active.sessionId === effectiveSessionId);
    const now = new Date();
    const watermarkValue = buildWatermarkValue({ reason: cleanReason, note: cleanNote, operator: cleanOperator, at: now });

    const existing = this.#findMarkableRecord(effectiveSessionId, normalizedTracking, now);
    const record = existing || {
      id: `ex-${randomBytes(6).toString("hex")}`,
      trackingNumber: normalizedTracking,
      createdAt: now.toISOString(),
      watermark: false,
      watermarkValue: "",
      watermarkMessage: "",
      sessionId: effectiveSessionId,
      recordingId: Number(recordingId) || Number(active?.recordingId) || 0,
      mode: String(active?.mode || ""),
      voided: false,
      handler: "",
      handlingNote: "",
      resolvedAt: null,
      history: []
    };

    record.trackingNumber = normalizedTracking;
    record.reason = cleanReason;
    record.note = cleanNote;
    record.operator = cleanOperator;
    record.status = record.status && record.status !== "ignored" ? record.status : "pending";
    record.updatedAt = now.toISOString();
    if (effectiveSessionId) record.sessionId = effectiveSessionId;
    if (!record.recordingId) record.recordingId = Number(recordingId) || Number(active?.recordingId) || 0;
    record.watermarkValue = watermarkValue;

    const action = existing ? "updated" : "marked";
    record.history = [
      ...(record.history || []),
      {
        at: now.toISOString(),
        action,
        operator: cleanOperator,
        detail: `${cleanReason}${cleanNote ? `：${cleanNote}` : ""}`
      }
    ].slice(-50);

    const watermark = await this.#applyWatermark(record, isActiveSession, watermarkValue);
    record.watermark = watermark.written;
    record.watermarkMessage = watermark.message;

    this.#store.upsert(record);
    await this.#store.flush();
    this.#logger?.info(
      "Exception",
      `${action === "marked" ? "新增" : "更新"}异常 ${normalizedTracking} / ${cleanReason} / 水印=${watermark.written ? "已写入" : `未写入(${watermark.message})`}`
    );
    return { record: this.#decorate(record), watermark };
  }

  #findMarkableRecord(sessionId, trackingNumber, now) {
    if (sessionId) {
      const bySession = this.#store.find(
        (record) => !record.voided && record.sessionId === sessionId && record.trackingNumber === trackingNumber
      );
      if (bySession) return this.#store.get(bySession.id);
    }
    const recent = this.#store.all().filter((record) => {
      if (record.voided) return false;
      if (record.trackingNumber !== trackingNumber) return false;
      if (!["pending", "processing"].includes(record.status)) return false;
      const created = Date.parse(record.createdAt || "");
      return !Number.isNaN(created) && now.getTime() - created < 15 * 60 * 1000;
    });
    if (recent.length === 0) return null;
    const latest = recent.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0];
    return this.#store.get(latest.id);
  }

  async #applyWatermark(record, isActiveSession, value) {
    if (!isActiveSession) {
      return { written: false, message: "录像已结束，水印未写入（异常记录已保存）" };
    }
    if (!this.#client.isEnrolled) {
      return { written: false, message: "未授权，水印未写入（异常记录已保存）" };
    }
    if (!this.#client.hasPermission("recording-fields.write")) {
      return { written: false, message: "电脑端未批准录像字段写入权限，水印未写入" };
    }
    const settings = this.#settings.value;
    try {
      await this.#client.writeRecordingFields(record.sessionId, {
        namespace: settings.watermarkNamespace,
        field: settings.watermarkField,
        value
      });
      return { written: true, message: "已写入录像水印" };
    } catch (error) {
      const message = error?.code === "recording_not_active" ? "录像已结束，水印未写入" : describeError(error);
      this.#logger?.warn("Watermark", `写入水印失败：${message}`);
      return { written: false, message };
    }
  }

  /** Revokes a wrong mark. The record stays for audit and the watermark line is rewritten as revoked. */
  async revoke(id, operator = "") {
    const record = this.#requireRecord(id);
    if (record.voided) return { record: this.#decorate(record), watermark: { written: false, message: "已是撤销状态" } };
    const now = new Date();
    const cleanOperator = this.#resolveOperator(operator);
    const active = this.#watcher.state.current;
    const isActiveSession = Boolean(active && record.sessionId && active.sessionId === record.sessionId);
    const value = `已撤销：${record.reason || ""} · ${cleanOperator || "未署名"} · ${formatClock(now)}`;
    const watermark = await this.#applyWatermark(record, isActiveSession, value);
    record.voided = true;
    record.status = "ignored";
    record.updatedAt = now.toISOString();
    record.history = [
      ...(record.history || []),
      { at: now.toISOString(), action: "revoked", operator: cleanOperator, detail: "撤销误标" }
    ].slice(-50);
    this.#store.upsert(record);
    await this.#store.flush();
    return { record: this.#decorate(record), watermark };
  }

  /** Moves a record through the handling workflow (待处理 → 处理中 → 已处理 / 已忽略). */
  async setStatus(id, status, { operator = "", handlingNote = "" } = {}) {
    if (!STATUSES.includes(status)) throw new UserError(`未知状态：${status}`);
    const record = this.#requireRecord(id);
    const now = new Date();
    const cleanOperator = this.#resolveOperator(operator);
    const cleanNote = String(handlingNote || "").trim().slice(0, MAX_HANDLING_NOTE_LENGTH);
    const previous = record.status;

    record.status = status;
    record.updatedAt = now.toISOString();
    if (cleanOperator) record.handler = cleanOperator;
    if (cleanNote) record.handlingNote = cleanNote;
    record.resolvedAt = status === "resolved" ? record.resolvedAt || now.toISOString() : null;
    record.history = [
      ...(record.history || []),
      {
        at: now.toISOString(),
        action: "status",
        operator: cleanOperator,
        detail: `${STATUS_LABELS[previous] || previous} → ${STATUS_LABELS[status]}${cleanNote ? `：${cleanNote}` : ""}`
      }
    ].slice(-50);
    this.#store.upsert(record);
    await this.#store.flush();
    this.#logger?.info("Exception", `${record.trackingNumber} 状态 ${previous} → ${status}`);
    return this.#decorate(record);
  }

  async addHandlingNote(id, { note = "", operator = "" } = {}) {
    const cleanNote = String(note || "").trim().slice(0, MAX_HANDLING_NOTE_LENGTH);
    if (!cleanNote) throw new UserError("处理备注不能为空");
    const record = this.#requireRecord(id);
    const now = new Date();
    const cleanOperator = this.#resolveOperator(operator);
    record.handlingNote = cleanNote;
    if (cleanOperator) record.handler = cleanOperator;
    record.updatedAt = now.toISOString();
    record.history = [
      ...(record.history || []),
      { at: now.toISOString(), action: "note", operator: cleanOperator, detail: cleanNote }
    ].slice(-50);
    this.#store.upsert(record);
    await this.#store.flush();
    return this.#decorate(record);
  }

  list({ status = "", from = "", to = "", q = "", includeVoided = false } = {}) {
    const statuses = String(status || "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => STATUSES.includes(value));
    const keyword = String(q || "").trim().toLowerCase();
    return this.#store
      .all()
      .filter((record) => (includeVoided ? true : !record.voided))
      .filter((record) => (statuses.length === 0 ? true : statuses.includes(record.status)))
      .filter((record) => (from ? localDateKey(record.createdAt) >= from : true))
      .filter((record) => (to ? localDateKey(record.createdAt) <= to : true))
      .filter((record) => {
        if (!keyword) return true;
        return [record.trackingNumber, record.reason, record.note, record.handlingNote, record.operator, record.handler]
          .some((value) => String(value || "").toLowerCase().includes(keyword));
      })
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .map((record) => this.#decorate(record));
  }

  stats() {
    const records = this.#store.all();
    const today = localDateKey(new Date().toISOString());
    const countBy = (status) => records.filter((record) => record.status === status && !record.voided).length;
    return {
      total: records.filter((record) => !record.voided).length,
      pending: countBy("pending"),
      processing: countBy("processing"),
      resolved: countBy("resolved"),
      ignored: countBy("ignored"),
      revoked: records.filter((record) => record.voided).length,
      today: records.filter((record) => !record.voided && localDateKey(record.createdAt) === today).length
    };
  }

  csv(records) {
    const header = [
      "单号",
      "异常原因",
      "标记备注",
      "状态",
      "操作员",
      "标记时间",
      "录像会话",
      "录像ID",
      "水印写入",
      "处理备注",
      "处理人",
      "处理时间"
    ];
    const rows = records.map((record) => [
      record.trackingNumber,
      record.reason,
      record.note,
      record.voided ? "已撤销" : STATUS_LABELS[record.status] || record.status,
      record.operator,
      formatLocal(record.createdAt),
      record.sessionId,
      record.recordingId ? String(record.recordingId) : "",
      record.watermark ? "是" : `否（${record.watermarkMessage || ""}）`,
      record.handlingNote,
      record.handler,
      formatLocal(record.resolvedAt)
    ]);
    return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  }

  #requireRecord(id) {
    const record = this.#store.get(String(id || ""));
    if (!record) throw new UserError("异常记录不存在", 404);
    return record;
  }

  #decorate(record) {
    return {
      ...record,
      statusLabel: record.voided ? "已撤销" : STATUS_LABELS[record.status] || record.status,
      history: [...(record.history || [])]
    };
  }
}

function formatLocal(isoValue) {
  if (!isoValue) return "";
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function csvCell(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}
