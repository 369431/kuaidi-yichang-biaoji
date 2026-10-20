import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildPackageManifest, packProject, readZip } from "../scripts/pack.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const AUTHOR_MANIFEST = JSON.parse(await readFile(path.join(PROJECT_ROOT, "manifest.json"), "utf8"));

test("the package manifest carries a launcher that the panel's 启动 button can use", () => {
  const manifest = buildPackageManifest(AUTHOR_MANIFEST);
  assert.equal(manifest.format, "packingproof-extension");
  assert.equal(manifest.installation.mode, "manual-external");
  assert.equal(manifest.installation.suggestedPath, "payload/start.cmd");
  assert.deepEqual(manifest.launcher, { path: "payload/start.cmd" });
  assert.deepEqual(manifest.compatibility.platforms, { windows: ["any"] });
});

test("a launcher outside payload/ or with the wrong extension is refused", () => {
  assert.throws(() => buildPackageManifest(AUTHOR_MANIFEST, { launcherPath: "start.cmd" }), /launcher\.path/);
  assert.throws(() => buildPackageManifest(AUTHOR_MANIFEST, { launcherPath: "payload/start.ps1" }), /launcher\.path/);
  assert.throws(() => buildPackageManifest(AUTHOR_MANIFEST, { launcherPath: "payload/../start.cmd" }), /launcher\.path/);
});

test("marking the launcher as null is how you build a package without the button", () => {
  const manifest = buildPackageManifest(AUTHOR_MANIFEST, { launcherPath: null });
  assert.equal(manifest.launcher, undefined);
});

test("userscripts never get an external launcher", () => {
  const manifest = buildPackageManifest({ ...AUTHOR_MANIFEST, type: "userscript", version: "1.0", payload: "payload/main.user.js" });
  assert.equal(manifest.installation.mode, "userscript-import");
  assert.equal(manifest.launcher, undefined);
  assert.deepEqual(manifest.compatibility.platforms, { userscript: ["any"] });
});

test("the packed artifact is a valid zip with the launcher and no runtime secrets", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "inm-pack-"));
  try {
    const output = path.join(directory, "artifact.ppext");
    const result = await packProject(PROJECT_ROOT, output);
    assert.equal(result.manifest.launcher.path, "payload/start.cmd");

    const entries = readZip(await readFile(output));
    const manifest = JSON.parse(entries.get("manifest.json").toString("utf8"));
    assert.deepEqual(manifest.launcher, { path: "payload/start.cmd" });
    assert.ok(entries.has("payload/start.cmd"));
    assert.ok(entries.has("payload/src/index.js"));
    assert.ok(entries.has("payload/src/public/index.html"));
    assert.ok(entries.has("README.md"));
    assert.ok(entries.has("icon.png"));
    for (const name of entries.keys()) {
      assert.ok(
        name === "manifest.json" || name === "README.md" || name === "icon.png" || name.startsWith("payload/"),
        `包里出现了不该有的条目：${name}`
      );
    }
    assert.ok(![...entries.keys()].some((name) => /(^|\/)(credential\.bin|settings\.json|exceptions\.json|logs\/)/.test(name)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("packing the same project twice produces identical bytes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "inm-pack-stable-"));
  try {
    const first = path.join(directory, "a.ppext");
    const second = path.join(directory, "b.ppext");
    await packProject(PROJECT_ROOT, first);
    await packProject(PROJECT_ROOT, second);
    assert.deepEqual(await readFile(first), await readFile(second));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
