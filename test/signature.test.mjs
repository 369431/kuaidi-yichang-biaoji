import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import {
  EXTENSION_IDENTITY,
  buildSignaturePayload,
  hexToKey,
  signRequest,
  signatureHeaders
} from "../payload/src/client.js";

const CREDENTIAL = "8f".repeat(32);
const FIXED_NOW = 1_800_000_000_000; // 2027-01-15T08:00:00Z

test("canonical string matches the documented protocol layout", () => {
  const canonical = buildSignaturePayload({
    method: "post",
    target: "/api/extensions/v1/recordings/session-1/data",
    timestamp: 1800000000,
    nonce: "abcdef0123456789abcdef0123456789",
    contentHash: "00".repeat(32),
    generation: 3,
    extensionInstanceId: "mismatch-0123456789abcdef"
  });
  assert.equal(
    canonical,
    [
      "packingproof-extension-request-v1",
      "1",
      "3",
      "POST",
      "/api/extensions/v1/recordings/session-1/data",
      "1800000000",
      "abcdef0123456789abcdef0123456789",
      "00".repeat(32),
      "mismatch-0123456789abcdef"
    ].join("\n")
  );
});

test("signature is HMAC-SHA256 over the canonical string with the hex credential as key", () => {
  const body = Buffer.from(JSON.stringify({ hello: "世界" }), "utf8");
  const signed = signRequest({
    credential: CREDENTIAL,
    method: "POST",
    target: "/api/extensions/v1/heartbeat",
    body,
    generation: 1,
    extensionInstanceId: "mismatch-0123456789abcdef",
    now: FIXED_NOW
  });

  const expected = createHmac("sha256", Buffer.from(CREDENTIAL, "hex"))
    .update(
      buildSignaturePayload({
        method: "POST",
        target: "/api/extensions/v1/heartbeat",
        timestamp: Math.floor(FIXED_NOW / 1000),
        nonce: signed.nonce,
        contentHash: createHash("sha256").update(body).digest("hex"),
        generation: 1,
        extensionInstanceId: "mismatch-0123456789abcdef"
      }),
      "utf8"
    )
    .digest("hex");

  assert.equal(signed.signature, expected);
  assert.equal(signed.contentHash, createHash("sha256").update(body).digest("hex"));
  assert.match(signed.nonce, /^[0-9a-f]{32}$/);
});

test("GET requests sign the SHA-256 of an empty body, not of {}", () => {
  const headers = signatureHeaders({
    credential: CREDENTIAL,
    method: "GET",
    target: "/api/extensions/v1/recordings/active",
    body: Buffer.alloc(0),
    generation: 2,
    extensionInstanceId: "mismatch-0123456789abcdef",
    now: FIXED_NOW
  });
  assert.equal(headers["X-PackingProof-Extension-Content-SHA256"], createHash("sha256").update("").digest("hex"));
  assert.equal(headers["X-PackingProof-Extension-Version"], "1");
  assert.equal(headers["X-PackingProof-Extension-Id"], "mismatch-0123456789abcdef");
  assert.equal(headers["X-PackingProof-Extension-Credential-Generation"], "2");
  assert.match(headers["X-PackingProof-Extension-Signature"], /^[0-9a-f]{64}$/);
});

test("invalid credentials are rejected before any request is sent", () => {
  assert.throws(() => hexToKey("not-a-credential"), /凭据格式无效/);
  assert.throws(() => hexToKey("abcd"), /凭据格式无效/);
});

test("the requested permissions are the ones the feature actually needs", () => {
  assert.deepEqual(
    [...EXTENSION_IDENTITY.requestedPermissions].sort(),
    ["recording-fields.write", "recordings.active.read", "recordings.download", "recordings.search"].sort()
  );
  // No scan-task capability: the adapter reads active recordings instead of faking an ERP lookup.
  assert.equal(EXTENSION_IDENTITY.requestedCapabilities.length, 0);
});
