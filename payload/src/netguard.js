import os from "node:os";

/**
 * Network guard for the panel, which can be exposed to the local LAN.
 *
 * Two independent checks:
 *   - Host allow-list: defends against DNS rebinding. A malicious site can point its own domain at
 *     192.168.x.x, and then the browser sends Host: evil.example. Requests whose Host is not this
 *     machine (loopback, a private address, or the computer name) are refused.
 *   - Optional shared token: when set, pages and APIs require ?token=… (remembered in a cookie).
 */

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const LOCAL_SUFFIXES = [".local", ".lan", ".home", ".home.arpa", ".localdomain"];

export function hostnameOf(hostHeader) {
  const value = String(hostHeader || "").trim().toLowerCase();
  if (!value) return "";
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 0 ? value.slice(0, end + 1) : value;
  }
  return value.split(":")[0];
}

export function isPrivateAddress(hostname) {
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  return hostname === "::1" || hostname === "[::1]";
}

export function createHostGuard({ extraHostnames = [] } = {}) {
  const machineName = String(os.hostname() || "").toLowerCase();
  const machineNameShort = machineName.split(".")[0];
  const extras = new Set(extraHostnames.map((value) => String(value || "").toLowerCase()).filter(Boolean));
  return function isAllowedHost(hostHeader) {
    const hostname = hostnameOf(hostHeader);
    if (!hostname) return false;
    if (LOOPBACK_NAMES.has(hostname)) return true;
    if (extras.has(hostname)) return true;
    if (machineName && (hostname === machineName || hostname === machineNameShort)) return true;
    if (isPrivateAddress(hostname)) return true;
    // Single-label names (e.g. "packing-pc") cannot be registered on the public internet, and LAN
    // suffixes are local-only, so both are safe to accept. Multi-label public domains still have to
    // be listed explicitly in panelAllowedHosts, which keeps DNS rebinding out.
    if (!hostname.includes(".")) return true;
    if (LOCAL_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return true;
    return false;
  };
}

export function readCookie(headerValue, name) {
  for (const part of String(headerValue || "").split(";")) {
    const [key, ...rest] = part.split("=");
    if (key && key.trim() === name) return rest.join("=").trim();
  }
  return "";
}

/** Returns true when the request may proceed. A valid ?token= is remembered in a cookie. */
export function createTokenGuard(token, cookieName = "pp_panel_token") {
  const expected = String(token || "").trim();
  if (!expected) return { required: false, check: () => ({ ok: true, setCookie: "" }) };
  return {
    required: true,
    cookieName,
    check(url, headers) {
      const fromQuery = url.searchParams.get("token") || "";
      if (fromQuery && fromQuery === expected) {
        return { ok: true, setCookie: `${cookieName}=${encodeURIComponent(expected)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800` };
      }
      const fromHeader = String(headers["x-panel-token"] || "");
      if (fromHeader && fromHeader === expected) return { ok: true, setCookie: "" };
      const fromCookie = readCookie(headers.cookie, cookieName);
      if (fromCookie && fromCookie === expected) return { ok: true, setCookie: "" };
      return { ok: false, setCookie: "" };
    }
  };
}

/** Every non-internal IPv4 address, so the console can print usable panel URLs. */
export function listLanAddresses() {
  const addresses = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      addresses.push({ interface: name, address: entry.address, family: "IPv4" });
    }
  }
  return addresses;
}

export function bindAddressFor(bind) {
  return bind === "lan" ? "0.0.0.0" : "127.0.0.1";
}

export function panelUrls(port, bind) {
  const urls = [`http://127.0.0.1:${port}/`];
  if (bind !== "loopback") {
    for (const item of listLanAddresses()) {
      urls.push(`http://${item.address}:${port}/`);
    }
  }
  return urls;
}
