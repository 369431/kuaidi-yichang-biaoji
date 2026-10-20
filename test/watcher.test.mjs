import assert from "node:assert/strict";
import test from "node:test";
import { RecordingWatcher } from "../payload/src/watcher.js";

const silentLogger = { info() {}, warn() {}, error() {} };

function createWatcher(responses) {
  const queue = [...responses];
  const scans = [];
  const stops = [];
  const client = {
    activeRecordings: async () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next ?? [];
    }
  };
  const watcher = new RecordingWatcher({
    client,
    logger: silentLogger,
    onScan: (scan) => scans.push(scan),
    onStop: (scan) => stops.push(scan)
  });
  return { watcher, scans, stops };
}

const SESSION_A = {
  sessionId: "session-a",
  recordingId: 11,
  trackingNumber: "YT111",
  orderId: "",
  mode: "发货",
  startTime: "2026-10-19T06:00:00Z"
};

test("a new active recording is reported once as a scan", async () => {
  const { watcher, scans } = createWatcher([[SESSION_A], [SESSION_A], [{ ...SESSION_A, trackingNumber: "YT111" }]]);
  await watcher.poll();
  await watcher.poll();
  await watcher.poll();
  assert.equal(scans.length, 1);
  assert.equal(scans[0].trackingNumber, "YT111");
  assert.equal(watcher.state.status, "recording");
  assert.equal(watcher.activeSessionId, "session-a");
});

test("the recording is only treated as stopped after consecutive empty polls", async () => {
  const { watcher, stops } = createWatcher([[SESSION_A], [], [SESSION_A], [], []]);
  await watcher.poll();
  await watcher.poll();
  assert.equal(watcher.isRecording, true, "one empty poll can be a transient glitch");
  await watcher.poll();
  await watcher.poll();
  await watcher.poll();
  assert.equal(watcher.isRecording, false);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].trackingNumber, "YT111");
  assert.equal(watcher.state.lastScan.trackingNumber, "YT111", "the last scan stays available for late marking");
});

test("the newest session wins when several workstations record at the same time", async () => {
  const { watcher, scans } = createWatcher([
    [
      { ...SESSION_A, sessionId: "old", trackingNumber: "OLD1", startTime: "2026-10-19T05:00:00Z" },
      { ...SESSION_A, sessionId: "new", trackingNumber: "NEW1", startTime: "2026-10-19T07:00:00Z" }
    ]
  ]);
  await watcher.poll();
  assert.equal(scans.at(-1).sessionId, "new");
  assert.equal(watcher.state.current.trackingNumber, "NEW1");
});

test("poll failures surface as an error state without dropping the current parcel", async () => {
  const { watcher } = createWatcher([[SESSION_A], new Error("connect ECONNREFUSED")]);
  await watcher.poll();
  await watcher.poll();
  assert.equal(watcher.state.status, "error");
  assert.match(watcher.state.lastError, /ECONNREFUSED/);
  assert.equal(watcher.state.current.trackingNumber, "YT111");
});
