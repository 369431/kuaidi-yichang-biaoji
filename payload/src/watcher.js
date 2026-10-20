import { describeError } from "./logger.js";

const STOPPED_POLLS_BEFORE_IDLE = 2;

/**
 * Turns PackingProof's active-recording list into scan events.
 *
 * The extension API has no "scan happened" push channel for third-party programs, but every scan
 * starts a recording session that /api/extensions/v1/recordings/active reports. Polling that list is
 * the supported way to know which parcel is being recorded right now.
 */
export class RecordingWatcher {
  #client;
  #logger;
  #intervalMs;
  #timer = null;
  #polling = false;
  #stopped = false;
  #emptyPolls = 0;
  #onScan;
  #onStop;

  constructor({ client, logger, intervalMs = 800, onScan, onStop } = {}) {
    this.#client = client;
    this.#logger = logger;
    this.#intervalMs = intervalMs;
    this.#onScan = onScan;
    this.#onStop = onStop;
    this.state = {
      status: "starting",
      current: null,
      lastScan: null,
      lastStop: null,
      lastError: "",
      lastPolledAt: null
    };
  }

  start() {
    if (this.#timer) return;
    this.#stopped = false;
    this.#timer = setInterval(() => {
      void this.poll();
    }, this.#intervalMs);
    this.#timer.unref?.();
    void this.poll();
  }

  stop() {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  setIntervalMs(value) {
    const interval = Math.min(5000, Math.max(400, Number(value) || 800));
    if (interval === this.#intervalMs) return;
    this.#intervalMs = interval;
    if (this.#timer) {
      this.stop();
      this.start();
    }
  }

  /** One poll cycle, also callable directly from tests. */
  async poll() {
    if (this.#polling || this.#stopped) return;
    this.#polling = true;
    try {
      const recordings = await this.#client.activeRecordings();
      this.state.lastPolledAt = new Date().toISOString();
      this.state.lastError = "";
      this.#applyRecordings(recordings);
    } catch (error) {
      this.state.status = "error";
      this.state.lastError = describeError(error);
    } finally {
      this.#polling = false;
    }
  }

  #applyRecordings(recordings) {
    if (!Array.isArray(recordings) || recordings.length === 0) {
      this.#emptyPolls += 1;
      if (this.state.current && this.#emptyPolls >= STOPPED_POLLS_BEFORE_IDLE) {
        const previous = this.state.current;
        this.state.current = null;
        this.state.lastStop = { ...previous, stoppedAt: new Date().toISOString() };
        this.state.status = "waiting";
        this.#onStop?.(previous);
      } else if (!this.state.current) {
        this.state.status = "waiting";
      }
      return;
    }

    this.#emptyPolls = 0;
    const current = this.state.current;
    let picked = current ? recordings.find((record) => record.sessionId === current.sessionId) : null;
    if (!picked) {
      // Several workstations can record at once; prefer the newest session on this node.
      picked = [...recordings].sort((left, right) => String(left.startTime).localeCompare(String(right.startTime))).at(-1);
    }
    if (!picked) return;

    if (current && picked.sessionId === current.sessionId) {
      current.trackingNumber = picked.trackingNumber || current.trackingNumber;
      current.orderId = picked.orderId || current.orderId;
      current.recordingId = picked.recordingId || current.recordingId;
      this.state.status = "recording";
      return;
    }

    const scan = {
      sessionId: picked.sessionId,
      recordingId: picked.recordingId,
      trackingNumber: picked.trackingNumber,
      orderId: picked.orderId,
      mode: picked.mode,
      startTime: picked.startTime,
      detectedAt: new Date().toISOString()
    };
    this.state.current = scan;
    this.state.status = "recording";
    if (scan.trackingNumber) {
      this.state.lastScan = scan;
      this.#logger?.info("Watcher", `检测到扫码 ${scan.trackingNumber}（会话 ${scan.sessionId}）`);
      this.#onScan?.(scan);
    }
  }

  get activeSessionId() {
    return this.state.current?.sessionId || "";
  }

  get isRecording() {
    return Boolean(this.state.current);
  }

  snapshot() {
    return {
      status: this.state.status,
      current: this.state.current ? { ...this.state.current } : null,
      lastScan: this.state.lastScan ? { ...this.state.lastScan } : null,
      lastStop: this.state.lastStop ? { ...this.state.lastStop } : null,
      lastError: this.state.lastError,
      lastPolledAt: this.state.lastPolledAt
    };
  }
}
