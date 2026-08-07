import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Minimal vscode shim for the semantic reference provider.
class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}
class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}
class Location {
  constructor(uri, range) {
    this.uri = uri;
    this.range = range;
  }
}
const Uri = {
  file: (p) => ({ fsPath: p }),
};

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
    Position,
    Range,
    Location,
    Uri,
    SymbolKind: {},
    DocumentSymbol: class {},
  },
};

const { Ra3ReferenceProvider } = require("../out/features/navigation.js");
const { LineMap, parseXml } = require("../out/language/xmlParser.js");
const { extractIndexRecords } = require("../out/indexer/records.js");
const { buildReferenceIndex } = require("../out/indexer/referenceIndex.js");

const FILE = "C:/mod/Data/Units.xml";
const TEXT = `<AssetDeclaration>
  <GameObject id="Tank"/>
  <ObjectCreationList id="OCL">
    <CreateObject>
      <CreateObject>Tank</CreateObject>
    </CreateObject>
  </ObjectCreationList>
</AssetDeclaration>`;

function makeDocument(text = TEXT) {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  return {
    uri: { fsPath: FILE },
    getText: () => text,
    offsetAt: (pos) => lineStarts[pos.line] + pos.character,
    positionAt: (offset) => {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= offset) lo = mid;
        else hi = mid - 1;
      }
      return new Position(lo, offset - lineStarts[lo]);
    },
  };
}

function makeScope() {
  const parse = parseXml(TEXT);
  const lineMap = new LineMap(TEXT);
  const records = extractIndexRecords(parse, lineMap, TEXT);
  const def = {
    type: "GameObject",
    id: "Tank",
    file: FILE,
    line: 2,
    origin: "project",
  };
  const lookup = {
    assets: new Map([["GameObject", new Map([["tank", [def]]])]]),
    assetsById: new Map([["tank", [def]]]),
  };
  const references = buildReferenceIndex([{ file: FILE, records }], lookup);
  const idx = {
    ...lookup,
    references,
    complete: true,
    phase: "art",
    projectDir: "C:/mod",
    sdkDir: "C:/sdk",
    defines: new Map(),
    files: new Map(),
    streams: [],
    manifests: new Map(),
    sourceCandidates: [],
    diagnostics: [],
    stats: {},
  };
  return {
    merged: idx,
  };
}

function makeWs(scope) {
  const parse = parseXml(TEXT);
  const lineMap = new LineMap(TEXT);
  return {
    isRa3Workspace: () => true,
    getScope: async () => scope,
    indexer: {
      readDom: async (path) =>
        path === FILE
          ? { file: { path: FILE }, parse, lineMap, records: null }
          : null,
    },
  };
}

test("semantic Find All References excludes the definition even when includeDeclaration is set", async () => {
  const scope = makeScope();
  const provider = new Ra3ReferenceProvider(makeWs(scope));
  const document = makeDocument();
  const defLine = TEXT.split("\n")[1];
  const defPos = new Position(1, defLine.indexOf('id="') + 4);

  const refs = await provider.provideReferences(document, defPos, {
    includeDeclaration: true,
  }, {});
  assert.ok(refs, "references are returned");
  assert.equal(refs.length, 1, "only the typed content reference is returned");
  assert.equal(refs[0].uri.fsPath, FILE);
  assert.equal(refs[0].range.start.line, 4);
  assert.equal(
    TEXT.split("\n")[4].slice(refs[0].range.start.character, refs[0].range.end.character),
    "Tank",
  );
});

test("FAR from the reference site itself returns the same result", async () => {
  const scope = makeScope();
  const provider = new Ra3ReferenceProvider(makeWs(scope));
  const document = makeDocument();
  const contentLine = TEXT.split("\n")[4];
  const contentPos = new Position(4, contentLine.indexOf("Tank") + 1);

  const refs = await provider.provideReferences(document, contentPos, {
    includeDeclaration: false,
  }, {});
  assert.equal(refs.length, 1);
  assert.equal(refs[0].range.start.line, 4);
});
