import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";

const MAX_LOG_BYTES = 2 * 1024 * 1024;

/**
 * Minimal append-only logger. It never throws: logging problems must not stop packing.
 * Writes go to <dataDir>/logs/extension.log and the console.
 */
export class Logger {
  #directory;
  #filePath;
  #bridge = Promise.resolve();
  #mirrorConsole;

  constructor(dataDirectory, { mirrorConsole = true } = {}) {
    this.#directory = path.join(dataDirectory, "logs");
    this.#filePath = path.join(this.#directory, "extension.log");
    this.#mirrorConsole = mirrorConsole;
  }

  info(scope, message) {
    this.#write("INFO", scope, message);
  }

  warn(scope, message) {
    this.#write("WARN", scope, message);
  }

  error(scope, message, error) {
    const detail = error instanceof Error ? `${message}: ${error.message}` : message;
    this.#write("ERROR", scope, detail);
  }

  #write(level, scope, message) {
    const line = `${new Date().toISOString()} [${level}] [${scope}] ${message}`;
    if (this.#mirrorConsole) {
      const stream = level === "ERROR" ? process.stderr : process.stdout;
      stream.write(`${line}\n`);
    }
    this.#bridge = this.#bridge
      .then(() => this.#append(line))
      .catch(() => {});
  }

  async #append(line) {
    await mkdir(this.#directory, { recursive: true });
    try {
      const info = await stat(this.#filePath);
      if (info.size > MAX_LOG_BYTES) {
        await rename(this.#filePath, `${this.#filePath}.1`).catch(() => {});
      }
    } catch {
      // Log file does not exist yet.
    }
    await appendFile(this.#filePath, `${line}\n`, "utf8");
  }
}

export function describeError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
