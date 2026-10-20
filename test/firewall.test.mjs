import assert from "node:assert/strict";
import test from "node:test";
import { FirewallManager, RULE_NAME } from "../payload/src/firewall.js";
import { createHostGuard } from "../payload/src/netguard.js";
import { normalizeHostList, normalizeSettings } from "../payload/src/config.js";

const silentLogger = { info() {}, warn() {}, error() {} };
const windowsOnly = process.platform === "win32" ? test : test.skip;

function fakeRunner(responses) {
  const calls = [];
  return {
    calls,
    run: async (command, args) => {
      calls.push({ command, args });
      const next = responses.shift();
      if (!next) return { code: 1, stdout: "", stderr: "no more responses" };
      return next;
    }
  };
}

windowsOnly("an existing rule is detected without asking for elevation", async () => {
  const fake = fakeRunner([{ code: 0, stdout: `${RULE_NAME}\r\n----------------------------------------------------------------------`, stderr: "" }]);
  const manager = new FirewallManager({ logger: silentLogger, port: 8792, runner: fake.run });
  const status = await manager.ensure();
  assert.equal(status.state, "ready");
  assert.equal(fake.calls.length, 1, "不应触发 UAC");
  assert.equal(fake.calls[0].command, "netsh.exe");
});

windowsOnly("a missing rule triggers exactly one elevated attempt, then reports ready", async () => {
  const fake = fakeRunner([
    { code: 1, stdout: "No rules match the specified criteria.", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: RULE_NAME, stderr: "" }
  ]);
  const manager = new FirewallManager({ logger: silentLogger, port: 8792, runner: fake.run });
  const status = await manager.ensure();
  assert.equal(status.state, "ready");
  assert.equal(fake.calls.length, 3);
  assert.match(fake.calls[1].command, /powershell\.exe/);
  assert.match(fake.calls[1].args.join(" "), /-Verb RunAs/);
  assert.match(fake.calls[1].args.join(" "), /-Port.*8792/);
});

windowsOnly("declining the UAC prompt is reported, not retried in a loop", async () => {
  const fake = fakeRunner([
    { code: 1, stdout: "", stderr: "" },
    { code: 1, stdout: "", stderr: "操作已被用户取消" },
    { code: 1, stdout: "", stderr: "" }
  ]);
  const manager = new FirewallManager({ logger: silentLogger, port: 8792, runner: fake.run });
  const status = await manager.ensure();
  assert.ok(["denied", "failed"].includes(status.state));
  assert.match(status.message, /取消|失败/);
  assert.equal(fake.calls.length, 3, "只尝试一次，不循环弹 UAC");
});

test("the host guard accepts LAN names and explicit domains but not random public domains", () => {
  const guard = createHostGuard({ extraHostnames: ["pack.example.com"] });
  assert.equal(guard("127.0.0.1:8792"), true);
  assert.equal(guard("192.168.1.9:8792"), true);
  assert.equal(guard("packing-pc:8792"), true, "单段计算机名可用");
  assert.equal(guard("packing-pc.local:8792"), true, "mDNS 名字可用");
  assert.equal(guard("pack.example.com:8792"), true, "白名单域名可用");
  assert.equal(guard("evil.example.com:8792"), false, "未登记的公网域名仍然拒绝");
  assert.equal(guard("evil.example:8792"), false);
});

test("panelAllowedHosts is parsed from strings or arrays", () => {
  assert.deepEqual(normalizeHostList("pack.example.com, http://other.lan:8792/x"), ["pack.example.com", "other.lan"]);
  assert.deepEqual(normalizeHostList(["a.example", "a.example", "bad host"]), ["a.example"]);
  assert.deepEqual(normalizeHostList(""), []);
});

test("new network settings have safe defaults and can be turned off", () => {
  const defaults = normalizeSettings({});
  assert.equal(defaults.panelBind, "lan");
  assert.equal(defaults.firewallAutoAllow, true);
  assert.equal(defaults.autoStart, true);
  assert.deepEqual(defaults.panelAllowedHosts, []);

  const off = normalizeSettings({ firewallAutoAllow: false, autoStart: false });
  assert.equal(off.firewallAutoAllow, false);
  assert.equal(off.autoStart, false);
});
