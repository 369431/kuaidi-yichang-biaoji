/** "1.2.3" style comparison used to decide whether a running instance should make way for this one. */
export function parseVersion(value) {
  return String(value || "0")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

/** True when `running` is strictly older than `current`. */
export function isOlderVersion(running, current) {
  const left = parseVersion(running);
  const right = parseVersion(current);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] || 0;
    const b = right[index] || 0;
    if (a !== b) return a < b;
  }
  return false;
}

export function isSameVersion(left, right) {
  return !isOlderVersion(left, right) && !isOlderVersion(right, left);
}
