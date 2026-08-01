import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ModIndexer } from "../out/indexer/indexer.js";
import { CachedDirectoryWalker } from "../out/indexer/fileScanner.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const project = join(root, "test", "fixtures", "minimod");
const sdk = join(root, "test", "fixtures", "fakesdk");

async function buildIndex() {
  const indexer = new ModIndexer({
    projectDir: project,
    sdkDir: sdk,
    builtmodsDirs: [join(sdk, "builtmods")],
    indexSageXml: true,
    additionalDataSearchPaths: [],
    walker: new CachedDirectoryWalker(),
  });
  return indexer.build();
}

test("indexes assets, defines, streams and include errors", async () => {
  const idx = await buildIndex();

  assert.equal(idx.stats.streams, 2); // static + global
  assert.ok(idx.assetsById.has("testtank"));
  assert.ok(idx.assetsById.has("testtankcannon"));
  assert.ok(idx.assetsById.has("testtankcommandset"));
  assert.ok(idx.assetsById.has("testtexture"));
  assert.ok(idx.assetsById.has("thempgamerules"));
  assert.ok(idx.assetsById.has("vanillatank"), "vanilla data via reference include fallback");
  assert.ok(idx.assetsById.has("basevehicle"));

  const baseVehicle = idx.assetsById.get("basevehicle");
  assert.ok(baseVehicle.some((d) => d.viaInstance), "instance-included asset marked");

  const defs = idx.defines.get("test_health");
  assert.equal(defs?.[0].value, "100.0");

  const missing = idx.diagnostics.find((d) => d.code === "include-not-found");
  assert.ok(missing, "missing include reported");
  assert.match(missing.message, /Missing\/File\.xml/);

  // Nested xi:include: existing target is walked, missing target is reported.
  assert.ok(
    idx.diagnostics.some((d) => /Missing\/Nested\.xml/.test(d.message)),
    "nested missing xi:include reported",
  );
  assert.ok(
    idx.files.has(
      join(project, "Data", "Includes", "Fragment.xml").toLowerCase(),
    ),
    "nested xi:include target indexed",
  );
  assert.ok(
    idx.assetsById.has("fraglight"),
    "nested xi:include target assets available",
  );

  const staticStream = idx.streams.find((s) => s.name === "static");
  assert.ok(staticStream.files.size >= 4);
});

test("provides include source candidates", async () => {
  const idx = await buildIndex();
  const xml = idx.sourceCandidates.filter((c) => c.source.endsWith(".xml"));
  assert.ok(xml.length >= 4);
  assert.ok(xml.some((c) => c.source === "Includes/Units.xml"));
  assert.ok(xml.some((c) => c.source === "DATA:static.xml"));
});
