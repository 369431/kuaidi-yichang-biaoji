import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(new URL("./dpapi.ps1", import.meta.url));

let queue = Promise.resolve();

function runPowerShell(action, base64Input) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT_PATH, "-Action", action],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const text = Buffer.concat(stdout).toString("utf8").trim();
      if (code === 0 && text) {
        resolve(text);
        return;
      }
      const rawError = Buffer.concat(stderr);
      // Windows PowerShell writes stderr in the OEM code page; only keep it when it is plain ASCII.
      const asciiOnly = /^[\t\r\n\x20-\x7e]*$/.test(rawError.toString("latin1"));
      const detail = asciiOnly ? rawError.toString("utf8").trim() : "";
      reject(new Error(`DPAPI ${action} 失败（exit ${code}）${detail ? `：${detail}` : ""}`));
    });
    child.stdin.on("error", reject);
    child.stdin.end(base64Input);
  });
}

function enqueue(action, base64Input) {
  const task = queue.then(() => runPowerShell(action, base64Input));
  queue = task.then(
    () => undefined,
    () => undefined
  );
  return task;
}

/** Encrypts a UTF-8 string with Windows DPAPI (CurrentUser) and returns base64 ciphertext. */
export async function protectString(plainText) {
  if (process.platform !== "win32") {
    throw new Error("凭据加密依赖 Windows DPAPI，本扩展只在 Windows 电脑端运行");
  }
  return enqueue("protect", Buffer.from(plainText, "utf8").toString("base64"));
}

/** Decrypts base64 DPAPI ciphertext back to a UTF-8 string. */
export async function unprotectString(cipherBase64) {
  if (process.platform !== "win32") {
    throw new Error("凭据加密依赖 Windows DPAPI，本扩展只在 Windows 电脑端运行");
  }
  const cipher = String(cipherBase64 || "").trim();
  if (!cipher || !/^[A-Za-z0-9+/]+={0,2}$/.test(cipher)) {
    throw new Error("凭据文件不是有效的 DPAPI 密文");
  }
  // The helper expects base64 of the raw ciphertext, not base64 of the base64 text.
  const plainBase64 = await enqueue("unprotect", cipher);
  return Buffer.from(plainBase64, "base64").toString("utf8");
}
