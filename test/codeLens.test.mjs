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
class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
  }
  fire() {
    for (const listener of this.listeners) listener();
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
    EventEmitter,
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
  const tankDef = {
    type: "GameObject",
    id: "TestTank",
    file: FILE,
    line: 2,
    origin: "project",
  };
  const baseDef = {
    type: "GameObject",
    id: "BaseVehicle",
    file: FILE,
    line: 3,
    origin: "project",
  };
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
    assetDefKey(tankDef),
    [tankSite, secondSite],
  );
  references.set(assetDefKey(baseDef), []);
  return {
    references,
    assets: new Map(),
    assetsById: new Map([
      ["testtank", [tankDef]],
      ["basevehicle", [baseDef]],
    ]),
    stats: { indexedFiles: 10 },
    sdkDir: SDK,
    projectDir: PROJECT,
  };
}

test("CodeLens shows counts on reference-target types only, including zero", async () => {
  const idx = makeIndex();
  const provider = new Ra3CodeLensProvider({
    isRa3Workspace: () => true,
    index: idx,
    getCodeLensScope: async () => ({ merged: idx }),
    recordsSyncSurfaceFor: () => ({}),
    log: () => {},
  });
  const lenses = await provider.provideCodeLenses(makeDocument(), {});

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

test("CodeLens returns nothing without a workspace or index", async () => {
  const noWorkspace = new Ra3CodeLensProvider({
    isRa3Workspace: () => false,
    index: makeIndex(),
  });
  assert.deepEqual(await noWorkspace.provideCodeLenses(makeDocument(), {}), []);

  const noIndex = new Ra3CodeLensProvider({
    isRa3Workspace: () => true,
    index: null,
    getCodeLensScope: async () => ({ merged: null }),
    recordsSyncSurfaceFor: () => ({}),
    log: () => {},
  });
  assert.deepEqual(await noIndex.provideCodeLenses(makeDocument(), {}), []);
});

test("CodeLens hides lenses before the first global snapshot", async () => {
  const localOnly = {
    complete: false,
    stats: { indexedFiles: 0 },
    references: new Map(),
  };
  const logs = [];
  const provider = new Ra3CodeLensProvider({
    isRa3Workspace: () => true,
    getCodeLensScope: async () => ({ merged: localOnly }),
    recordsSyncSurfaceFor: () => ({}),
    log: (m) => logs.push(m),
  });
  assert.deepEqual(await provider.provideCodeLenses(makeDocument(), {}), []);
  assert.deepEqual(await provider.provideCodeLenses(makeDocument(), {}), []);
  assert.equal(
    logs.filter((m) => m.includes("suppressed")).length,
    1,
    "suppression is logged once per document",
  );
  provider.resetSuppressionLog();
  await provider.provideCodeLenses(makeDocument(), {});
  assert.equal(
    logs.filter((m) => m.includes("suppressed")).length,
    2,
    "reset allows re-logging after a new snapshot",
  );
});

test("CodeLens refresh fires onDidChangeCodeLenses", () => {
  const provider = new Ra3CodeLensProvider({
    isRa3Workspace: () => true,
    getCodeLensScope: async () => ({ merged: null }),
    recordsSyncSurfaceFor: () => ({}),
    log: () => {},
  });
  let fired = 0;
  const subscription = provider.onDidChangeCodeLenses(() => {
    fired++;
  });
  provider.refresh();
  assert.equal(fired, 1);
  subscription.dispose();
});

test("CodeLens counts references attached to a manifest definition with the same SageXml source", async () => {
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
    assetsById: new Map([["testtank", [manifestDef]]]),
    stats: { indexedFiles: 10 },
    sdkDir: SDK,
    projectDir: PROJECT,
  };
  const provider = new Ra3CodeLensProvider({
    isRa3Workspace: () => true,
    index: idx,
    getCodeLensScope: async () => ({ merged: idx }),
    recordsSyncSurfaceFor: () => ({}),
    log: () => {},
  });
  const lenses = await provider.provideCodeLenses(makeDocument(), {});
  const tank = lenses.find((l) => l.command.arguments[0].id === "TestTank");
  assert.ok(tank, "lens is shown for the SageXml-backed definition");
  assert.equal(tank.command.title, "1 reference");
});

test("CodeLens schedules a targeted rebuild when the open document desyncs from the snapshot", async () => {
  const idx = makeIndex();
  idx.recordsHashes = new Map([[normKey(FILE), "stale-hash"]]);
  const calls = [];
  const ws = {
    isRa3Workspace: () => true,
    index: idx,
    invalidate: (p) => calls.push(["invalidate", p]),
    scheduleRebuild: (r) => calls.push(["schedule", r]),
    getCodeLensScope: async () => ({ merged: idx }),
    recordsSyncSurfaceFor: () => ws,
    log: () => {},
  };
  const provider = new Ra3CodeLensProvider(ws);
  await provider.provideCodeLenses(makeDocument(), {});
  assert.ok(
    calls.some(([kind]) => kind === "invalidate"),
    "the stale file is invalidated",
  );
  assert.ok(
    calls.some(([kind, reason]) => kind === "schedule" && reason === "records-desync"),
    "a targeted rebuild is scheduled",
  );
});
