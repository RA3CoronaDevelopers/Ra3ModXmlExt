import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Minimal vscode shim without l10n: exercises the fallback path that unit
// tests and extension hosts without a loaded bundle use.
const require = createRequire(import.meta.url);
const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "vscode") return "vscode-stub";
  return origResolve.call(this, request, ...args);
};
require.cache["vscode-stub"] = {
  id: "vscode-stub",
  filename: "vscode-stub",
  loaded: true,
  exports: {},
};

const { t, tN } = require("../out/localize.js");

test("t fallback substitutes positional placeholders", () => {
  assert.equal(t("Hello {0}!", "World"), "Hello World!");
  assert.equal(t("{0} and {1}", "A", 2), "A and 2");
  assert.equal(t("No placeholders"), "No placeholders");
});

test("tN fallback substitutes named placeholders", () => {
  assert.equal(tN("Hello {name}", { name: "Codex" }), "Hello Codex");
  assert.equal(
    tN("Keep {missing}", {}),
    "Keep {missing}",
    "unknown placeholders stay untouched",
  );
});
