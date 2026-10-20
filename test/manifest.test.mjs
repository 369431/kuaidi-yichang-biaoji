import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("manifest.json matches the extension identity and points at a real entry file", async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, "manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.type, "external-adapter");
  assert.match(manifest.id, /^369431\.[a-z0-9-]+$/);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.id.startsWith("369431."), "扩展 ID 必须使用 Publisher ID 前缀");
  assert.ok(manifest.payload.startsWith("payload/"));
  const entry = await stat(path.join(ROOT, manifest.payload));
  assert.ok(entry.isFile(), "载荷入口文件必须存在");
});

test("every Windows script in the payload stays ASCII-only so Windows never shows mojibake", async () => {
  const payloadDirectory = path.join(ROOT, "payload");
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (/\.(cmd|ps1|vbs)$/i.test(entry.name)) files.push(full);
    }
  }
  await walk(payloadDirectory);
  assert.ok(files.length >= 4, `应找到多个脚本，实际 ${files.length}`);
  for (const file of files) {
    const bytes = await readFile(file);
    assert.ok(bytes.every((value) => value < 128), `${path.relative(ROOT, file)} 只能包含 ASCII 字符`);
    assert.notEqual(bytes[0], 0xef, `${path.relative(ROOT, file)} 不应带 BOM`);
  }
  const start = await readFile(path.join(payloadDirectory, "start.cmd"), "latin1");
  assert.match(start, /node/i);
  assert.match(start, /cd \/d "%LOCALAPPDATA%"/i, "start.cmd 不能把包目录当作工作目录");
});

test("the packaged files never contain runtime secrets", async () => {
  const files = ["README.md", "payload/README.md", "payload/src/runtime.js", "payload/src/credential-store.js"];
  for (const file of files) {
    const text = await readFile(path.join(ROOT, file), "utf8");
    assert.ok(!/[0-9a-f]{64}/i.test(text), `${file} 里不应出现 64 位十六进制密钥`);
    assert.ok(!text.includes("credential\": \""), `${file} 里不应出现明文凭据`);
  }
});
