import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { describeError } from "./logger.js";

/**
 * Durable store for exception records. One JSON document is small enough for a packing station and
 * keeps the adapter dependency-free; every write is atomic (temp file + rename).
 */
export class ExceptionStore {
  #filePath;
  #logger;
  #records = [];
  #saveChain = Promise.resolve();
  #dirty = false;

  constructor(dataDirectory, logger) {
    this.#filePath = path.join(dataDirectory, "exceptions.json");
    this.#logger = logger;
  }

  get filePath() {
    return this.#filePath;
  }

  async load() {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    try {
      const raw = await readFile(this.#filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.#records = Array.isArray(parsed?.records) ? parsed.records.filter(isUsableRecord) : [];
    } catch (error) {
      if (error.code === "ENOENT") {
        this.#records = [];
        return this.all();
      }
      this.#logger?.warn("Store", `exceptions.json 无法读取，已备份并重新开始：${describeError(error)}`);
      await rename(this.#filePath, `${this.#filePath}.broken-${Date.now()}`).catch(() => {});
      this.#records = [];
    }
    return this.all();
  }

  all() {
    return this.#records.map((record) => ({ ...record, history: [...(record.history || [])] }));
  }

  get(id) {
    return this.#records.find((record) => record.id === id) || null;
  }

  find(predicate) {
    return this.#records.find(predicate) || null;
  }

  upsert(record) {
    const index = this.#records.findIndex((item) => item.id === record.id);
    if (index >= 0) {
      this.#records[index] = record;
    } else {
      this.#records.push(record);
    }
    this.#dirty = true;
  }

  remove(id) {
    const before = this.#records.length;
    this.#records = this.#records.filter((record) => record.id !== id);
    if (this.#records.length !== before) this.#dirty = true;
  }

  /** Persists pending changes; callers can await the current save chain. */
  async flush() {
    if (this.#dirty) {
      this.#dirty = false;
      const payload = { schemaVersion: 1, updatedAt: new Date().toISOString(), records: this.#records };
      const temporary = `${this.#filePath}.tmp`;
      this.#saveChain = this.#saveChain
        .then(async () => {
          await mkdir(path.dirname(this.#filePath), { recursive: true });
          await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
          await rename(temporary, this.#filePath);
        })
        .catch((error) => {
          this.#dirty = true;
          this.#logger?.error("Store", "保存异常记录失败", error);
        });
    }
    await this.#saveChain;
  }

  /** Drops records older than the configured retention window (0 keeps everything). */
  prune(keepDays, now = Date.now()) {
    if (!(keepDays > 0)) return 0;
    const cutoff = now - keepDays * 24 * 60 * 60 * 1000;
    const before = this.#records.length;
    this.#records = this.#records.filter((record) => {
      const created = Date.parse(record.createdAt || "");
      return Number.isNaN(created) || created >= cutoff;
    });
    const removed = before - this.#records.length;
    if (removed > 0) this.#dirty = true;
    return removed;
  }
}

function isUsableRecord(value) {
  return Boolean(value) && typeof value.id === "string" && typeof value.trackingNumber === "string";
}
