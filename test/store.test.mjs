import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ExceptionStore } from "../payload/src/store.js";

async function withStore(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "inm-store-"));
  try {
    const store = new ExceptionStore(directory, { warn() {}, info() {}, error() {} });
    await store.load();
    await run(store, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("records persist atomically and survive a restart", async () => {
  await withStore(async (store, directory) => {
    store.upsert({ id: "ex-1", trackingNumber: "YT123456", createdAt: new Date().toISOString(), history: [] });
    await store.flush();
    const raw = JSON.parse(await readFile(path.join(directory, "exceptions.json"), "utf8"));
    assert.equal(raw.records.length, 1);

    const reopened = new ExceptionStore(directory, { warn() {} });
    await reopened.load();
    assert.equal(reopened.all().length, 1);
    assert.equal(reopened.get("ex-1").trackingNumber, "YT123456");
  });
});

test("a corrupted database is moved aside instead of taking the adapter down", async () => {
  await withStore(async (store, directory) => {
    await writeFile(path.join(directory, "exceptions.json"), "{ this is not json", "utf8");
    const broken = new ExceptionStore(directory, { warn() {} });
    const records = await broken.load();
    assert.deepEqual(records, []);
    broken.upsert({ id: "ex-2", trackingNumber: "SF123", createdAt: new Date().toISOString() });
    await broken.flush();
    assert.equal(JSON.parse(await readFile(path.join(directory, "exceptions.json"), "utf8")).records.length, 1);
  });
});

test("retention pruning removes only records older than the window", async () => {
  await withStore(async (store) => {
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
    const fresh = new Date().toISOString();
    store.upsert({ id: "old", trackingNumber: "A111", createdAt: old });
    store.upsert({ id: "new", trackingNumber: "B222", createdAt: fresh });
    assert.equal(store.prune(30), 1);
    assert.deepEqual(
      store.all().map((record) => record.id),
      ["new"]
    );
    assert.equal(store.prune(0), 0, "0 disables retention");
  });
});
