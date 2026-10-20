import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SettingsStore } from "../payload/src/config.js";
import { ExceptionService, UserError, buildWatermarkValue, normalizeTrackingNumber } from "../payload/src/exceptions.js";
import { ExceptionStore } from "../payload/src/store.js";

const silentLogger = { info() {}, warn() {}, error() {} };

async function createService({ recording, nodeName } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "inm-exc-"));
  const settings = new SettingsStore(directory);
  await settings.load();
  await settings.update({ operator: "张三" });
  const store = new ExceptionStore(directory, silentLogger);
  await store.load();

  const writes = [];
  const client = {
    isEnrolled: true,
    hasPermission: () => true,
    writeRecordingFields: async (sessionId, payload) => {
      writes.push({ sessionId, payload });
      return { apiVersion: "v1" };
    }
  };
  const watcher = { state: { current: recording ?? null } };
  const service = new ExceptionService({
    store,
    client,
    settings,
    watcher,
    logger: silentLogger,
    nodeName: nodeName ? () => nodeName : undefined
  });
  return {
    service,
    store,
    settings,
    writes,
    watcher,
    client,
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

const ACTIVE = {
  sessionId: "session-abc",
  recordingId: 42,
  trackingNumber: "YT1234567890",
  mode: "发货",
  startTime: new Date().toISOString()
};

test("marking during a recording writes the exception into the watermark", async () => {
  const ctx = await createService({ recording: ACTIVE });
  try {
    const result = await ctx.service.mark({
      trackingNumber: ACTIVE.trackingNumber,
      reason: "少件",
      note: "少了 1 件 A",
      operator: "李四"
    });
    assert.equal(result.watermark.written, true);
    assert.equal(ctx.writes.length, 1);
    assert.equal(ctx.writes[0].sessionId, "session-abc");
    assert.equal(ctx.writes[0].payload.namespace, "异常");
    assert.equal(ctx.writes[0].payload.field, "内物不符");
    const value = ctx.writes[0].payload.value;
    assert.match(value, /^少件 · 少了 1 件 A · 李四 · \d{2}:\d{2}$/);

    assert.equal(result.record.status, "pending");
    assert.equal(result.record.trackingNumber, "YT1234567890");
    assert.equal(ctx.store.all().length, 1);
  } finally {
    await ctx.cleanup();
  }
});

test("marking the same parcel twice in one session updates instead of duplicating", async () => {
  const ctx = await createService({ recording: ACTIVE });
  try {
    const first = await ctx.service.mark({ trackingNumber: ACTIVE.trackingNumber, reason: "少件" });
    const second = await ctx.service.mark({ trackingNumber: ACTIVE.trackingNumber, reason: "错件", note: "改成错件" });
    assert.equal(first.record.id, second.record.id);
    assert.equal(ctx.store.all().length, 1);
    assert.equal(second.record.reason, "错件");
    assert.equal(second.record.history.filter((item) => item.action === "updated").length, 1);
  } finally {
    await ctx.cleanup();
  }
});

test("marking after the recording ended still saves the record and says why no watermark was written", async () => {
  const ctx = await createService({ recording: null });
  try {
    const result = await ctx.service.mark({ trackingNumber: "SF987654321", reason: "包装破损" });
    assert.equal(result.watermark.written, false);
    assert.match(result.watermark.message, /录像已结束/);
    assert.equal(ctx.writes.length, 0);
    assert.equal(ctx.store.all().length, 1);
  } finally {
    await ctx.cleanup();
  }
});

test("watermark failures never lose the exception record", async () => {
  const ctx = await createService({ recording: ACTIVE });
  try {
    ctx.client.writeRecordingFields = async () => {
      const error = new Error("录像会话不存在或已结束");
      error.code = "recording_not_active";
      throw error;
    };
    const result = await ctx.service.mark({ trackingNumber: ACTIVE.trackingNumber, reason: "商品破损" });
    assert.equal(result.watermark.written, false);
    assert.equal(result.record.watermark, false);
    assert.equal(ctx.store.all().length, 1);
  } finally {
    await ctx.cleanup();
  }
});

test("invalid input is rejected with a user-facing message", async () => {
  const ctx = await createService({ recording: ACTIVE });
  try {
    await assert.rejects(() => ctx.service.mark({ trackingNumber: "AB", reason: "少件" }), UserError);
    await assert.rejects(() => ctx.service.mark({ trackingNumber: "YT1234567890", reason: "" }), UserError);
    await assert.rejects(() => ctx.service.mark({ trackingNumber: "YT1234567890", reason: "不存在的理由" }), UserError);
    assert.deepEqual(normalizeTrackingNumber("  yt-123_456  "), "yt-123_456");
  } finally {
    await ctx.cleanup();
  }
});

test("revoking keeps the record for audit and rewrites the watermark", async () => {
  const ctx = await createService({ recording: ACTIVE });
  try {
    const created = await ctx.service.mark({ trackingNumber: ACTIVE.trackingNumber, reason: "少件" });
    ctx.writes.length = 0;
    const revoked = await ctx.service.revoke(created.record.id, "王五");
    assert.equal(revoked.record.voided, true);
    assert.equal(revoked.record.status, "ignored");
    assert.equal(ctx.writes.length, 1);
    assert.match(ctx.writes[0].payload.value, /^已撤销：少件/);
    assert.equal(ctx.store.all().length, 1);
    assert.equal(ctx.service.list({}).length, 0, "revoked records are hidden from the default list");
    assert.equal(ctx.service.list({ includeVoided: true }).length, 1);
  } finally {
    await ctx.cleanup();
  }
});

test("status workflow and handling notes are recorded on the timeline", async () => {
  const ctx = await createService({ recording: ACTIVE });
  try {
    const created = await ctx.service.mark({ trackingNumber: ACTIVE.trackingNumber, reason: "多发" });
    const processing = await ctx.service.setStatus(created.record.id, "processing", { operator: "客服A", handlingNote: "已联系买家" });
    assert.equal(processing.status, "processing");
    assert.equal(processing.handler, "客服A");
    assert.equal(processing.resolvedAt, null);

    const resolved = await ctx.service.setStatus(created.record.id, "resolved", { handlingNote: "已补发" });
    assert.equal(resolved.status, "resolved");
    assert.ok(resolved.resolvedAt);
    assert.equal(resolved.handlingNote, "已补发");

    const noted = await ctx.service.addHandlingNote(created.record.id, { note: "补发单号 SF123" });
    assert.equal(noted.handlingNote, "补发单号 SF123");
    assert.deepEqual(
      noted.history.map((item) => item.action),
      ["marked", "status", "status", "note"]
    );
    await assert.rejects(() => ctx.service.setStatus(created.record.id, "bogus"), UserError);
  } finally {
    await ctx.cleanup();
  }
});

test("filters, stats and CSV export behave like the panel expects", async () => {
  const ctx = await createService({ recording: ACTIVE });
  try {
    const first = await ctx.service.mark({ trackingNumber: "YT0001", reason: "少件", note: "备注,带逗号" });
    await ctx.service.mark({ trackingNumber: "SF0002", reason: "错件" });
    await ctx.service.setStatus(first.record.id, "resolved", { handlingNote: '含"引号"的说明' });

    assert.equal(ctx.service.list({ status: "resolved" }).length, 1);
    assert.equal(ctx.service.list({ q: "SF0002" }).length, 1);
    assert.equal(ctx.service.list({ from: "2999-01-01" }).length, 0);
    assert.equal(ctx.service.list({ to: "2000-01-01" }).length, 0);

    const stats = ctx.service.stats();
    assert.equal(stats.total, 2);
    assert.equal(stats.pending, 1);
    assert.equal(stats.resolved, 1);
    assert.equal(stats.today, 2);

    const csv = ctx.service.csv(ctx.service.list({ includeVoided: true }));
    const lines = csv.split("\r\n");
    assert.equal(lines[0].split(",")[0], "单号");
    assert.ok(csv.includes('"备注,带逗号"'), "comma cells are quoted");
    assert.ok(csv.includes('"含""引号""的说明"'), "quotes are doubled");
  } finally {
    await ctx.cleanup();
  }
});

test("watermark text stays within one readable line", () => {
  const value = buildWatermarkValue({ reason: "少件", note: "", operator: "", at: new Date("2026-10-19T14:32:00") });
  assert.match(value, /^少件 · 未署名 · \d{2}:\d{2}$/);
  assert.ok(buildWatermarkValue({ reason: "少件", note: "x".repeat(400), operator: "张三" }).length <= 200);
});

test("without an operator the workstation name is signed instead of 未署名", async () => {
  const ctx = await createService({ recording: ACTIVE, nodeName: "电脑1" });
  try {
    // Clear the configured default operator so the fallback chain reaches the workstation name.
    await ctx.settings.update({ operator: "" });
    const result = await ctx.service.mark({ trackingNumber: ACTIVE.trackingNumber, reason: "错件" });
    assert.equal(result.record.operator, "电脑1");
    assert.match(ctx.writes[0].payload.value, /错件 · 电脑1 · \d{2}:\d{2}/);

    const revoked = await ctx.service.revoke(result.record.id);
    assert.match(revoked.record.history.at(-1).operator, /电脑1/);
  } finally {
    await ctx.cleanup();
  }
});

test("an explicit operator still wins over the workstation name", async () => {
  const ctx = await createService({ recording: ACTIVE, nodeName: "电脑1" });
  try {
    const result = await ctx.service.mark({ trackingNumber: ACTIVE.trackingNumber, reason: "少件", operator: "李四" });
    assert.equal(result.record.operator, "李四");
    assert.match(ctx.writes[0].payload.value, /李四/);
  } finally {
    await ctx.cleanup();
  }
});
