import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// Minimal vscode shim: the CodeLens provider only constructs CodeLens/Range.
class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}
class CodeLens {
  constructor(range, command) {
    this.range = range;
    this.command = command;
  }
}

const require = createRequire(import.meta.url);
const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "vscode") return "vscode-stub";
  return origResolve.call(this, request, ...args);
};
require.cache["vscode-stub"] = {
  id: "vscode-stub",
  filename: "vscode-stub",
  loaded: true,
  exports: {
    Range,
    CodeLens,
  },
};

const { Ra3CodeLensProvider } = require("../out/features/codeLens.js");
const { assetDefKey } = require("../out/indexer/referenceIndex.js");
const { normKey } = require("../out/indexer/caches.js");

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PROJECT = join(root, "test", "fixtures", "minimod");
const SDK = join(root, "test", "fixtures", "fakesdk");
// A real file whose path matches what DATA:Includes/Units.xml resolves to.
const FILE = resolve(join(PROJECT, "Data", "Includes", "Units.xml"));
const TEXT = `<AssetDeclaration>
  <GameObject id="TestTank"/>
  <GameObject id="BaseVehicle"/>
  <CameraSettings id="S"/>
</AssetDeclaration>`;

function makeDocument(text = TEXT) {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  return {
    uri: { fsPath: FILE },
    getText: () => text,
    positionAt: (offset) => {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= offset) lo = mid;
        else hi = mid - 1;
      }
      return { line: lo, character: offset - lineStarts[lo] };
    },
  };
}

function makeIndex() {
  const tankSite = {
    file: "C:/mod/Data/Other.xml",
    line: 7,
    start: 40,
    end: 48,
    kind: "content",
  };
  const secondSite = {
    file: "C:/mod/Data/Third.xml",
    line: 2,
    start: 12,
    end: 20,
    kind: "attr",
  };
  const references = new Map();
  references.set(
    assetDefKey({
      type: "GameObject",
      id: "TestTank",
      file: FILE,
      line: 2,
    }),
    [tankSite, secondSite],
  );
  references.set(
    assetDefKey({
      type: "GameObject",
      id: "BaseVehicle",
      file: FILE,
      line: 3,
    }),
    [],
  );
  return {
    references,
    assets: new Map(),
    sdkDir: SDK,
    projectDir: PROJECT,
  };
}

test("CodeLens shows counts on reference-target types only, including zero", () => {
  const provider = new Ra3CodeLensProvider({
    isRa3Workspace: () => true,
    index: makeIndex(),
  });
  const lenses = provider.provideCodeLenses(makeDocument(), {});

  assert.equal(lenses.length, 2, "no lens for auto-registered CameraSettings");
  const tank = lenses.find((l) => l.command.arguments[0].id === "TestTank");
  const base = lenses.find((l) => l.command.arguments[0].id === "BaseVehicle");

  assert.ok(tank, "GameObject TestTank gets a lens");
  assert.equal(tank.command.title, "2 references");
  assert.equal(tank.command.command, "ra3modxml.showReferences");
  assert.equal(tank.command.arguments[0].type, "GameObject");
  assert.equal(tank.command.arguments[0].line, 2);

  assert.ok(base, "zero is still displayed for reference-target types");
  assert.equal(base.command.title, "0 references");

  // Lenses anchor on the element start tag.
  assert.equal(tank.range.start.line, 1);
  assert.ok(tank.range.start.character < tank.range.end.character);
});

test("CodeLens returns nothing without a workspace or index", () => {
  const noWorkspace = new Ra3CodeLensProvider({
    isRa3Workspace: () => false,
    index: makeIndex(),
  });
  assert.deepEqual(noWorkspace.provideCodeLenses(makeDocument(), {}), []);

  const noIndex = new Ra3CodeLensProvider({
    isRa3Workspace: () => true,
    index: null,
  });
  assert.deepEqual(noIndex.provideCodeLenses(makeDocument(), {}), []);
});

test("CodeLens counts references attached to a manifest definition with the same SageXml source", () => {
  const manifestDef = {
    type: "GameObject",
    id: "TestTank",
    file: resolve(join(SDK, "builtmods", "static.manifest")),
    line: 0,
    origin: "manifest",
    manifestSource: "DATA:Includes/Units.xml",
  };
  const site = {
    file: "C:/mod/Data/Other.xml",
    line: 7,
    start: 40,
    end: 48,
    kind: "content",
  };
  const references = new Map();
  references.set(assetDefKey(manifestDef), [site]);
  const idx = {
    references,
    assets: new Map([
      ["GameObject", new Map([["testtank", [manifestDef]]])],
    ]),
    sdkDir: SDK,
    projectDir: PROJECT,
  };
  const provider = new Ra3CodeLensProvider({
    isRa3Workspace: () => true,
    index: idx,
  });
  const lenses = provider.provideCodeLenses(makeDocument(), {});
  const tank = lenses.find((l) => l.command.arguments[0].id === "TestTank");
  assert.ok(tank, "lens is shown for the SageXml-backed definition");
  assert.equal(tank.command.title, "1 reference");
});

test("CodeLens schedules a targeted rebuild when the open document desyncs from the snapshot", () => {
  const idx = makeIndex();
  idx.recordsHashes = new Map([[normKey(FILE), "stale-hash"]]);
  const calls = [];
  const provider = new Ra3CodeLensProvider({
    isRa3Workspace: () => true,
    index: idx,
    invalidate: (p) => calls.push(["invalidate", p]),
    scheduleRebuild: (r) => calls.push(["schedule", r]),
  });
  provider.provideCodeLenses(makeDocument(), {});
  assert.ok(
    calls.some(([kind]) => kind === "invalidate"),
    "the stale file is invalidated",
  );
  assert.ok(
    calls.some(([kind, reason]) => kind === "schedule" && reason === "records-desync"),
    "a targeted rebuild is scheduled",
  );
});
