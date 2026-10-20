import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { UserError } from "../payload/src/exceptions.js";
import { createPanelServer, listenPanel } from "../payload/src/server.js";

function createStubRuntime() {
  const records = [
    {
      id: "ex-1",
      trackingNumber: "YT1",
      reason: "少件",
      note: "",
      status: "pending",
      statusLabel: "待处理",
      createdAt: "2026-10-19T06:00:00.000Z",
      history: []
    }
  ];
  return {
    state: () => ({
      ok: true,
      host: "http://127.0.0.1:5280",
      node: { id: "n1", name: "电脑1" },
      auth: { status: "authorized", message: "", permissions: [] },
      settings: { operator: "张三", reasons: ["少件", "错件"], watermarkNamespace: "异常", watermarkField: "内物不符", panelPort: 8792 },
      watcher: { status: "waiting", current: null, lastScan: null, lastStop: null },
      stats: { total: 1, pending: 1 },
      recent: records,
      overlay: { enabled: true, running: false },
      dataDirectory: "C:\\tmp\\data"
    }),
    updateSettings: async (patch) => ({ operator: patch.operator || "", reasons: ["少件"] }),
    reauthorize: async () => ({ status: "authorized", message: "", permissions: [] }),
    startOverlay: () => ({ ok: true, message: "已启动" }),
    stopOverlay: () => ({ ok: true, message: "已关闭" }),
    mark: async (payload) => {
      if (payload.reason === "boom") throw new UserError("不支持的异常原因");
      return {
        record: { id: "ex-2", trackingNumber: payload.trackingNumber, reason: payload.reason, status: "pending" },
        watermark: { written: true, message: "已写入录像水印" }
      };
    },
    exceptions: {
      revoke: async () => ({ record: { id: "ex-1", voided: true }, watermark: { written: false, message: "" } }),
      setStatus: async (id, status) => ({ id, status }),
      addHandlingNote: async (id) => ({ id }),
      list: () => records,
      stats: () => ({ total: 1, pending: 1 }),
      csv: () => "单号,异常原因\r\nYT1,少件"
    },
    evidence: {
      start: async () => ({ queryId: "q1", status: "queued" }),
      poll: async () => ({ queryId: "q1", status: "ready", recordings: [] }),
      stream: async () => {
        throw new UserError("录像不可用", 404);
      }
    }
  };
}

async function withServer(run, access = {}) {
  const server = createPanelServer({ runtime: createStubRuntime(), logger: { info() {}, warn() {}, error() {} }, access });
  const port = await listenPanel(server, 0, null);
  const base = `http://127.0.0.1:${port}`;
  try {
    await run(base, port);
  } finally {
    // fetch keeps connections alive; drop them so the next test does not inherit a dying socket.
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Raw request so the test can spoof the Host header (fetch refuses to). */
function rawGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path, method: "GET", headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") })
      );
    });
    request.on("error", reject);
    request.end();
  });
}

test("the packing panel page is served with the security headers", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const html = await response.text();
    assert.match(html, /内物不符异常标记/);
    assert.match(html, /assets\/app\.js/);
  });
});

test("state and record endpoints return JSON", async () => {
  await withServer(async (base) => {
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.ok, true);
    assert.equal(state.settings.reasons.length, 2);
    assert.equal(state.watcher.status, "waiting");

    const records = await (await fetch(`${base}/api/records?status=pending`)).json();
    assert.equal(records.total, 1);
    assert.equal(records.records[0].trackingNumber, "YT1");
  });
});

test("marking returns the watermark outcome", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/mark`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackingNumber: "YT999", reason: "错件" })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.record.trackingNumber, "YT999");
    assert.equal(body.watermark.written, true);
  });
});

test("user errors become 400 responses instead of 500s", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/mark`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackingNumber: "YT999", reason: "boom" })
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /不支持的异常原因/);
  });
});

