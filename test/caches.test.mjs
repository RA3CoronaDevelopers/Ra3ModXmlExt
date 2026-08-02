import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DocumentCache,
  IncludeResolveCache,
  IndexRecordsCache,
} from "../out/indexer/caches.js";

function parsed(path, elements) {
  return {
    file: { path, stat: { mtimeMs: 1, size: 1 } },
    parse: { root: { name: "r" }, elements: new Array(elements), errors: [] },
    records: null,
    lineMap: null,
  };
}

test("DocumentCache evicts the largest tree when over the element budget", () => {
  const cache = new DocumentCache(64, 100);
  cache.set(parsed("a.xml", 60));
  cache.set(parsed("b.xml", 60));
  assert.equal(cache.get("a.xml"), undefined, "largest tree evicted first");
  assert.ok(cache.get("b.xml"));
});

test("DocumentCache evicts least recently used when over capacity", () => {
  const cache = new DocumentCache(2, 1_000_000);
  cache.set(parsed("a.xml", 10));
  cache.set(parsed("b.xml", 10));
  cache.set(parsed("c.xml", 10));
  assert.equal(cache.get("a.xml"), undefined);
  assert.ok(cache.get("b.xml"));
  assert.ok(cache.get("c.xml"));
});

test("DocumentCache invalidate frees budget", () => {
  const cache = new DocumentCache(64, 100);
  cache.set(parsed("a.xml", 60));
  cache.invalidate("a.xml");
  cache.set(parsed("b.xml", 60));
  assert.ok(cache.get("b.xml"), "invalidating a freed its budget share");
  cache.set(parsed("c.xml", 60));
  assert.equal(cache.get("a.xml"), undefined);
  assert.ok(cache.get("c.xml"));
});

test("IndexRecordsCache stores and invalidates entries", () => {
  const cache = new IndexRecordsCache();
  const entry = {
    stat: { mtimeMs: 1, size: 1 },
    records: { assets: [], defines: [], includes: [], rootXiIncludes: [], nestedXiIncludes: [] },
    kind: "full",
  };
  cache.set("a.xml", entry);
  assert.equal(cache.get("a.xml"), entry);
  cache.invalidate("a.xml");
  assert.equal(cache.get("a.xml"), undefined);
});

test("IncludeResolveCache stores sources and manifest lookups", () => {
  const cache = new IncludeResolveCache();
  const key = "dir|DATA:static.xml";
  const result = { path: "C:/sdk/static.xml", prefix: "DATA", raw: "DATA:static.xml" };
  assert.equal(cache.get(key), undefined);
  cache.set(key, result);
  assert.equal(cache.get(key), result);
  assert.equal(cache.getManifest("static.xml"), undefined);
  cache.setManifest("static.xml", "C:/sdk/builtmods/static.manifest");
  assert.equal(cache.getManifest("static.xml"), "C:/sdk/builtmods/static.manifest");
  cache.clear();
  assert.equal(cache.get(key), undefined);
  assert.equal(cache.getManifest("static.xml"), undefined);
});
