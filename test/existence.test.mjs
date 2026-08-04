import { test } from "node:test";
import assert from "node:assert/strict";
import { join, parse, resolve } from "node:path";
import fs from "node:fs";
import os from "node:os";
import { resolveSource } from "../out/indexer/includeResolver.js";
import {
  ExistenceSnapshot,
  buildExistenceSnapshot,
  isDriveRoot,
} from "../out/indexer/existence.js";

function makeTmp(t) {
  const tmp = fs.mkdtempSync(join(os.tmpdir(), "ra3-existence-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return tmp;
}

test("isDriveRoot detects filesystem roots", () => {
  assert.equal(isDriveRoot(parse(process.cwd()).root), true);
  assert.equal(isDriveRoot(process.cwd()), false);
});

test("ExistenceSnapshot answers covered paths and falls back outside roots", (t) => {
  const tmp = makeTmp(t);
  const dataDir = join(tmp, "data");
  fs.mkdirSync(dataDir);
  const existing = join(dataDir, "Units.xml");
  fs.writeFileSync(existing, "<x/>");

  const snap = new ExistenceSnapshot([dataDir]);
  assert.equal(snap.has(existing), true);
  assert.equal(snap.has(join(dataDir, "Missing.xml")), false);
  assert.equal(snap.has(join(tmp, "outside.xml")), null, "outside roots is unknown");
  assert.ok(snap.hits >= 2, "covered lookups counted as hits");
  assert.equal(snap.fallbacks, 1);

  if (process.platform === "win32") {
    assert.equal(
      snap.has(existing.toUpperCase()),
      true,
      "lookup is case-insensitive on Windows",
    );
  }
});

test("buildExistenceSnapshot covers bounded search bases lazily", async (t) => {
  const tmp = makeTmp(t);
  const dataDir = join(tmp, "data");
  const artDir = join(tmp, "art");
  fs.mkdirSync(join(dataDir, "sub"), { recursive: true });
  fs.mkdirSync(artDir);
  fs.writeFileSync(join(dataDir, "Units.xml"), "<x/>");
  fs.writeFileSync(join(dataDir, "sub", "Nested.xml"), "<x/>");
  fs.writeFileSync(join(artDir, "Tank.w3x"), "<x/>");

  const snap = buildExistenceSnapshot({
    DATA: [dataDir],
    ART: [artDir],
    AUDIO: [],
  });
  assert.equal(snap.has(join(dataDir, "Units.xml")), true);
  assert.equal(snap.has(join(dataDir, "sub", "Nested.xml")), true);
  assert.equal(snap.has(join(artDir, "Tank.w3x")), true);
  assert.equal(snap.has(join(dataDir, "Missing.xml")), false);
});

test("resolveSource uses the snapshot and falls back to statSync outside it", async (t) => {
  const tmp = makeTmp(t);
  const dataDir = join(tmp, "data");
  const outsideDir = join(tmp, "outside");
  fs.mkdirSync(dataDir);
  fs.mkdirSync(outsideDir);
  const units = join(dataDir, "Units.xml");
  const outside = join(outsideDir, "Extra.xml");
  fs.writeFileSync(units, "<x/>");
  fs.writeFileSync(outside, "<x/>");

  const searchPaths = { DATA: [dataDir], ART: [], AUDIO: [] };
  const snap = buildExistenceSnapshot(searchPaths);

  const found = resolveSource("DATA:Units.xml", null, searchPaths, snap);
  assert.equal(found.path, units);
  assert.ok(snap.hits > 0, "covered lookup served by the snapshot");

  const missing = resolveSource("DATA:Missing.xml", null, searchPaths, snap);
  assert.equal(missing.path, null);

  const emptySearchPaths = { DATA: [], ART: [], AUDIO: [] };
  const outsideResolved = resolveSource(
    outside,
    outsideDir,
    emptySearchPaths,
    snap,
  );
  assert.equal(
    resolve(outsideResolved.path ?? ""),
    resolve(outside),
    "uncovered path falls back to statSync",
  );
  assert.ok(snap.fallbacks > 0, "fallback counted");
});
