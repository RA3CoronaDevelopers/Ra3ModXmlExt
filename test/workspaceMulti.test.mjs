import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// ── Minimal vscode shim for ModWorkspace (multi-project behavior) ──────
const stubState = {
  workspaceFolders: [],
  textDocuments: [],
  activeEditor: null,
  config: {
    sdkPath: "",
    indexSageXml: true,
    reportUnresolvedReferences: "warning",
    diagnoseUnknownElements: true,
    definitionMode: "all",
    additionalDataSearchPaths: [],
  },
};

class RelativePattern {
  constructor(base, pattern) {
    this.base = base;
    this.pattern = pattern;
  }
}

class OutputChannel {
  appendLine() {}
  dispose() {}
}

class StatusBarItem {
  constructor() {
    this.name = "";
    this.command = "";
    this.text = "";
    this.tooltip = "";
  }
  show() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  dispose() {}
}

function makeWatcher() {
  return {
    onDidCreate: () => ({ dispose() {} }),
    onDidChange: () => ({ dispose() {} }),
    onDidDelete: () => ({ dispose() {} }),
    dispose() {},
  };
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
    RelativePattern,
    StatusBarAlignment: { Left: 1 },
    workspace: {
      getConfiguration: () => ({
        get: (key, def) => stubState.config[key] ?? def,
      }),
      get workspaceFolders() {
        return stubState.workspaceFolders;
      },
      get textDocuments() {
        return stubState.textDocuments;
      },
      createFileSystemWatcher: () => makeWatcher(),
      onDidCloseTextDocument: () => ({ dispose() {} }),
    },
    window: {
      createOutputChannel: () => new OutputChannel(),
      createStatusBarItem: () => new StatusBarItem(),
      get activeTextEditor() {
        return stubState.activeEditor;
      },
    },
    commands: {
      executeCommand: async () => undefined,
    },
  },
};

const { ModWorkspace } = require("../out/workspace.js");

// ── Fixtures ────────────────────────────────────────────────────────────
const FAKE_SDK = fileURLToPath(new URL("./fixtures/fakesdk", import.meta.url));
let tmpRoot;
let modA;
let modB;
let container;
let storageDir;
const MOD_A_TEXT = "<AssetDeclaration><GameObject id=\"UnitA\"/></AssetDeclaration>";
const MOD_B_TEXT = "<AssetDeclaration><GameObject id=\"UnitB\"/></AssetDeclaration>";

test.before(() => {
  stubState.config.sdkPath = FAKE_SDK;
  tmpRoot = mkdtempSync(join(tmpdir(), "ra3-multimod-"));
  modA = join(tmpRoot, "container", "ModA");
  modB = join(tmpRoot, "container", "ModB");
  container = join(tmpRoot, "container");
  storageDir = join(tmpRoot, "storage");
  mkdirSync(join(modA, "Data"), { recursive: true });
  mkdirSync(join(modB, "Data"), { recursive: true });
  writeFileSync(join(modA, "Data", "Mod.xml"), MOD_A_TEXT);
  writeFileSync(join(modB, "Data", "Mod.xml"), MOD_B_TEXT);
});

