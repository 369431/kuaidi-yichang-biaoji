/**
 * PPEXT packer for this extension.
 *
 * Why not `npm run ppext -- pack`: the market tool expands the author manifest into the package
 * manifest itself and the author-manifest Schema still rejects a `launcher` block, while
 * docs/PUBLISHING.md tells authors to add one. PackingProof Desktop 0.0.87 does implement
 * `launcher.path` (Core.dll exposes LauncherPath) and package-manifest.v1 allows it, so this script
 * generates the package manifest directly and adds the launcher entry.
 *
 * Output is byte-stable for the same input: fixed DOS timestamp, sorted entries, fixed compression.
 */
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_LAUNCHER = "payload/start.cmd";
const PACKAGE_FILES_AT_ROOT = ["README.md", "icon.png"];
const DOS_TIME = 0;
const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1;

/** Builds the PPEXT manifest.json (package-manifest.v1) from the author manifest. */
export function buildPackageManifest(authorManifest, { launcherPath = DEFAULT_LAUNCHER, access } = {}) {
  const isUserscript = authorManifest.type === "userscript";
  const manifest = {
    access: {
      packingProofCapabilities: access?.packingProofCapabilities ?? [],
      packingProofPermissions: access?.packingProofPermissions ?? [],
      systemAccess: access?.systemAccess ?? []
    },
    compatibility: {
      minPackingProofVersion: authorManifest.minPackingProofVersion,
      platforms: isUserscript ? { userscript: ["any"] } : { windows: ["any"] }
    },
    format: "packingproof-extension",
    id: authorManifest.id,
    installation: isUserscript
      ? { mode: "userscript-import", payloadPath: authorManifest.payload }
      : { mode: "manual-external", suggestedPath: authorManifest.payload },
    packageFormatVersion: 1,
    schemaVersion: 1,
    type: authorManifest.type,
    version: authorManifest.version
  };
  if (!isUserscript && launcherPath) {
    assertLauncherPath(launcherPath);
    manifest.launcher = { path: launcherPath };
  }
  return manifest;
}

function assertLauncherPath(value) {
  const segments = String(value || "").split("/");
  const hasUnsafeSegment = segments.some((segment) => segment === "" || segment === "." || segment === "..");
  if (hasUnsafeSegment || !/^payload\/[A-Za-z0-9_./ -]+\.(exe|cmd|bat)$/.test(value)) {
    throw new Error(`launcher.path 只能指向 payload/ 下的 .exe/.cmd/.bat：${value}`);
  }
}

function assertSafePath(value) {
  if (
    !value
    || value.startsWith("/")
    || /^[A-Za-z]:/.test(value)
    || value.includes("\\")
    || value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`不安全的包内路径：${value}`);
  }
}

async function collectFiles(projectRoot) {
  const files = [];
  async function walk(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      const info = await stat(full);
      if (info.isDirectory()) {
        await walk(full, relative);
        continue;
      }
      if (!info.isFile()) throw new Error(`包里不允许符号链接或特殊文件：${relative}`);
      files.push({ relative, full, bytes: await readFile(full) });
    }
  }
  await walk(path.join(projectRoot, "payload"), "payload");
  for (const name of PACKAGE_FILES_AT_ROOT) {
    const full = path.join(projectRoot, name);
    try {
      const info = await stat(full);
      if (info.isFile()) files.push({ relative: name, full, bytes: await readFile(full) });
    } catch {
      // Optional file.
    }
  }
  for (const file of files) assertSafePath(file.relative);
  files.sort((left, right) => left.relative.localeCompare(right.relative, "en"));
  const seen = new Set();
  for (const file of files) {
    const key = file.relative.toLowerCase();
    if (seen.has(key)) throw new Error(`包内大小写冲突：${file.relative}`);
    seen.add(key);
  }
  return files;
}

function zipEntry(name, data) {
  const nameBytes = Buffer.from(name, "utf8");
  const compressed = deflateRawSync(data, { level: 9 });
  // The market rejects compression ratios above 200:1; tiny files fall back to "stored".
  const useDeflate = compressed.length * 200 >= data.length;
  const payload = useDeflate ? compressed : data;
  return { nameBytes, payload, method: useDeflate ? 8 : 0, crc: crc32(data) >>> 0, size: data.length };
}

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 file names
    header.writeUInt16LE(entry.method, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(entry.payload.length, 18);
    header.writeUInt32LE(entry.size, 22);
    header.writeUInt16LE(entry.nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    localParts.push(header, entry.nameBytes, entry.payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made by: unix, version 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.payload.length, 20);
    central.writeUInt32LE(entry.size, 24);
    central.writeUInt16LE(entry.nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, entry.nameBytes);

    offset += header.length + entry.nameBytes.length + entry.payload.length;
  }
  const centralBuffer = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralBuffer, end]);
}

