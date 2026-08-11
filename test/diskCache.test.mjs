import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import fs from "node:fs";
import os from "node:os";
import { DiskRecordsCache, diskCacheKey } from "../out/indexer/diskCache.js";

const identity = {
  projectDir: "C:/proj",
  sdkDir: "C:/sdk",
  indexSageXml: true,
  additionalDataSearchPaths: [],
  builtmodsDirs: ["C:/sdk/builtmods"],
};

const sampleRecords = {
  assets: [{ type: "GameObject", id: "TankA", line: 3 }],
  defines: [{ name: "HP", value: "100", line: 2 }],
  includes: [{ type: "all", source: "Units.xml", line: 4 }],
  rootXiIncludes: [],
  nestedXiIncludes: [],
  references: [],
};

function stampOf(file) {
  const s = fs.statSync(file);
  return {
    mtimeMs: s.mtimeMs,
    size: s.size,
    birthtimeMs: s.birthtimeMs,
    ctimeMs: s.ctimeMs,
  };
}

function makeTmp(t) {
  const tmp = fs.mkdtempSync(join(os.tmpdir(), "ra3-diskcache-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return tmp;
}

test("disk cache roundtrip keeps records and leaves no temp file", async (t) => {
  const tmp = makeTmp(t);
  const file = join(tmp, "a.xml");
  fs.writeFileSync(file, "0123456789");
  const filePath = join(tmp, "index-records.json.gz");
  const cache = new DiskRecordsCache(filePath, identity);

  await cache.save([
    [
      file.toLowerCase(),
      {
        stat: stampOf(file),
        records: sampleRecords,
        kind: "full",
        contentHash: "abc123",
      },
    ],
  ]);
  assert.equal(fs.existsSync(`${filePath}.tmp`), false, "atomic write leaves no temp");

  const { records, stats } = await cache.loadValidated();
  assert.equal(stats.fileExists, true);
  assert.equal(stats.keyMatched, true);
  assert.equal(stats.loaded, 1);
  assert.equal(stats.validated, 1);
  assert.equal(stats.dropped, 0);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].records, sampleRecords);
  assert.equal(records[0].contentHash, "abc123");
});

test("stat mismatch drops the cached entry", async (t) => {
  const tmp = makeTmp(t);
  const file = join(tmp, "a.xml");
  fs.writeFileSync(file, "0123456789");
  const filePath = join(tmp, "index-records.json.gz");
  const cache = new DiskRecordsCache(filePath, identity);
  await cache.save([
    [file.toLowerCase(), { stat: stampOf(file), records: sampleRecords, kind: "full" }],
  ]);

  const past = new Date(Date.now() - 60000);
  fs.utimesSync(file, past, past);
  const { records, stats } = await cache.loadValidated();
  assert.equal(stats.validated, 0);
  assert.equal(stats.dropped, 1);
  assert.equal(records.length, 0);
});

test("identity mismatch ignores the cache", async (t) => {
  const tmp = makeTmp(t);
  const file = join(tmp, "a.xml");
  fs.writeFileSync(file, "0123456789");
  const filePath = join(tmp, "index-records.json.gz");
  const cache = new DiskRecordsCache(filePath, identity);
  await cache.save([
    [file.toLowerCase(), { stat: stampOf(file), records: sampleRecords, kind: "full" }],
  ]);

  const other = new DiskRecordsCache(filePath, {
    ...identity,
    sdkDir: "D:/other-sdk",
  });
  const { records, stats } = await other.loadValidated();
  assert.equal(stats.fileExists, true);
  assert.equal(stats.keyMatched, false);
  assert.equal(records.length, 0);
});

test("corrupt cache file yields an empty result", async (t) => {
  const tmp = makeTmp(t);
  const filePath = join(tmp, "index-records.json.gz");
  fs.writeFileSync(filePath, "this is not gzip json");
  const cache = new DiskRecordsCache(filePath, identity);
  const { records, stats } = await cache.loadValidated();
  assert.equal(stats.fileExists, true);
  assert.equal(records.length, 0);
});

test("clear removes the cache file", async (t) => {
  const tmp = makeTmp(t);
  const file = join(tmp, "a.xml");
  fs.writeFileSync(file, "0123456789");
  const filePath = join(tmp, "index-records.json.gz");
  const cache = new DiskRecordsCache(filePath, identity);
  await cache.save([
    [file.toLowerCase(), { stat: stampOf(file), records: sampleRecords, kind: "full" }],
  ]);
  assert.ok(fs.existsSync(filePath));
  await cache.clear();
  assert.equal(fs.existsSync(filePath), false);
});

test("diskCacheKey differs when the identity changes", () => {
  const a = diskCacheKey(identity);
  const b = diskCacheKey({ ...identity, indexSageXml: false });
  assert.notEqual(a, b);
  assert.equal(a, diskCacheKey(identity));
});

test("load returns records without stat validation", async (t) => {
  const tmp = makeTmp(t);
  const file = join(tmp, "a.xml");
  fs.writeFileSync(file, "0123456789");
  const filePath = join(tmp, "index-records.json.gz");
  const cache = new DiskRecordsCache(filePath, identity);
  await cache.save([
    [
      file.toLowerCase(),
      { stat: stampOf(file), records: sampleRecords, kind: "full" },
    ],
  ]);

  const { records, stats } = await cache.load();
  assert.equal(records.length, 1);
  assert.equal(stats.fileExists, true);
  assert.equal(stats.keyMatched, true);
  assert.equal(stats.loaded, 1);
  assert.equal(stats.validated, 0);
  assert.equal(stats.dropped, 0);
  assert.ok(stats.loadMs >= 0);
});

test("validate reports changed/missing entries and keeps valid ones", async (t) => {
  const tmp = makeTmp(t);
  const a = join(tmp, "a.xml");
  const b = join(tmp, "b.xml");
  fs.writeFileSync(a, "0123456789");
  fs.writeFileSync(b, "0123456789");
  const filePath = join(tmp, "index-records.json.gz");
  const cache = new DiskRecordsCache(filePath, identity);
  await cache.save([
    [a.toLowerCase(), { stat: stampOf(a), records: sampleRecords, kind: "full" }],
    [b.toLowerCase(), { stat: stampOf(b), records: sampleRecords, kind: "full" }],
  ]);

  const { records } = await cache.load();
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(b, past, past);
  const progress = [];
  const { stats, kept, invalidKeys } = await cache.validate(records, (done, total) => {
    progress.push([done, total]);
  });
  assert.equal(stats.validated, 1);
  assert.equal(stats.dropped, 1);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].key, a.toLowerCase());
  assert.deepEqual(invalidKeys, [b.toLowerCase()]);
  assert.ok(stats.validateMs >= 0);
  assert.deepEqual(progress[progress.length - 1], [1, 2]);
  assert.ok(progress.every(([done], i) => i === 0 || done >= progress[i - 1][0]));
});