test.after(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

function makeDoc(fsPath, text = "<AssetDeclaration/>") {
  return {
    uri: {
      fsPath,
      scheme: "file",
      toString: () => `file://${fsPath}`,
    },
    languageId: "xml",
    isDirty: false,
    version: 1,
    getText: () => text,
  };
}

function makeWorkspace(folders) {
  stubState.workspaceFolders = folders;
  stubState.textDocuments = [];
  stubState.activeEditor = null;
  const context = {
    storageUri: { fsPath: storageDir },
    globalStorageUri: null,
    subscriptions: [],
  };
  return new ModWorkspace(context);
}

async function waitForIndex(ws, doc) {
  for (let i = 0; i < 500; i++) {
    const idx = await ws.getIndex(doc);
    if (idx?.complete && idx.stats.assetCount > 0) return idx;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for index of ${doc.uri.fsPath}`);
}

function stateForRoot(ws, root) {
  const wanted = resolve(root).toLowerCase();
  return [...ws.states.values()].find(
    (s) => resolve(s.root).toLowerCase() === wanted,
  );
}

test("single project folder is indexed immediately on initialize", async () => {
  const ws = makeWorkspace([{ uri: { fsPath: modA } }]);
  await ws.initialize();
  assert.equal(ws.getProjectRoots().length, 1);
  const idx = ws.activeIndex();
  assert.ok(idx);
  assert.equal(resolve(idx.stats.projectDir), resolve(modA));
  assert.ok(idx.assetsById.has("unita"));
  ws.dispose();
});

test("container folder discovers two projects and indexes lazily", async () => {
  const ws = makeWorkspace([{ uri: { fsPath: container } }]);
  await ws.initialize();

  assert.equal(ws.getProjectRoots().length, 2);
  assert.equal(ws.activeIndex(), null);

  const docA = makeDoc(join(modA, "Data", "Mod.xml"), MOD_A_TEXT);
  const docB = makeDoc(join(modB, "Data", "Mod.xml"), MOD_B_TEXT);
  assert.equal(ws.getProjectRootFor(docA), resolve(modA));
  assert.equal(ws.getProjectRootFor(docB), resolve(modB));
  assert.ok(
    ws.searchPaths(docA).DATA.some((d) => resolve(d) === resolve(join(modA, "Data"))),
  );

  // Opening ModA's document builds only ModA.
  ws.onDocumentOpened(docA);
  const idxA = await waitForIndex(ws, docA);
  assert.equal(resolve(idxA.stats.projectDir), resolve(modA));
  assert.ok(idxA.assetsById.has("unita"));

  const stateB = stateForRoot(ws, modB);
  assert.ok(stateB);
  assert.equal(stateB.index, null);
  assert.equal(stateB.buildCount, 0);

  // Opening ModB's document builds ModB.
  ws.onDocumentOpened(docB);
  const idxB = await waitForIndex(ws, docB);
  assert.equal(resolve(idxB.stats.projectDir), resolve(modB));
  assert.ok(idxB.assetsById.has("unitb"));
  ws.dispose();
});

test("with multiple projects the active editor's project builds on initialize", async () => {
  const ws = makeWorkspace([{ uri: { fsPath: container } }]);
  stubState.activeEditor = {
    document: makeDoc(join(modB, "Data", "Mod.xml"), MOD_B_TEXT),
  };
  await ws.initialize();
  const idx = ws.activeIndex();
  assert.ok(idx);
  assert.equal(resolve(idx.stats.projectDir), resolve(modB));
  ws.dispose();
});

test("workspace folder changes add and remove projects", async () => {
  const ws = makeWorkspace([{ uri: { fsPath: container } }]);
  await ws.initialize();
  assert.equal(ws.getProjectRoots().length, 2);

  stubState.workspaceFolders = [{ uri: { fsPath: modA } }];
  ws.onWorkspaceFoldersChanged();
  assert.equal(ws.getProjectRoots().length, 1);
  assert.equal(resolve(ws.getProjectRoots()[0]), resolve(modA));

  stubState.workspaceFolders = [{ uri: { fsPath: container } }];
  ws.onWorkspaceFoldersChanged();
  assert.equal(ws.getProjectRoots().length, 2);
  ws.dispose();
});

test("an unrelated active XML document falls back without recursion", async () => {
  const ws = makeWorkspace([{ uri: { fsPath: container } }]);
  const outside = join(tmpRoot, "outside.xml");
  writeFileSync(outside, "<AssetDeclaration/>");
  stubState.activeEditor = { document: makeDoc(outside) };
  await ws.initialize();
  // No project contains the active document, so nothing builds eagerly and
  // activeIndex resolves to the first project (or null) without recursing.
  assert.equal(ws.getProjectRoots().length, 2);
  const idx = ws.activeIndex();
  assert.equal(idx, null);
  ws.dispose();
});

test("rebuilds for both projects complete through the serialized queue", async () => {
  const ws = makeWorkspace([{ uri: { fsPath: container } }]);
  await ws.initialize();
  const docA = makeDoc(join(modA, "Data", "Mod.xml"), MOD_A_TEXT);
  const docB = makeDoc(join(modB, "Data", "Mod.xml"), MOD_B_TEXT);

  const p1 = ws.rebuild(false, "test-a", docA);
  const p2 = ws.rebuild(false, "test-b", docB);
  await Promise.all([p1, p2]);

  const idxA = await waitForIndex(ws, docA);
  const idxB = await waitForIndex(ws, docB);
  assert.equal(resolve(idxA.stats.projectDir), resolve(modA));
  assert.equal(resolve(idxB.stats.projectDir), resolve(modB));
  assert.ok(idxA.assetsById.has("unita"));
  assert.ok(idxB.assetsById.has("unitb"));
  ws.dispose();
});
