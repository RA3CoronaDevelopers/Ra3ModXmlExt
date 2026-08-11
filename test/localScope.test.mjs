import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseXml, LineMap, stripBom } from "../out/language/xmlParser.js";
import { extractIndexRecords } from "../out/indexer/records.js";
import { buildSearchPaths } from "../out/indexer/includeResolver.js";
import {
  buildDocumentScope,
  withLocalOverlay,
} from "../out/indexer/localScope.js";
import {
  findContainingGameObject,
  findLocalId,
  collectLocalIds,
} from "../out/indexer/logicalTree.js";
import { resolveReferenceTargetsForType } from "../out/indexer/refs.js";
import { resolveElementType } from "../out/language/typeContext.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const project = join(root, "test", "fixtures", "minimod");
const sdk = join(root, "test", "fixtures", "fakesdk");
const standalonePath = join(project, "Data", "Standalone.xml");

async function readParsed(path) {
  const text = stripBom(await readFile(path, "utf8"));
  const lineMap = new LineMap(text);
  const parse = parseXml(text);
  return {
    file: { path, stat: null },
    parse,
    records: extractIndexRecords(parse, lineMap, text),
    lineMap,
  };
}

async function makeScope() {
  const searchPaths = buildSearchPaths(sdk, project);
  const text = await readFile(standalonePath, "utf8");
  return buildDocumentScope(standalonePath, text, 1, {
    projectDir: project,
    sdkDir: sdk,
    searchPaths,
    readRecords: readParsed,
    readDom: readParsed,
  });
}

test("local overlay resolves refs for a file outside every global stream", async () => {
  const scope = await makeScope();
  const merged = withLocalOverlay(null, scope.overlay, project, sdk);

  assert.ok(merged.local.assetsById.has("standalonetank"));
  assert.ok(merged.local.assetsById.has("standalonebase"));
  assert.ok(merged.local.defines.has("standalone_health"));

  const targets = resolveReferenceTargetsForType(
    merged,
    "GameObject",
    "inheritFrom",
    "StandaloneBase",
  );
  assert.equal(targets.length, 1);
  assert.match(targets[0].def.file, /StandaloneBase\.xml$/);
  assert.equal(targets[0].def.origin, "project");
});

test("logical xi:include expansion gives included modules their Draws context", async () => {
  const scope = await makeScope();
  const included = scope.expanded.elements.find(
    (e) =>
      e.name === "TruckDraw" &&
      e.attrs.some((a) => a.name === "id" && a.value === "ModuleTag_Headlight"),
  );
  assert.ok(included, "xi:include target spliced into the logical tree");
  assert.match(included.sourceFile, /HeadlightModules\.xml$/i);
  assert.equal(
    resolveElementType(included),
    "W3DTruckDrawModuleData",
    "included module resolves through the logical Draws parent",
  );

  const update = scope.expanded.elements.find(
    (e) => e.name === "ReconstituteStateSpecialAbility",
  );
  assert.ok(update);
  const gameObject = findContainingGameObject(update);
  assert.equal(gameObject?.name, "GameObject");
  assert.equal(
    findLocalId(gameObject, "ModuleTag_Headlight"),
    included,
    "Poid reference can reach a module spliced in through xi:include",
  );

  const localIds = collectLocalIds(gameObject).map((i) => i.id);
  assert.ok(localIds.includes("ModuleTag_Draw"));
  assert.ok(localIds.includes("ModuleTag_Headlight"));
});

test("xi:include without xpointer splices the target root element itself", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "ra3-local-noxpointer-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dataDir = join(tmp, "Data");
  const includesDir = join(dataDir, "Includes");
  await mkdir(includesDir, { recursive: true });
  const mainPath = join(dataDir, "Main.xml");
  const fragmentPath = join(includesDir, "Fragment.xml");
  await writeFile(
    fragmentPath,
    '<CreateObjectDie xmlns="uri:ea.com:eala:asset" id="ModuleTag_X" CreationList="OCL_X"><DieMuxData DeathTypes="SUICIDED"/></CreateObjectDie>',
    "utf8",
  );
  await writeFile(
    mainPath,
    '<AssetDeclaration xmlns="uri:ea.com:eala:asset" xmlns:xi="http://www.w3.org/2001/XInclude">' +
      '<GameObject id="G"><Behaviors><xi:include href="DATA:Includes/Fragment.xml"/></Behaviors></GameObject>' +
      "</AssetDeclaration>",
    "utf8",
  );
  const searchPaths = buildSearchPaths(sdk, tmp);
  const text = await readFile(mainPath, "utf8");
  const scope = await buildDocumentScope(mainPath, text, 1, {
    projectDir: tmp,
    sdkDir: sdk,
    searchPaths,
    readRecords: readParsed,
    readDom: readParsed,
  });
  const behaviors = scope.expanded.elements.find((e) => e.name === "Behaviors");
  assert.ok(behaviors, "Behaviors exists");
  assert.equal(behaviors.children.length, 1);
  const module = behaviors.children[0];
  assert.equal(module.name, "CreateObjectDie");
  assert.equal(
    module.attrs.find((a) => a.name === "id")?.value,
    "ModuleTag_X",
  );
  assert.match(module.sourceFile, /Fragment\.xml$/i);
  const dieMux = scope.expanded.elements.find((e) => e.name === "DieMuxData");
  assert.ok(dieMux, "DieMuxData is expanded");
  assert.equal(
    dieMux.parent,
    module,
    "DieMuxData stays inside the included CreateObjectDie module",
  );
});

