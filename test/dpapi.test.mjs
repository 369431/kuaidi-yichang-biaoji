import assert from "node:assert/strict";
import test from "node:test";
import { protectString, unprotectString } from "../payload/src/dpapi.js";

// DPAPI only exists on Windows; the adapter itself is Windows-only as well.
const windowsOnly = process.platform === "win32" ? test : test.skip;

windowsOnly("credential material round-trips through DPAPI", async () => {
  const secret = JSON.stringify({ credential: "ab".repeat(32), note: "中文也要能加密" });
  const cipher = await protectString(secret);
  assert.match(cipher, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.notEqual(cipher, secret, "the stored value must not be the plaintext");
  assert.equal(await unprotectString(cipher), secret);
});

windowsOnly("a damaged credential file is rejected instead of decrypted", async () => {
  await assert.rejects(() => unprotectString("not-base64"), /不是有效的 DPAPI 密文/);
  await assert.rejects(() => unprotectString("AAAA"), /DPAPI unprotect 失败/);
});
