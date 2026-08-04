import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  isContentRelevantPath,
  isWatcherNoisePath,
} from "../out/indexer/fileScanner.js";

test("isWatcherNoisePath filters .git internals", () => {
  assert.equal(
    isWatcherNoisePath(join("C:/proj", ".git", "index")),
    true,
    ".git files are noise",
  );
  assert.equal(
    isWatcherNoisePath(join("C:/proj", "data", ".git", "FETCH_HEAD")),
    true,
    "nested .git directories are noise",
  );
  assert.equal(
    isWatcherNoisePath(join("C:/proj", "Data", "Mod.xml")),
    false,
    "project XML is not noise",
  );
  assert.equal(
    isWatcherNoisePath(join("C:/proj", ".gitignore")),
    false,
    ".gitignore is a real project file",
  );
  assert.equal(
    isWatcherNoisePath(join("C:/proj", "Data", "UnitCrate.xml.git")),
    true,
    "editor temp files ending in .git are noise",
  );
  assert.equal(
    isWatcherNoisePath(join("C:/proj", "Data", "UnitCrate.xml.tmp")),
    true,
    ".tmp files are noise",
  );
  assert.equal(
    isWatcherNoisePath(join("C:/proj", "Data", "Mod.xml~")),
    true,
    "backup files ending in ~ are noise",
  );
  assert.equal(
    isWatcherNoisePath(join("C:/proj", "Data", ".#Mod.xml")),
    true,
    "lock files starting with .# are noise",
  );
});

test("isContentRelevantPath only reacts to XML-ish content", () => {
  assert.equal(isContentRelevantPath("a.xml"), true);
  assert.equal(isContentRelevantPath("a.w3x"), true);
  assert.equal(
    isContentRelevantPath("a.manifestxml"),
    false,
    "there is no .manifestxml source format",
  );
  assert.equal(
    isContentRelevantPath("a.w3d"),
    false,
    ".w3d is binary art, not text XML",
  );
  assert.equal(isContentRelevantPath("a.dds"), false);
  assert.equal(isContentRelevantPath("a.xml.git"), false);
  assert.equal(
    isContentRelevantPath("a.lua"),
    false,
    "lua is not indexed yet",
  );
});