test("local overlay wins over a global definition with the same id", async () => {
  const scope = await makeScope();
  const global = {
    assets: new Map(),
    assetsById: new Map([
      [
        "standalonebase",
        [
          {
            type: "GameObject",
            id: "StandaloneBase",
            file: join(sdk, "SageXml", "VanillaBase.xml"),
            line: 1,
            origin: "sdk",
          },
        ],
      ],
    ]),
    defines: new Map(),
  };
  const merged = withLocalOverlay(global, scope.overlay, project, sdk);
  const targets = resolveReferenceTargetsForType(
    merged,
    "GameObject",
    "inheritFrom",
    "StandaloneBase",
  );
  assert.equal(targets.length, 2);
  assert.match(targets[0].def.file, /StandaloneBase\.xml$/);
  assert.equal(targets[0].def.origin, "project");
  assert.match(targets[1].def.file, /VanillaBase\.xml$/);
});

test("logical expansion terminates on xi:include cycles", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "ra3-local-cycle-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dataDir = join(tmp, "Data");
  const includesDir = join(dataDir, "Includes");
  await mkdir(includesDir, { recursive: true });
  const aPath = join(dataDir, "A.xml");
  const bPath = join(includesDir, "B.xml");
  await writeFile(
    aPath,
    `<AssetDeclaration><GameObject id="A"><xi:include href="Includes/B.xml"/></GameObject></AssetDeclaration>`,
    "utf8",
  );
  await writeFile(
    bPath,
    `<AssetDeclaration><GameObject id="B"><xi:include href="../A.xml"/></GameObject></AssetDeclaration>`,
    "utf8",
  );
  const searchPaths = buildSearchPaths(sdk, tmp);
  const text = await readFile(aPath, "utf8");
  const scope = await buildDocumentScope(aPath, text, 1, {
    projectDir: tmp,
    sdkDir: sdk,
    searchPaths,
    readRecords: readParsed,
    readDom: readParsed,
  });
  assert.ok(
    scope.expanded.elements.some(
      (e) =>
        e.name === "GameObject" &&
        e.attrs.some((a) => a.name === "id" && a.value === "A"),
    ),
    "entry document survives a cycle",
  );
});

test("the same xi:include target can expand under multiple parents", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "ra3-local-shared-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dataDir = join(tmp, "Data");
  const includesDir = join(dataDir, "Includes");
  await mkdir(includesDir, { recursive: true });
  const mainPath = join(dataDir, "Main.xml");
  const fragmentPath = join(includesDir, "Fragment.xml");
  await writeFile(
    fragmentPath,
    `<AssetDeclaration><HeadlightDraw2><TruckDraw id="ModuleTag_Shared"/></HeadlightDraw2></AssetDeclaration>`,
    "utf8",
  );
  await writeFile(
    mainPath,
    `<AssetDeclaration>` +
      `<GameObject id="A"><Draws><xi:include href="DATA:Includes/Fragment.xml" ` +
      `xpointer="xmlns(n=uri:ea.com:eala:asset) xpointer(/n:HeadlightDraw2/child::*)"/></Draws></GameObject>` +
      `<GameObject id="B"><Draws><xi:include href="DATA:Includes/Fragment.xml" ` +
      `xpointer="xmlns(n=uri:ea.com:eala:asset) xpointer(/n:HeadlightDraw2/child::*)"/></Draws></GameObject>` +
      `</AssetDeclaration>`,
    "utf8",
  );
  const searchPaths = buildSearchPaths(sdk, tmp);
  const text = await readFile(mainPath, "utf8");
  const scope = await buildDocumentScope(mainPath, text, 1, {
    projectDir: tmp,
    sdkDir: sdk,
    searchPaths,
    readRecords: readParsed,
    readDom: readParsed,
  });
  const shared = scope.expanded.elements.filter(
    (e) =>
      e.name === "TruckDraw" &&
      e.attrs.some((a) => a.name === "id" && a.value === "ModuleTag_Shared"),
  );
  assert.equal(shared.length, 2, "same fragment expands once per parent");
});
