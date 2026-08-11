import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  buildSearchPaths,
  buildVanillaSearchPaths,
  resolveSource,
  manifestPathForReference,
} from "../out/indexer/includeResolver.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const project = join(root, "test", "fixtures", "minimod");
const sdk = join(root, "test", "fixtures", "fakesdk");
const paths = buildSearchPaths(sdk, project);

test("resolves relative includes against the current file directory", () => {
  const current = join(project, "Data", "Includes");
  const r = resolveSource("BaseVehicle.xml", current, paths);
  assert.equal(r.path, join(project, "Data", "Includes", "BaseVehicle.xml"));
});

test("resolves DATA: includes through search paths", () => {
  const r = resolveSource("DATA:static.xml", null, paths);
  assert.equal(r.path, join(sdk, "static.xml"));
  const r2 = resolveSource("DATA:SageXml/Vanilla.xml", null, paths);
  assert.equal(r2.path, join(sdk, "SageXml", "Vanilla.xml"));
});

test("case-insensitive prefix", () => {
  const r = resolveSource("data:static.xml", null, paths);
  assert.equal(r.path, join(sdk, "static.xml"));
});

test("missing target returns null", () => {
  const r = resolveSource("DATA:nope/nothere.xml", null, paths);
  assert.equal(r.path, null);
  assert.equal(r.prefix, "DATA");
});

test("search paths follow the BinaryAssetBuilder /data /art /audio order", () => {
  // defaultscript.cs getIncludePaths():
  //   /data:  ".;{modGranParent};{0}\Data;.\Mods;{1};.\SageXml"
  //   /art:   ".;{modGranParent};{0}\Art1;{0}\Art;.\Mods;{1};.\Art"
  //   /audio: ".;{modGranParent};{0}\Audio1;{0}\Audio;.\Mods;{1};.\Audio"
  // where "." = sdkDir, {0} = projectDir, {1} = modParentPath,
  // {2} = modGranParent.
  const modParent = dirname(project);
  const granParent = dirname(modParent);
  assert.deepEqual(paths.DATA, [
    sdk,
    granParent,
    join(project, "Data"),
    join(sdk, "Mods"),
    modParent,
    join(sdk, "SageXml"),
  ]);
  assert.deepEqual(paths.ART, [
    sdk,
    granParent,
    join(project, "Art1"),
    join(project, "Art"),
    join(sdk, "Mods"),
    modParent,
    join(sdk, "Art"),
  ]);
  assert.deepEqual(paths.AUDIO, [
    sdk,
    granParent,
    join(project, "Audio1"),
    join(project, "Audio"),
    join(sdk, "Mods"),
    modParent,
    join(sdk, "Audio"),
  ]);
});

test("DATA:Static.xml prefers the SDK root over SageXml", () => {
  // Both the SDK root and SageXml contain a Static.xml; BAB order resolves to
  // the SDK root placeholder first.
  const r = resolveSource("DATA:Static.xml", null, paths);
  assert.equal(r.path, join(sdk, "Static.xml"));
});

test("vanilla search paths stay inside the SDK", () => {
  const vanilla = buildVanillaSearchPaths(sdk);
  assert.deepEqual(vanilla.DATA, [sdk, join(sdk, "SageXml")]);
  assert.deepEqual(vanilla.ART, [sdk, join(sdk, "Art")]);
  assert.deepEqual(vanilla.AUDIO, [sdk, join(sdk, "Audio")]);
});

test("empty SDK path produces project-only search paths", () => {
  const modParent = dirname(project);
  const granParent = dirname(modParent);
  const paths = buildSearchPaths("", project);
  assert.deepEqual(paths.DATA, [
    granParent,
    join(project, "Data"),
    modParent,
  ]);
  assert.deepEqual(paths.ART, [
    granParent,
    join(project, "Art1"),
    join(project, "Art"),
    modParent,
  ]);
  assert.deepEqual(paths.AUDIO, [
    granParent,
    join(project, "Audio1"),
    join(project, "Audio"),
    modParent,
  ]);
  const r = resolveSource("DATA:static.xml", null, paths);
  assert.equal(r.path, null, "DATA: include never falls back to the cwd");

  const vanilla = buildVanillaSearchPaths("");
  assert.deepEqual(vanilla.DATA, []);
  assert.deepEqual(vanilla.ART, []);
  assert.deepEqual(vanilla.AUDIO, []);
});

test("manifest sources resolve with vanilla-only paths (mod shadow ignored)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ra3-vanilla-"));
  try {
    const sdkDir = join(tmp, "sdk");
    const projectDir = join(tmp, "project");
    const rel = "globaldata/weapon.xml";
    const sageFile = join(sdkDir, "SageXml", rel);
    const modFile = join(projectDir, "Data", rel);
    mkdirSync(dirname(sageFile), { recursive: true });
    mkdirSync(dirname(modFile), { recursive: true });
    writeFileSync(sageFile, "<AssetDeclaration/>", "utf8");
    writeFileSync(modFile, "<AssetDeclaration/>", "utf8");

    const normal = resolveSource(
      "DATA:globaldata/weapon.xml",
      null,
      buildSearchPaths(sdkDir, projectDir),
    );
    const vanilla = resolveSource(
      "DATA:globaldata/weapon.xml",
      null,
      buildVanillaSearchPaths(sdkDir),
    );

    assert.equal(normal.path, modFile, "normal BAB order picks the mod file");
    assert.equal(vanilla.path, sageFile, "manifest source stays on SageXml");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("missing vanilla source returns null even when the project shadows the path", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ra3-vanilla-missing-"));
  try {
    const sdkDir = join(tmp, "sdk");
    const projectDir = join(tmp, "project");
    const modFile = join(projectDir, "Data", "globaldata", "weapon.xml");
    mkdirSync(dirname(modFile), { recursive: true });
    writeFileSync(modFile, "<AssetDeclaration/>", "utf8");

    const vanilla = resolveSource(
      "DATA:globaldata/weapon.xml",
      null,
      buildVanillaSearchPaths(sdkDir),
    );
    assert.equal(vanilla.path, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("manifest mapping strips the prefix", () => {
  const dirs = [join(sdk, "builtmods")];
  assert.equal(manifestPathForReference("DATA:static.xml", dirs), join(dirs[0], "static.manifest"));
  assert.equal(manifestPathForReference("DATA:audio.xml", dirs), join(dirs[0], "audio.manifest"));
  assert.equal(manifestPathForReference("DATA:missing.xml", dirs), null);
});