/** Minimal reader used to verify the artifact we just wrote (and by the tests). */
export function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("不是有效的 ZIP：找不到目录结尾");
  const count = buffer.readUInt16LE(end + 10);
  const centralOffset = buffer.readUInt32LE(end + 16);
  const files = new Map();
  let position = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(position) !== 0x02014b50) throw new Error("中央目录损坏");
    const method = buffer.readUInt16LE(position + 10);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const localOffset = buffer.readUInt32LE(position + 42);
    const name = buffer.subarray(position + 46, position + 46 + nameLength).toString("utf8");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    files.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    position += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

export async function packProject(projectRoot, outputPath, { launcherPath = DEFAULT_LAUNCHER } = {}) {
  const authorManifest = JSON.parse(await readFile(path.join(projectRoot, "manifest.json"), "utf8"));
  if (!/^[a-z0-9][a-z0-9._-]*\.[a-z0-9][a-z0-9-]*$/.test(authorManifest.id)) {
    throw new Error(`扩展 ID 格式无效：${authorManifest.id}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(authorManifest.version)) {
    throw new Error(`external-adapter 版本必须是 X.Y.Z：${authorManifest.version}`);
  }

  const files = await collectFiles(projectRoot);
  // The permissions/system access declared in package.json end up in the package manifest so the
  // market can show what the extension really uses.
  let buildAccess;
  try {
    buildAccess = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")).packingproofAccess;
  } catch {
    buildAccess = undefined;
  }
  const manifest = buildPackageManifest(authorManifest, { launcherPath, access: buildAccess });
  const entryPath = manifest.installation.suggestedPath ?? manifest.installation.payloadPath;
  if (!files.some((file) => file.relative === entryPath)) {
    throw new Error(`安装入口不存在：${entryPath}`);
  }
  if (manifest.launcher && !files.some((file) => file.relative === manifest.launcher.path)) {
    throw new Error(`launcher.path 不存在：${manifest.launcher.path}`);
  }

  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (manifestBytes.length > 64 * 1024) throw new Error("manifest.json 不能超过 64 KB");

  const entries = [
    zipEntry("manifest.json", manifestBytes),
    ...files.map((file) => zipEntry(file.relative, file.bytes))
  ];
  const buffer = buildZip(entries);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, buffer);

  // Verify the artifact we just produced before telling the caller it worked.
  const verified = readZip(buffer);
  const roundTrip = JSON.parse(verified.get("manifest.json").toString("utf8"));
  if (roundTrip.launcher?.path !== manifest.launcher?.path) throw new Error("打包校验失败：launcher 未写入");
  if (verified.size !== entries.length) throw new Error("打包校验失败：条目数量不一致");
  for (const file of files) {
    if (!verified.has(file.relative)) throw new Error(`打包校验失败：缺少 ${file.relative}`);
  }
  return { outputPath, manifest, entries: entries.length, bytes: buffer.length };
}

async function main() {
  const argumentsList = process.argv.slice(2);
  const outputIndex = argumentsList.indexOf("--out");
  const launcherIndex = argumentsList.indexOf("--launcher");
  const authorManifest = JSON.parse(await readFile(path.join(PROJECT_ROOT, "manifest.json"), "utf8"));
  const outputPath = path.resolve(
    outputIndex > 0 ? argumentsList[outputIndex + 1] : path.join(PROJECT_ROOT, "dist", `${authorManifest.id}-${authorManifest.version}.ppext`)
  );
  const launcherPath = launcherIndex > 0 ? argumentsList[launcherIndex + 1] : DEFAULT_LAUNCHER;

  const result = await packProject(PROJECT_ROOT, outputPath, { launcherPath });
  console.log(`PPEXT 已生成：${result.outputPath}`);
  console.log(`  条目 ${result.entries} 个 · ${(result.bytes / 1024).toFixed(1)} KB · launcher=${result.manifest.launcher?.path}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`打包失败：${error.message}`);
    process.exitCode = 1;
  });
}
