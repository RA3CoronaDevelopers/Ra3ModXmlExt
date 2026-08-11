import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  findProjectRootUpward,
  findProjectRootForFile,
  discoverProjects,
  isProjectRoot,
} = require("../out/projectRoot.js");

let fixtureRoot;
let counter = 0;

function scratch(rel = "") {
  if (!fixtureRoot) {
    fixtureRoot = mkdtempSync(join(tmpdir(), "ra3-projectroot-"));
  }
  const dir = join(fixtureRoot, String(counter++), rel);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function write(dir, rel, content = "") {
  const file = join(dir, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
  return file;
}

test.after(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

test("upward discovery: Data folder, subfolders and additionalmaps", () => {
  const root = scratch();
  write(root, "Data/Mod.xml", "<AssetDeclaration/>");
  assert.equal(findProjectRootUpward(join(root, "Data")), resolve(root));
  assert.equal(
    findProjectRootUpward(join(root, "Data", "GlobalData", "Units")),
    resolve(root),
  );
  assert.equal(
    findProjectRootUpward(join(root, "Data", "additionalmaps", "nested")),
    resolve(root),
  );
});

test("upward discovery: mapmetadata-only mod", () => {
  const root = scratch();
  write(root, "Data/additionalmaps/mapmetadata_Global.xml", "<MapMetadata/>");
  assert.equal(
    findProjectRootUpward(join(root, "Data", "additionalmaps")),
    resolve(root),
  );
  assert.equal(findProjectRootUpward(join(root, "Data")), resolve(root));
  assert.equal(isProjectRoot(root), true);
});

test("upward discovery: case-insensitive Data and Mod.xml", () => {
  const root = scratch();
  write(root, "data/mod.xml", "<AssetDeclaration/>");
  assert.equal(findProjectRootUpward(join(root, "Data")), resolve(root));
  assert.equal(findProjectRootUpward(root), resolve(root));
});

test("upward discovery: babproj markers", () => {
  const root = scratch();
  write(root, "mod.babproj", "");
  assert.equal(findProjectRootUpward(root), resolve(root));

  const root2 = scratch();
  write(root2, "SomeProject.babproj", "");
  assert.equal(findProjectRootUpward(root2), resolve(root2));
});

test("upward discovery: no marker returns null", () => {
  const root = scratch();
  write(root, "random/file.txt", "x");
  assert.equal(findProjectRootUpward(root), null);
  assert.equal(findProjectRootUpward(join(root, "random")), null);
});

test("upward discovery: max depth respected", () => {
  const root = scratch();
  write(root, "Data/Mod.xml", "<AssetDeclaration/>");
  let deep = root;
  for (let i = 0; i < 14; i++) {
    deep = join(deep, `level${i}`);
    mkdirSync(deep);
  }
  assert.equal(findProjectRootUpward(deep, 12), null);
  assert.equal(findProjectRootUpward(deep, 20), resolve(root));
});

test("upward discovery from a single file", () => {
  const root = scratch();
  write(root, "Data/additionalmaps/mapmetadata_Maps.xml", "<MapMetadata/>");
  const file = write(root, "Data/Units/Unit.xml", "<AssetDeclaration/>");
  assert.equal(findProjectRootForFile(file), resolve(root));
});

test("discoverProjects: sibling mods in a container", () => {
  const container = scratch();
  write(container, "ModA/Data/Mod.xml", "<AssetDeclaration/>");
  write(
    container,
    "ModB/Data/additionalmaps/mapmetadata_B.xml",
    "<MapMetadata/>",
  );
  const found = discoverProjects(container).map((p) => resolve(p));
  assert.equal(found.length, 2);
  assert.ok(found.includes(resolve(join(container, "ModA"))));
  assert.ok(found.includes(resolve(join(container, "ModB"))));
});

test("discoverProjects: SDK-style deep layout (mods/mods/corona)", () => {
  const container = scratch();
  write(
    container,
    "mods/mods/corona/Data/Mod.xml",
    "<AssetDeclaration/>",
  );
  const found = discoverProjects(container).map((p) => resolve(p));
  assert.deepEqual(found, [resolve(join(container, "mods", "mods", "corona"))]);
});

test("discoverProjects: skips known non-mod directories", () => {
  const container = scratch();
  write(
    container,
    "node_modules/FakeMod/Data/Mod.xml",
    "<AssetDeclaration/>",
  );
  write(container, ".git/Data/Mod.xml", "<AssetDeclaration/>");
  assert.deepEqual(discoverProjects(container), []);
});

test("discoverProjects: de-duplicates and stops at a root", () => {
  const container = scratch();
  write(container, "ModA/Data/Mod.xml", "<AssetDeclaration/>");
  write(container, "ModA/Inner/Data/Mod.xml", "<AssetDeclaration/>");
  const first = discoverProjects(container);
  const second = discoverProjects(container);
  assert.deepEqual(second, first);
  assert.equal(first.length, 1);
  assert.equal(resolve(first[0]), resolve(join(container, "ModA")));
});

test("nested roots: nearest ancestor wins upward", () => {
  const outer = scratch();
  write(outer, "Data/Mod.xml", "<AssetDeclaration/>");
  const inner = join(outer, "Inner");
  write(inner, "Data/Mod.xml", "<AssetDeclaration/>");
  const file = write(inner, "Data/Units/Unit.xml", "<AssetDeclaration/>");
  assert.equal(findProjectRootForFile(file), resolve(inner));
});
