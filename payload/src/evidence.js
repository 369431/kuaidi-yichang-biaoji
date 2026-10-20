/**
 * Turns a tracking number into playable evidence by asking PackingProof for a recording query and
 * streaming the prepared file back through this adapter (the browser never sees extension credentials).
 */
export class EvidenceService {
  #client;
  #logger;
  #cache = new Map();

  constructor({ client, logger }) {
    this.#client = client;
    this.#logger = logger;
  }

  async start(trackingNumber) {
    if (!this.#client.isEnrolled) {
      throw new Error("尚未获得授权，无法查询录像");
    }
    if (!this.#client.hasPermission("recordings.search")) {
      throw new Error("电脑端未批准录像查询权限（recordings.search）");
    }
    const snapshot = await this.#client.createRecordingQuery(trackingNumber);
    if (snapshot?.queryId) {
      this.#cache.set(snapshot.queryId, { trackingNumber, startedAt: Date.now(), snapshot });
      if (this.#cache.size > 50) {
        const oldest = [...this.#cache.entries()].sort((left, right) => left[1].startedAt - right[1].startedAt)[0];
        if (oldest) this.#cache.delete(oldest[0]);
      }
    }
    this.#logger?.info("Evidence", `发起录像查询 ${trackingNumber} → ${snapshot?.status || "unknown"}`);
    return snapshot;
  }

  async poll(queryId) {
    if (!this.#client.isEnrolled) {
      throw new Error("尚未获得授权，无法查询录像");
    }
    const snapshot = await this.#client.recordingQuery(queryId);
    const cached = this.#cache.get(queryId);
    if (cached) cached.snapshot = snapshot;
    return snapshot;
  }

  async stream(queryId, recordingId, range) {
    if (!this.#client.isEnrolled) {
      throw new Error("尚未获得授权，无法下载录像");
    }
    if (!this.#client.hasPermission("recordings.download")) {
      throw new Error("电脑端未批准录像下载权限（recordings.download）");
    }
    return this.#client.downloadRecording(queryId, Number(recordingId), { range });
  }
}
