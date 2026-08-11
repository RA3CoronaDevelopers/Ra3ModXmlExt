import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { ModIndexer } from "../out/indexer/indexer.js";
import { CachedDirectoryWalker } from "../out/indexer/fileScanner.js";
import {
  IndexRecordsCache,
  contentHash,
  normKey,
  recordsHash,
} from "../out/indexer/caches.js";
import {
  assetDefKey,
  buildReferenceIndex,
  documentRecordsDesynced,
  referenceSitesForDef,
  referenceSitesForDefinition,
  scheduleRebuildIfRecordsDesync,
  unreferencedByType,
} from "../out/indexer/referenceIndex.js";
import { LineMap, parseXml } from "../out/language/xmlParser.js";
import { extractIndexRecords } from "../out/indexer/records.js";

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

function makeDef(type, id, file, line, extra = {}) {
  return {
    type,
    id,
    file,
    line,
    origin: "project",
    ...extra,
  };
}

test("buildReferenceIndex resolves records with strict type filtering", () => {
  const tank = makeDef("GameObject", "Tank", "C:/mod/A.xml", 2);
  const gun = makeDef("WeaponTemplate", "Tank", "C:/mod/B.xml", 1);
  const cs = makeDef("LogicCommandSet", "CS", "C:/mod/C.xml", 4);
  const lookup = {
    assets: new Map(),
    assetsById: new Map([
      ["tank", [tank, gun]],
      ["cs", [cs]],
    ]),
  };
  const recordsA = {
    assets: [],
    defines: [],
    includes: [],
    rootXiIncludes: [],
    nestedXiIncludes: [],
    references: [
      {
        kind: "content",
        refType: "GameObject",
        selfType: null,
        value: "Tank",
        line: 5,
        start: 40,
        end: 44,
      },
    ],
  };
  const recordsB = {
    assets: [],
    defines: [],
    includes: [],
    rootXiIncludes: [],
    nestedXiIncludes: [],
    references: [
      {
        kind: "attr",
        refType: "LogicCommandSet",
        selfType: null,
        value: "CS",
        line: 3,
        start: 10,
        end: 12,
      },
    ],
  };

  const map = buildReferenceIndex(
    [
      { file: "C:/mod/A.xml", records: recordsA },
      { file: "C:/mod/B.xml", records: recordsB },
    ],
    lookup,
  );

  // The content reference resolves only to the GameObject definition, never
  // to the same-name WeaponTemplate.
  const tankSites = map.get(assetDefKey(tank));
  assert.equal(tankSites.length, 1);
  assert.equal(tankSites[0].file, "C:/mod/A.xml");
  assert.equal(tankSites[0].kind, "content");
  assert.equal(map.get(assetDefKey(gun)), undefined);
  assert.equal(map.get(assetDefKey(cs)).length, 1);
});

test("records extracted from XML resolve through the reference index", () => {
  const text = `<AssetDeclaration>
  <GameObject id="Tank" CommandSet="CS"/>
  <LogicCommandSet id="CS"/>
  <ObjectCreationList id="OCL">
    <CreateObject>
      <CreateObject>Tank</CreateObject>
    </CreateObject>
  </ObjectCreationList>
</AssetDeclaration>`;
  const lineMap = new LineMap(text);
  const records = extractIndexRecords(parseXml(text), lineMap, text);
  const file = "C:/mod/D.xml";
  const tank = makeDef("GameObject", "Tank", file, 2);
  const cs = makeDef("LogicCommandSet", "CS", file, 3);
  const lookup = {
    assets: new Map(),
    assetsById: new Map([
      ["tank", [tank]],
      ["cs", [cs]],
    ]),
  };
  const map = buildReferenceIndex([{ file, records }], lookup);

  const tankSites = map.get(assetDefKey(tank));
  assert.equal(tankSites.length, 1);
  assert.equal(tankSites[0].kind, "content");
  assert.equal(records.references.find((r) => r.value === "Tank").start, tankSites[0].start);

  const csSites = map.get(assetDefKey(cs));
  assert.equal(csSites.length, 1);
  assert.equal(csSites[0].kind, "attr");
});

