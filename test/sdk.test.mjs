import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  normalizeSdkPath,
  parseRegistryInstallLocation,
  validateSdkPath,
} from "../out/sdk.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function makeSdk(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ra3-sdk-"));
  const rel = (p) => join(dir, ...p.split("/"));
  mkdirSync(rel("Schemas/xsd"), { recursive: true });
  writeFileSync(
    join(rel("Schemas/xsd"), "CnC3Types.xsd"),
    "<xs:schema/>",
    "utf8",
  );
  for (const d of extra.dirs ?? []) mkdirSync(rel(d), { recursive: true });
  for (const f of extra.files ?? []) {
    mkdirSync(dirname(rel(f)), { recursive: true });
    writeFileSync(rel(f), "x", "utf8");
  }
  return dir;
}

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ra3-sdk-case-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("normalizeSdkPath trims quotes and resolves to an absolute path", () => {
  const raw = ` "${join(root, "test", "fixtures", "fakesdk")}" `;
  assert.equal(normalizeSdkPath(raw), resolve(join(root, "test", "fixtures", "fakesdk")));
  assert.equal(normalizeSdkPath("  "), "");
  assert.equal(normalizeSdkPath(""), "");
});

test("validateSdkPath: empty value is missing", () => {
  const v = validateSdkPath("");
  assert.equal(v.status, "missing");
  assert.equal(v.path, "");
});

test("validateSdkPath: nonexistent path is missing", () => {
  const v = validateSdkPath(join(tmpdir(), "ra3-no-such-sdk"));
  assert.equal(v.status, "missing");
  assert.ok(v.path);
});

test("validateSdkPath: directory without the SDK marker is not an SDK", () => {
  withTemp((dir) => {
    const v = validateSdkPath(dir);
    assert.equal(v.status, "not-sdk");
    assert.deepEqual(v.missing, ["Schemas/xsd/CnC3Types.xsd"]);
  });
});

test("validateSdkPath: partial lists the missing functional items", () => {
  const dir = makeSdk({
    dirs: ["builtmods"],
    files: ["Static.xml"],
  });
  try {
    const v = validateSdkPath(dir);
    assert.equal(v.status, "partial");
    assert.deepEqual(v.missing, [
      "SageXml",
      "Mods",
      "Global.xml",
      "Audio.xml",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateSdkPath: complete SDK is ok", () => {
  const dir = makeSdk({
    dirs: ["builtmods", "SageXml", "Mods"],
    files: ["Static.xml", "Global.xml", "Audio.xml"],
  });
  try {
    const v = validateSdkPath(dir);
    assert.equal(v.status, "ok");
    assert.deepEqual(v.missing, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateSdkPath: marker matching is case-insensitive on Windows", (t) => {
  if (process.platform !== "win32") return t.skip("case-insensitive fs is Windows-only");
  withTemp((dir) => {
    mkdirSync(join(dir, "schemas", "xsd"), { recursive: true });
    writeFileSync(join(dir, "schemas", "xsd", "cnc3types.xsd"), "x", "utf8");
    const v = validateSdkPath(dir);
    assert.notEqual(v.status, "not-sdk", "lower-case marker still identifies the SDK");
  });
});

test("parseRegistryInstallLocation extracts the value from reg.exe output", () => {
  const out = [
    "",
    "HKEY_LOCAL_MACHINE\\Software\\Wow6432Node\\...",
    "    InstallLocation    REG_SZ    C:\\Apps\\RA3-MODSDK-X",
    "",
  ].join("\r\n");
  assert.equal(parseRegistryInstallLocation(out), "C:\\Apps\\RA3-MODSDK-X");
  assert.equal(parseRegistryInstallLocation("no such key"), null);
  assert.equal(
    parseRegistryInstallLocation("    DisplayName    REG_SZ    SDK"),
    null,
  );
});
