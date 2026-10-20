import assert from "node:assert/strict";
import test from "node:test";
import { isOlderVersion, isSameVersion, parseVersion } from "../payload/src/version.js";

test("versions are compared numerically, not lexicographically", () => {
  assert.equal(isOlderVersion("1.0.9", "1.0.10"), true);
  assert.equal(isOlderVersion("1.9.0", "1.10.0"), true);
  assert.equal(isOlderVersion("2.0.0", "1.99.99"), false);
  assert.equal(isOlderVersion("1.1.0", "1.1.0"), false);
  assert.equal(isSameVersion("1.1", "1.1.0"), true);
});

test("missing or odd version strings degrade to zero", () => {
  assert.deepEqual(parseVersion(""), [0]);
  assert.deepEqual(parseVersion("1.2.3"), [1, 2, 3]);
  assert.equal(isOlderVersion(undefined, "1.0.0"), true);
  assert.equal(isOlderVersion("1.0.0", undefined), false);
});
