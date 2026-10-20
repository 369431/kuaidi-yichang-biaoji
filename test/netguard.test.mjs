import assert from "node:assert/strict";
import test from "node:test";
import { createHostGuard, createTokenGuard, hostnameOf, isPrivateAddress, panelUrls } from "../payload/src/netguard.js";

test("host header parsing handles ports and IPv6 literals", () => {
  assert.equal(hostnameOf("127.0.0.1:8792"), "127.0.0.1");
  assert.equal(hostnameOf("192.168.1.5:8792"), "192.168.1.5");
  assert.equal(hostnameOf("DESKTOP-1"), "desktop-1");
  assert.equal(hostnameOf("[::1]:8792"), "[::1]");
  assert.equal(hostnameOf(""), "");
});

test("private ranges are recognised", () => {
  for (const value of ["10.0.0.5", "192.168.31.7", "172.16.0.1", "172.31.255.254", "169.254.1.1", "127.0.0.1"]) {
    assert.equal(isPrivateAddress(value), true, value);
  }
  for (const value of ["8.8.8.8", "1.1.1.1", "evil.example", "172.32.0.1"]) {
    assert.equal(isPrivateAddress(value), false, value);
  }
});

test("the host guard blocks DNS-rebinding style requests", () => {
  const guard = createHostGuard();
  assert.equal(guard("127.0.0.1:8792"), true);
  assert.equal(guard("localhost:8792"), true);
  assert.equal(guard("192.168.1.20:8792"), true);
  assert.equal(guard("evil.example"), false, "回连到内网 IP 的外部域名必须被拒绝");
  assert.equal(guard(""), false);
});

test("the token guard accepts query, header and cookie, and remembers the cookie", () => {
  const guard = createTokenGuard("s3cret");
  assert.equal(guard.required, true);

  const byQuery = guard.check(new URL("http://127.0.0.1:8792/manage?token=s3cret"), {});
  assert.equal(byQuery.ok, true);
  assert.match(byQuery.setCookie, /pp_panel_token=s3cret/);

  assert.equal(guard.check(new URL("http://127.0.0.1:8792/manage"), { "x-panel-token": "s3cret" }).ok, true);
  assert.equal(guard.check(new URL("http://127.0.0.1:8792/manage"), { cookie: "pp_panel_token=s3cret" }).ok, true);
  assert.equal(guard.check(new URL("http://127.0.0.1:8792/manage"), { cookie: "pp_panel_token=wrong" }).ok, false);
  assert.equal(guard.check(new URL("http://127.0.0.1:8792/manage?token=wrong"), {}).ok, false);
});

test("without a configured token the guard stays out of the way", () => {
  const guard = createTokenGuard("");
  assert.equal(guard.required, false);
  assert.equal(guard.check(new URL("http://127.0.0.1:8792/"), {}).ok, true);
});

test("panel URLs always include loopback and omit LAN when bound to loopback", () => {
  assert.deepEqual(panelUrls(8792, "loopback"), ["http://127.0.0.1:8792/"]);
  const lan = panelUrls(8792, "lan");
  assert.equal(lan[0], "http://127.0.0.1:8792/");
  for (const url of lan.slice(1)) assert.match(url, /^http:\/\/(10|172|192|169)\./);
});
