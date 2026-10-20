/**
 * Live smoke check against the local PackingProof host.
 *
 * Verifies, with the credential stored by the adapter:
 *   1. the host answers the capabilities endpoint
 *   2. a signed request is accepted (recordings/active)
 *   3. a signed write reaches the watermark endpoint (a fake session must be rejected with 409/404,
 *      which proves signing and permissions are fine without touching a real recording)
 *
 * Usage: node scripts/smoke.mjs [--host http://127.0.0.1:5280]
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { PackingProofClient } from "../payload/src/client.js";
import { CredentialStore } from "../payload/src/credential-store.js";
import { SettingsStore } from "../payload/src/config.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const dataDirectory =
  process.env.PACKINGPROOF_EXTENSION_DATA_DIR ||
  path.join(process.env.LOCALAPPDATA || process.env.HOME || ".", "ExpressPackingMonitoring", "extension-data", "369431.inner-mismatch");

const hostArgumentIndex = process.argv.indexOf("--host");
const hostOverride = hostArgumentIndex > 0 ? process.argv[hostArgumentIndex + 1] : "";

const logger = { info() {}, warn() {}, error() {} };
const settings = new SettingsStore(dataDirectory);
const loaded = await settings.load();
const host = hostOverride || loaded.host;

const client = new PackingProofClient({ baseUrl: host, logger });
const capabilities = await client.capabilities();
console.log(`1. 主机可用：${capabilities.product} ${capabilities.apiVersion}，工位 ${capabilities.nodeName || capabilities.nodeId}`);

const store = new CredentialStore(dataDirectory, logger);
const credential = await store.loadCredential();
if (!credential) {
  console.error("2. 未找到本地授权凭据：请先运行 payload/src/index.js 并在电脑端确认授权");
  process.exit(2);
}
client.setCredential(credential);
console.log(`2. 已载入凭据：权限 ${credential.permissions.join(", ")}`);

const recordings = await client.activeRecordings();
console.log(`3. 签名请求通过：当前活跃录像 ${recordings.length} 段${recordings[0] ? `（最新 ${recordings[0].trackingNumber}）` : ""}`);

try {
  await client.writeRecordingFields("smoke-test-session", {
    namespace: "异常",
    field: "内物不符",
    value: "smoke test"
  });
  console.warn("4. 意外成功：水印接口接受了不存在的会话，请检查 PackingProof 版本");
  process.exitCode = 1;
} catch (error) {
  if (["recording_not_active", "recording_session_invalid", "invalid_recording_session"].includes(error.code) || error.status === 409 || error.status === 404) {
    console.log(`4. 水印写入端点可用：不存在的会话被正确拒绝（${error.code || error.status}）`);
  } else {
    console.error(`4. 水印写入失败：${error.code || error.status} ${error.message}`);
    process.exitCode = 1;
  }
}
