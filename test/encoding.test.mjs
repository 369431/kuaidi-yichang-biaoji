import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".json", ".html", ".css", ".md"]);
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".git"]);

async function collect(directory, result = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      await collect(path.join(directory, entry.name), result);
      continue;
    }
    if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) result.push(path.join(directory, entry.name));
  }
  return result;
}

test("every source file is valid UTF-8 without a BOM or mojibake", async () => {
  const files = await collect(ROOT);
  assert.ok(files.length > 10, "expected the project sources to be discovered");
  for (const file of files) {
    const bytes = await readFile(file);
    const text = bytes.toString("utf8");
    const relative = path.relative(ROOT, file);
    assert.ok(!text.includes("\uFFFD"), `${relative} 含有无法解码的字符`);
    // This file carries the mojibake patterns as literals, so it must not scan itself.
    if (!file.endsWith("encoding.test.mjs")) {
      assert.ok(!/锛|鑾峰|閿欒/.test(text), `${relative} 疑似被错误转码`);
    }
    if (file.endsWith(".js") || file.endsWith(".mjs")) {
      assert.notEqual(bytes[0], 0xef, `${relative} 不应带 UTF-8 BOM`);
    }
  }
});
