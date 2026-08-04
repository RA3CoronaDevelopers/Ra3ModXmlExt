import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import fs from "node:fs";
import os from "node:os";
import { ModIndexer } from "../out/indexer/indexer.js";
import { CachedDirectoryWalker } from "../out/indexer/fileScanner.js";
import {
  DocumentCache,
  IncludeResolveCache,
  IndexRecordsCache,
} from "../out/indexer/caches.js";
import { resolveReferenceTargetsForType } from "../out/indexer/refs.js";

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

test("indexes art-asset XML (.w3x / sniffed unknown extension) via shallow scan and skips binary", async () => {
  const idx = await buildIndex();

  // The .w3x hub chain: Mod.xml -> VehicleArt.xml -> Models/Tank_SKN.w3x.
  const skn = idx.assetsById.get("tank_skn");
  assert.ok(skn?.some((d) => d.type === "W3DContainer"), "W3DContainer from .w3x indexed");
  assert.ok(
    idx.assetsById.get("tank_skl")?.some((d) => d.type === "W3DHierarchy"),
    "W3DHierarchy from .w3x indexed",
  );
  const container = skn.find((d) => d.type === "W3DContainer");
  assert.match(container.file, /Tank_SKN\.w3x$/);
  assert.ok(container.line > 0, "definition line recorded from shallow scan");

  // Unknown extension with XML content is sniffed and indexed.
  assert.ok(
    idx.assetsById.get("tank_fp")?.some((d) => d.type === "W3DMesh"),
    "unknown-extension XML (.dat) sniffed and indexed",
  );

  // Binary content is registered as a file but never parsed.
  assert.equal(idx.assetsById.get("tank_damaged"), undefined, "binary asset never indexed");
  assert.ok(
    idx.files.has(
      join(project, "Data", "Includes", "Models", "Tank_Damaged.dds").toLowerCase(),
    ),
    "binary include target registered as a file",
  );

  // The reported Harbinger scenario: <Model Name="Tank_SKN"/> (refType
  // BaseRenderAssetType) must resolve to the W3DContainer defined in the w3x.
  const targets = resolveReferenceTargetsForType(
    idx,
    "ScriptedModelDrawModel",
    "Name",
    "Tank_SKN",
  );
  assert.equal(targets.length, 1);
  assert.equal(targets[0].def.type, "W3DContainer");
  assert.match(targets[0].def.file, /Tank_SKN\.w3x$/);
});

test("w3x files appear in Include source completion candidates", async () => {
  const idx = await buildIndex();
  assert.ok(
    idx.sourceCandidates.some((c) => c.source === "Includes/Models/Tank_SKN.w3x"),
    "project-relative w3x candidate",
  );
  assert.ok(
    idx.sourceCandidates.some((c) => c.source === "DATA:Includes/Models/Tank_SKN.w3x"),
    "DATA: w3x candidate",
  );
});

test("build publishes an immutable XML phase before art scanning", async () => {
  let phaseA;
  const indexer = new ModIndexer({
    projectDir: project,
    sdkDir: sdk,
    builtmodsDirs: [join(sdk, "builtmods")],
    indexSageXml: true,
    additionalDataSearchPaths: [],
    walker: new CachedDirectoryWalker(),
  });
  const idx = await indexer.build((p) => {
    phaseA = p;
  });

  assert.ok(phaseA, "phase-A snapshot published");
  assert.equal(phaseA.complete, false);
  assert.equal(phaseA.phase, "xml");
  assert.ok(phaseA.assetsById.has("testtank"), "XML assets available in phase A");
  assert.ok(
    phaseA.assetsById.has("vanillatank"),
    "manifest assets available in phase A",
  );
  assert.equal(
    phaseA.assetsById.has("tank_skn"),
    false,
    "art assets deferred in phase A",
  );
  assert.ok(phaseA.stats.deferredArtFiles >= 2, "deferred art queue recorded");
  assert.equal(phaseA.stats.shallowScannedFiles, 0, "no art scanned during phase A");

  assert.equal(idx.complete, true);
  assert.equal(idx.phase, "art");
  assert.ok(idx.assetsById.has("tank_skn"), "art assets present in the final index");
  assert.equal(
    phaseA.assetsById.has("tank_skn"),
    false,
    "phase-A snapshot is immutable (phase B did not mutate it)",
  );
  assert.equal(typeof idx.stats.artScanMs, "number");
  assert.equal(
    indexer.isIndexedFile(join(project, "Data", "Mod.xml")),
    true,
    "indexed files are recognized",
  );
  assert.equal(
    indexer.isIndexedFile(join(project, "Data", "NotIndexed.xml")),
    false,
    "unrelated files are not recognized",
  );
});

