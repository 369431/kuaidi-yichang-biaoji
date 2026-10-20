import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { protectString, unprotectString } from "../payload/src/dpapi.js";
import { SettingsStore } from "../payload/src/config.js";
import { ExtensionRuntime } from "../payload/src/runtime.js";

const silentLogger = { info() {}, warn() {}, error() {} };
const windowsOnly = process.platform === "win32" ? test : test.skip;

function waitFor(predicate, timeoutMs = 15000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("等待超时"));
        return;
      }
      setTimeout(tick, 50);
    };
    void tick();
  });
}

/**
 * Fake PackingProof host: generation 1 credentials are revoked (that is what happens after a package
 * reinstall), generation 2 is accepted. It records every request so the test can prove the adapter
 * stops hammering a revoked credential and resumes after re-authorization.
 */
async function startFakeHost({ enrollStatus = 200 } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const generation = request.headers["x-packingproof-extension-credential-generation"] || "";
    requests.push({ path: url.pathname, generation });

    const json = (statusCode, payload) => {
      const body = Buffer.from(JSON.stringify(payload), "utf8");
      response.writeHead(statusCode, { "Content-Type": "application/json", "Content-Length": body.length });
      response.end(body);
    };

    if (url.pathname === "/api/extensions/v1/capabilities") {
      json(200, { apiVersion: "v1", extensionApiEnabled: true, product: "PackingProof", nodeId: "node-1", nodeName: "测试工位" });
      return;
    }
    if (url.pathname === "/api/extensions/v1/enroll") {
      if (enrollStatus !== 200) {
        json(enrollStatus, { errorCode: "extension_enrollment_approval_unavailable", error: "电脑端暂时无法显示扩展授权窗口" });
        return;
      }
      json(200, {
        apiVersion: "v1",
        extensionInstanceId: "mismatch-test",
        credential: "ab".repeat(32),
        credentialGeneration: 2,
        permissions: ["recordings.active.read", "recording-fields.write", "recordings.search", "recordings.download"],
        capabilities: [],
        routingScope: "all_local_recording_nodes",
        boundOriginNodeIds: []
      });
      return;
    }
    if (url.pathname === "/api/extensions/v1/recordings/active") {
      if (generation !== "2") {
        json(403, { errorCode: "extension_auth_revoked", error: "扩展授权不存在或已撤销" });
        return;
      }
      json(200, { apiVersion: "v1", recordings: [] });
      return;
    }
    if (url.pathname === "/api/extensions/v1/heartbeat") {
      json(200, { apiVersion: "v1", ok: true });
      return;
    }
    json(404, { errorCode: "not_found", error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, port, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function prepareRuntime(port, { credential } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "inm-runtime-"));
  const settings = new SettingsStore(directory);
  await settings.load();
  await settings.update({ host: `http://127.0.0.1:${port}`, hotkeysEnabled: false, openPanelOnStart: false });
  await settings.save();
  if (credential) {
    const cipher = await protectString(JSON.stringify(credential));
    await (await import("node:fs/promises")).writeFile(path.join(directory, "credential.bin"), cipher, "utf8");
  }
  const runtime = new ExtensionRuntime({ dataDirectory: directory, logger: silentLogger });
  return { runtime, directory };
}

windowsOnly("a revoked stored credential triggers a fresh authorization instead of failing forever", async () => {
  const host = await startFakeHost();
  const { runtime, directory } = await prepareRuntime(host.port, {
    credential: {
      extensionInstanceId: "mismatch-test",
      credential: "cd".repeat(32),
      credentialGeneration: 1,
      permissions: ["recordings.active.read"],
      capabilities: []
    }
  });
  try {
    await runtime.init();
    assert.equal(runtime.state().auth.status, "authorized");
    assert.equal(runtime.client.credentialGeneration, 2, "the new credential must replace the revoked one");

    const enrollments = host.requests.filter((request) => request.path === "/api/extensions/v1/enroll");
    assert.equal(enrollments.length, 1, "a revoked credential must lead to exactly one fresh enrollment");

    await waitFor(() => host.requests.some((request) => request.path === "/api/extensions/v1/recordings/active" && request.generation === "2"));
    const stale = host.requests.filter((request) => request.path === "/api/extensions/v1/recordings/active" && request.generation === "1");
    assert.ok(stale.length <= 1, `不应反复用旧凭据轮询（实际 ${stale.length} 次）`);

    const cipher = await readFile(path.join(directory, "credential.bin"), "utf8");
    const stored = JSON.parse(await unprotectString(cipher));
    assert.equal(stored.credentialGeneration, 2, "重新授权后应把新凭据加密保存");
  } finally {
    await runtime.shutdown();
    await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});

windowsOnly("when the authorization window cannot be shown, the adapter stops polling and reports it", async () => {
  const host = await startFakeHost({ enrollStatus: 503 });
  const { runtime, directory } = await prepareRuntime(host.port, {
    credential: {
      extensionInstanceId: "mismatch-test",
      credential: "cd".repeat(32),
      credentialGeneration: 1,
      permissions: ["recordings.active.read"],
      capabilities: []
    }
  });
  try {
    await runtime.init();
    assert.notEqual(runtime.state().auth.status, "authorized");
    assert.match(runtime.state().auth.message, /无法显示扩展授权窗口|授权/);

    await new Promise((resolve) => setTimeout(resolve, 1200));
    const polls = host.requests.filter((request) => request.path === "/api/extensions/v1/recordings/active");
    assert.ok(polls.length <= 2, `未授权时不应持续轮询（实际 ${polls.length} 次）`);
    assert.equal(runtime.state().watcher.lastPolledAt, null);
  } finally {
    await runtime.shutdown();
    await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});