test("referenceSitesForDefinition unions manifest-source sites onto the SageXml source file", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ra3-refindex-"));
  try {
    const sdkDir = join(tmp, "sdk");
    const projectDir = join(tmp, "project");
    const sourceFile = join(sdkDir, "SageXml", "Includes", "Units.xml");
    const shadowFile = join(projectDir, "Data", "Includes", "Units.xml");
    mkdirSync(dirname(sourceFile), { recursive: true });
    mkdirSync(dirname(shadowFile), { recursive: true });
    writeFileSync(sourceFile, "<AssetDeclaration/>", "utf8");
    writeFileSync(shadowFile, "<AssetDeclaration/>", "utf8");

    const manifestDef = {
      type: "GameObject",
      id: "Tank",
      file: join(sdkDir, "builtmods", "static.manifest"),
      line: 0,
      origin: "manifest",
      manifestSource: "DATA:Includes/Units.xml",
    };
    const site = {
      file: "C:/mod/ref.xml",
      line: 3,
      start: 10,
      end: 14,
      kind: "attr",
    };
    const idx = {
      assets: new Map([["GameObject", new Map([["tank", [manifestDef]]])]]),
      assetsById: new Map([["tank", [manifestDef]]]),
      references: new Map([[assetDefKey(manifestDef), [site]]]),
      projectDir,
      sdkDir,
    };

    const sites = referenceSitesForDefinition(idx, {
      type: "GameObject",
      id: "Tank",
      file: sourceFile,
      line: 4,
    });
    assert.equal(sites.length, 1);
    assert.equal(sites[0].file, "C:/mod/ref.xml");

    // The mod file shadowing the same DATA: path must NOT inherit the
    // manifest definition's sites; manifestSource maps to SageXml only.
    const other = referenceSitesForDefinition(idx, {
      type: "GameObject",
      id: "Tank",
      file: shadowFile,
      line: 4,
    });
    assert.equal(other.length, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("the minimod indexer publishes a semantic reverse reference index", async () => {
  const idx = await buildIndex();
  assert.ok(idx.stats.referenceCount > 0, "reverse index is populated");

  // Units.xml has CommandSet="TestTankCommandSet" and inheritFrom="BaseVehicle".
  const lcs = idx.assets.get("LogicCommandSet").get("testtankcommandset")[0];
  const lcsSites = idx.references.get(assetDefKey(lcs));
  assert.ok(lcsSites && lcsSites.length >= 1);
  assert.ok(lcsSites.some((s) => s.kind === "attr"));

  const baseVehicle = idx.assets.get("GameObject").get("basevehicle")[0];
  const bvSites = idx.references.get(assetDefKey(baseVehicle));
  assert.ok(bvSites && bvSites.length >= 1);
});

test("references survive a records-cache invalidation during the build", async () => {
  const recordsCache = new IndexRecordsCache();
  const indexer = new ModIndexer({
    projectDir: project,
    sdkDir: sdk,
    builtmodsDirs: [join(sdk, "builtmods")],
    indexSageXml: true,
    additionalDataSearchPaths: [],
    walker: new CachedDirectoryWalker(),
    recordsCache,
  });
  const unitsPath = join(project, "Data", "Includes", "Units.xml");
  const idx = await indexer.build((phaseIndex) => {
    if (!phaseIndex.complete) recordsCache.invalidate(unitsPath);
  });
  const lcs = idx.assets.get("LogicCommandSet").get("testtankcommandset")[0];
  const sites = idx.references.get(assetDefKey(lcs));
  assert.ok(
    sites && sites.length >= 1,
    "final snapshot keeps the walk-time reference records",
  );
});

test("force rebuild verifies content even when every stat signal matches", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "ra3-refidx-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const file = join(tmp, "units.xml");
  const diskText = `<AssetDeclaration><GameObject id="Tank"/></AssetDeclaration>`;
  const cachedText = `<AssetDeclaration><GameObject id="Cached"/></AssetDeclaration>`;
  writeFileSync(file, diskText);
  const st = statSync(file);
  const stamp = {
    mtimeMs: st.mtimeMs,
    size: st.size,
    birthtimeMs: st.birthtimeMs,
    ctimeMs: st.ctimeMs,
  };
  const cache = new IndexRecordsCache();
  cache.set(file, {
    stat: stamp,
    records: extractIndexRecords(
      parseXml(cachedText),
      new LineMap(cachedText),
      cachedText,
    ),
    kind: "full",
    contentHash: contentHash(cachedText),
  });
  const opts = {
    projectDir: tmp,
    sdkDir: tmp,
    builtmodsDirs: [],
    indexSageXml: false,
    additionalDataSearchPaths: [],
    walker: new CachedDirectoryWalker(),
    recordsCache: cache,
  };

  const trusted = new ModIndexer({ ...opts, trustUnchanged: true });
  const trustedParsed = await trusted.readDocument(file);
  assert.equal(
    trustedParsed.records.assets[0].id,
    "Cached",
    "trusted rebuilds reuse the cached records without reading",
  );

  const forced = new ModIndexer({ ...opts, trustUnchanged: false });
  const forcedParsed = await forced.readDocument(file);
  assert.equal(
    forcedParsed.records.assets[0].id,
    "Tank",
    "force rebuild re-reads a stat-matching but content-stale entry",
  );
  assert.equal(cache.get(file).contentHash, contentHash(diskText));
});

test("records-desync self-heal schedules a targeted rebuild only for clean files", () => {
  const file = join(project, "Data", "Includes", "Units.xml");
  const emptyRecords = extractIndexRecords(
    parseXml("<AssetDeclaration/>"),
    new LineMap("<AssetDeclaration/>"),
    "<AssetDeclaration/>",
  );
  const idx = {
    recordsHashes: new Map([[normKey(file), recordsHash(emptyRecords)]]),
    references: new Map(),
    assets: new Map(),
    sdkDir: sdk,
    projectDir: project,
  };
  assert.equal(
    documentRecordsDesynced(idx, file, "<AssetDeclaration/>"),
    false,
  );
  assert.equal(
    documentRecordsDesynced(
      idx,
      file,
      "<AssetDeclaration><GameObject id=\"Tank\"/></AssetDeclaration>",
    ),
    true,
  );

  let invalidated = null;
  let scheduled = null;
  const ws = {
    index: idx,
    invalidate: (p) => {
      invalidated = p;
    },
    scheduleRebuild: (r) => {
      scheduled = r;
    },
  };
  assert.equal(
    scheduleRebuildIfRecordsDesync(ws, {
      uri: { fsPath: file, scheme: "file" },
      isDirty: false,
      getText: () => "<AssetDeclaration><GameObject id=\"Tank\"/></AssetDeclaration>",
    }),
    true,
  );
  assert.equal(invalidated, file);
  assert.equal(scheduled, "records-desync");

  invalidated = null;
  scheduled = null;
  assert.equal(
    scheduleRebuildIfRecordsDesync(ws, {
      uri: { fsPath: file, scheme: "file" },
      isDirty: true,
      getText: () => "<AssetDeclaration><GameObject id=\"Tank\"/></AssetDeclaration>",
    }),
    false,
  );
  assert.equal(scheduled, null);
});

test("unreferencedByType reports only meaningful project assets", async () => {
  const idx = await buildIndex();
  const map = unreferencedByType(idx);
  const all = [...map.values()].flat();

  assert.ok(all.length > 0, "some project assets are unreferenced");
  assert.ok(
    all.every((d) => d.origin === "project" && !d.viaInstance),
    "only compiled-stream project definitions are reported",
  );
  assert.ok(
    all.every((d) => !d.file.toLowerCase().includes("fakesdk")),
    "SDK/manifest definitions are never reported",
  );

  // WeaponTemplate TestTankCannon is defined but never referenced.
  const weapons = map.get("WeaponTemplate");
  assert.ok(weapons.some((d) => d.id === "TestTankCannon"));

  // LogicCommandSet TestTankCommandSet is referenced, so it must not appear.
  const commandSets = map.get("LogicCommandSet");
  assert.ok(!commandSets?.some((d) => d.id === "TestTankCommandSet"));

  // referenceSitesForDef is stable across lookups and safe without a map.
  const tankCannon = idx.assets.get("WeaponTemplate").get("testtankcannon")[0];
  assert.deepEqual(referenceSitesForDef(idx, tankCannon), []);
  assert.deepEqual(referenceSitesForDef(null, tankCannon), []);
});