test("stat validation re-reads a file whose mtime changed", async (t) => {
  const tmp = fs.mkdtempSync(join(os.tmpdir(), "ra3modxml-mtime-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const projectDir = join(tmp, "project");
  fs.mkdirSync(join(projectDir, "Data"), { recursive: true });
  const modPath = join(projectDir, "Data", "Mod.xml");
  fs.writeFileSync(
    modPath,
    `<?xml version="1.0"?>\n<AssetDeclaration>\n  <GameObject id="TankA"/>\n</AssetDeclaration>\n`,
    "utf8",
  );

  const documentCache = new DocumentCache();
  const recordsCache = new IndexRecordsCache();
  const resolveCache = new IncludeResolveCache();
  const make = () =>
    new ModIndexer({
      projectDir,
      sdkDir: sdk,
      builtmodsDirs: [join(sdk, "builtmods")],
      indexSageXml: false,
      additionalDataSearchPaths: [],
      walker: new CachedDirectoryWalker(),
      documentCache,
      recordsCache,
      resolveCache,
      trustUnchanged: false,
    });

  const first = await make().build();
  assert.ok(first.assetsById.has("tanka"));
  assert.equal(first.stats.recordsCacheHits, 0);

  const past = new Date(Date.now() - 60000);
  fs.utimesSync(modPath, past, past);
  const second = await make().build();
  assert.equal(
    second.stats.recordsCacheHits,
    0,
    "mtime change invalidates the cached records",
  );
  assert.ok(second.assetsById.has("tanka"));

  const third = await make().build();
  assert.ok(
    third.stats.recordsCacheHits > 0,
    "unchanged files are served from the records cache",
  );
});

test("shallow scans and full parses are cached across rebuilds", async () => {
  const documentCache = new DocumentCache();
  const recordsCache = new IndexRecordsCache();
  const resolveCache = new IncludeResolveCache();
  const makeIndexer = () =>
    new ModIndexer({
      projectDir: project,
      sdkDir: sdk,
      builtmodsDirs: [join(sdk, "builtmods")],
      indexSageXml: true,
      additionalDataSearchPaths: [],
      walker: new CachedDirectoryWalker(),
      documentCache,
      recordsCache,
      resolveCache,
    });

  const first = await makeIndexer().build();
  const second = await makeIndexer().build();

  assert.equal(first.stats.shallowScannedFiles, 2, "w3x + sniffed w3d scanned on first build");
  assert.equal(second.stats.shallowScannedFiles, 0, "unchanged art assets are not re-scanned");
  assert.equal(second.stats.shallowCacheHits, 2);
  assert.ok(second.stats.recordsCacheHits > 0, "XML records served from cache");
  assert.ok(second.stats.resolveCacheHits > 0, "include resolutions served from cache");
  assert.equal(second.stats.resolveCalls, 0, "no include re-resolved on a trusted rebuild");
  assert.equal(second.stats.assetCount, first.stats.assetCount);
  assert.equal(second.stats.indexedFiles, first.stats.indexedFiles);
});

test("trusted rebuilds skip unchanged files; invalidation forces re-reads", async () => {
  const documentCache = new DocumentCache();
  const recordsCache = new IndexRecordsCache();
  const resolveCache = new IncludeResolveCache();
  const opts = () => ({
    projectDir: project,
    sdkDir: sdk,
    builtmodsDirs: [join(sdk, "builtmods")],
    indexSageXml: true,
    additionalDataSearchPaths: [],
    walker: new CachedDirectoryWalker(),
    documentCache,
    recordsCache,
    resolveCache,
  });

  // Trusted rebuild: cached files are reused without any per-file stat/read.
  const first = await new ModIndexer({ ...opts(), trustUnchanged: true }).build();
  assert.equal(first.stats.shallowScannedFiles, 2);
  const second = await new ModIndexer({ ...opts(), trustUnchanged: true }).build();
  assert.equal(second.stats.shallowScannedFiles, 0);
  assert.equal(second.stats.shallowCacheHits, 2);
  assert.ok(second.stats.recordsCacheHits > 0);

  // Simulate the file watcher / save handler: invalidate one art asset.
  // The next trusted rebuild must re-scan exactly that file.
  recordsCache.invalidate(join(project, "Data", "Includes", "Models", "Tank_SKN.w3x"));
  const third = await new ModIndexer({ ...opts(), trustUnchanged: true }).build();
  assert.equal(third.stats.shallowScannedFiles, 1);
  assert.equal(third.stats.shallowCacheHits, 1);
  assert.ok(
    third.assetsById.get("tank_skn")?.some((d) => d.type === "W3DContainer"),
    "re-scanned w3x asset present",
  );

  // Invalidate one XML file: exactly its records are re-extracted.
  recordsCache.invalidate(join(project, "Data", "Includes", "Units.xml"));
  const fourth = await new ModIndexer({ ...opts(), trustUnchanged: true }).build();
  assert.equal(fourth.stats.recordsCacheHits, third.stats.recordsCacheHits - 1);
  assert.ok(
    fourth.assetsById.get("testtank")?.some((d) => d.type === "GameObject"),
    "re-parsed XML asset present",
  );

  // A forced rebuild (ra3modxml.reindex) verifies stats but still reuses
  // content caches for unchanged files.
  const forced = await new ModIndexer({ ...opts(), trustUnchanged: false }).build();
  assert.equal(forced.stats.shallowScannedFiles, 0);
  assert.equal(forced.stats.shallowCacheHits, 2);
});

test("index stats include candidate/walk phase timings", async () => {
  const idx = await buildIndex();
  assert.equal(typeof idx.stats.candidatesMs, "number");
  assert.equal(typeof idx.stats.walkMs, "number");
  assert.ok(idx.stats.snapshotHits > 0, "existence snapshot answered lookups");
  assert.equal(typeof idx.stats.snapshotFallbacks, "number");
});

test("w3x with a UTF-8 BOM is indexed with correct offsets", async (t) => {
  const tmp = fs.mkdtempSync(join(os.tmpdir(), "ra3modxml-bom-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const projectDir = join(tmp, "project");
  fs.mkdirSync(join(projectDir, "Data", "Models"), { recursive: true });
  fs.writeFileSync(
    join(projectDir, "Data", "Mod.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<AssetDeclaration>
  <Includes>
    <Include type="all" source="Models/Tank_BOM.w3x"/>
  </Includes>
</AssetDeclaration>`,
    "utf8",
  );
  fs.writeFileSync(
    join(projectDir, "Data", "Models", "Tank_BOM.w3x"),
    "\uFEFF<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
      "<AssetDeclaration>\n" +
      "  <W3DContainer id=\"Tank_BOM\" />\n" +
      "</AssetDeclaration>\n",
    "utf8",
  );

  const idx = await new ModIndexer({
    projectDir,
    sdkDir: sdk,
    builtmodsDirs: [join(sdk, "builtmods")],
    indexSageXml: false,
    additionalDataSearchPaths: [],
    walker: new CachedDirectoryWalker(),
  }).build();

  const def = idx.assetsById.get("tank_bom")?.find((d) => d.type === "W3DContainer");
  assert.ok(def, "BOM-prefixed w3x asset indexed");
  assert.equal(def.line, 3, "id line is correct despite the BOM");
});
