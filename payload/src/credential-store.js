import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { protectString, unprotectString } from "./dpapi.js";
import { describeError } from "./logger.js";

export const CREDENTIAL_ENV = "PACKINGPROOF_EXTENSION_CREDENTIAL";

/**
 * Persists the extension identity and the approved credential.
 *
 * The credential is a bearer secret: it is encrypted with Windows DPAPI (CurrentUser) and stored at
 * <dataDir>/credential.bin. It is never written to settings.json, logs or the console.
 */
export class CredentialStore {
  #directory;
  #logger;
  #identityPath;
  #credentialPath;

  constructor(dataDirectory, logger) {
    this.#directory = dataDirectory;
    this.#logger = logger;
    this.#identityPath = path.join(dataDirectory, "identity.json");
    this.#credentialPath = path.join(dataDirectory, "credential.bin");
  }

  get credentialPath() {
    return this.#credentialPath;
  }

  /** Stable per-install identity. Generated once and reused, so re-authorising keeps the same name. */
  async ensureIdentity() {
    await mkdir(this.#directory, { recursive: true });
    try {
      const raw = await readFile(this.#identityPath, "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed.extensionInstanceId === "string" && parsed.extensionInstanceId.length >= 8) {
        return parsed;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.#logger?.warn("Identity", `identity.json 无法读取，将重新生成：${describeError(error)}`);
      }
    }
    const identity = {
      extensionInstanceId: `mismatch-${randomBytes(8).toString("hex")}`,
      createdAt: new Date().toISOString()
    };
    const temporary = `${this.#identityPath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
    await rename(temporary, this.#identityPath);
    this.#logger?.info("Identity", `已生成本机扩展实例 ID ${identity.extensionInstanceId}`);
    return identity;
  }

  async loadCredential() {
    const fromEnvironment = process.env[CREDENTIAL_ENV];
    if (fromEnvironment) {
      try {
        const parsed = JSON.parse(fromEnvironment);
        if (parsed?.credential && parsed?.extensionInstanceId) {
          this.#logger?.info("Credential", "使用环境变量注入的扩展凭据（不会写入磁盘）");
          return parsed;
        }
      } catch {
        this.#logger?.warn("Credential", `${CREDENTIAL_ENV} 不是有效的 JSON，已忽略`);
      }
    }

    let cipher;
    try {
      cipher = await readFile(this.#credentialPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }

    try {
      const plain = await unprotectString(cipher);
      const state = JSON.parse(plain);
      if (!state?.credential || !state?.extensionInstanceId) {
        throw new Error("凭据内容不完整");
      }
      return state;
    } catch (error) {
      this.#logger?.warn("Credential", `本地凭据无法解密，需要重新授权：${describeError(error)}`);
      await rm(this.#credentialPath, { force: true }).catch(() => {});
      return null;
    }
  }

  async saveCredential(state) {
    await mkdir(this.#directory, { recursive: true });
    const cipher = await protectString(JSON.stringify(state));
    const temporary = `${this.#credentialPath}.tmp`;
    await writeFile(temporary, cipher, "utf8");
    await rename(temporary, this.#credentialPath);
  }

  async clearCredential() {
    await rm(this.#credentialPath, { force: true }).catch(() => {});
  }
}