test("cross-site POSTs are refused", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/mark`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
      body: JSON.stringify({ trackingNumber: "YT999", reason: "少件" })
    });
    assert.equal(response.status, 403);
  });
});

test("CSV export has a UTF-8 BOM so Excel opens Chinese correctly", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/export.csv`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/csv/);
    assert.match(response.headers.get("content-disposition"), /attachment; filename="inner-mismatch-/);
    const buffer = Buffer.from(await response.arrayBuffer());
    assert.equal(buffer.subarray(0, 3).toString("hex"), "efbbbf");
    assert.match(buffer.toString("utf8"), /YT1/);
  });
});

test("unknown API paths return a JSON 404", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/does-not-exist`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.ok, false);
  });
});

test("a hostile Host header is refused even when the connection is local", async () => {
  await withServer(async (_base, port) => {
    const rebound = await rawGet(port, "/api/state", { Host: "evil.example" });
    assert.equal(rebound.status, 403, "DNS rebinding 请求必须被拒绝");

    const normal = await rawGet(port, "/api/state", { Host: `127.0.0.1:${port}` });
    assert.equal(normal.status, 200);
  });
});

test("a configured access token gates pages and APIs", async () => {
  await withServer(async (base, port) => {
    const denied = await fetch(`${base}/`);
    assert.equal(denied.status, 401);
    assert.match(await denied.text(), /访问令牌/);

    const allowed = await fetch(`${base}/?token=s3cret`);
    assert.equal(allowed.status, 200);
    assert.match(String(allowed.headers.get("set-cookie")), /pp_panel_token=s3cret/);

    const api = await fetch(`${base}/api/state?token=s3cret`);
    assert.equal(api.status, 200);

    const viaCookie = await rawGet(port, "/api/state", {
      Host: `127.0.0.1:${port}`,
      Cookie: "pp_panel_token=s3cret"
    });
    assert.equal(viaCookie.status, 200);
  }, { token: "s3cret" });
});

test("state reports how the panel can be reached", async () => {
  await withServer(async (base) => {
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.access.tokenRequired, false);
    assert.ok(Array.isArray(state.access.urls));
  }, { bind: "lan", urls: ["http://127.0.0.1:8792/", "http://192.168.1.5:8792/"] });
});

test("the overlay UI endpoint serves labels and reasons so the WPF file stays ASCII", async () => {
  await withServer(async (base) => {
    const data = await (await fetch(`${base}/api/overlay-ui`)).json();
    assert.equal(data.ok, true);
    assert.equal(typeof data.labels.title, "string");
    for (const key of ["waiting", "recording", "undo", "failed", "offline"]) {
      assert.equal(typeof data.labels[key], "string", key);
    }
    assert.deepEqual(data.reasons, ["少件", "错件"]);
  });
});

test("the overlay can be switched on and off from the panel", async () => {
  await withServer(async (base) => {
    const on = await (await fetch(`${base}/api/overlay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true })
    })).json();
    assert.equal(on.ok, true);

    const off = await (await fetch(`${base}/api/overlay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false })
    })).json();
    assert.equal(off.ok, true);
  });
});

test("health reports the running version so a newer build can take over", async () => {
  await withServer(async (base) => {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.app, "369431.inner-mismatch");
    assert.match(String(health.version), /^\d+\.\d+\.\d+$/);
    assert.ok(Number.isInteger(health.pid));
  });
});

test("a local request can ask the old instance to exit (upgrade takeover)", async () => {
  let stopped = 0;
  await withServer(
    async (base) => {
      const response = await fetch(`${base}/api/system/shutdown`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      assert.equal(response.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(stopped, 1, "新版本启动时应能关掉旧实例");
    },
    { onShutdown: () => { stopped += 1; } }
  );
});

test("the panel can restart itself in a hidden window", async () => {
  let restarted = 0;
  await withServer(
    async (base) => {
      const response = await fetch(`${base}/api/system/restart`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      assert.equal(response.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(restarted, 1);
    },
    { onRestart: () => { restarted += 1; } }
  );
});
