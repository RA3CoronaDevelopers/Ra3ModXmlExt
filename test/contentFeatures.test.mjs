import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Minimal vscode shim for hover / definition / diagnostics providers.
const CompletionItemKind = {};
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
class MarkdownString {
  constructor(value) {
    this.value = value ?? "";
  }
  appendMarkdown(text) {
    this.value += text;
    return this;
  }
  appendCodeblock(text) {
    this.value += "\n```\n" + text + "\n```\n";
    return this;
  }
}
class Hover {
  constructor(contents) {
    this.contents = contents;
  }
}
class Location {
  constructor(uri, range) {
    this.uri = uri;
    this.range = range;
  }
}
class Diagnostic {
  constructor(range, message, severity) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}
class FakeDiagnosticCollection {
  constructor() {
    this.last = null;
  }
  set(uri, diags) {
    this.last = { uri, diags };
  }
  delete() {}
  dispose() {}
}
const Uri = {
  file: (p) => ({ fsPath: p }),
};
const workspace = {
  getWorkspaceFolder: (uri) => ({ uri: { fsPath: "C:/mod" } }),
};
const languages = {
  createDiagnosticCollection: () => new FakeDiagnosticCollection(),
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
    CompletionItemKind,
    Position,
    Range,
    MarkdownString,
    Hover,
    Location,
    Diagnostic,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    Uri,
    workspace,
    languages,
  },
};

const { Ra3HoverProvider } = require("../out/features/hover.js");
const { Ra3DefinitionProvider } = require("../out/features/navigation.js");
const { Ra3Diagnostics } = require("../out/features/diagnostics.js");
const { parseXml, LineMap } = require("../out/language/xmlParser.js");
const { expandDocument } = require("../out/indexer/logicalTree.js");

const URI = "C:/mod/Data/Crates.xml";

function makeDocument(text, uri = URI) {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  return {
    uri: { fsPath: uri },
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

async function makeScope(text, idx) {
  const lineMap = new LineMap(text);
  const parse = parseXml(text);
  const expanded = await expandDocument(URI, parse, {
    resolve: () => null,
    readDom: async () => null,
  });
  return {
    uri: URI,
    version: 1,
    parse,
    lineMap,
    expanded,
    lineMaps: new Map(),
    overlay: {},
    merged: idx,
  };
}

function makeIdx(defs) {
  const assets = new Map();
  const assetsById = new Map();
  for (const def of defs) {
    const idKey = def.id.toLowerCase();
    let byId = assets.get(def.type);
    if (!byId) {
      byId = new Map();
      assets.set(def.type, byId);
    }
    byId.set(idKey, [def]);
    assetsById.set(idKey, [def]);
  }
  return {
    assets,
    assetsById,
    defines: new Map(),
    projectDir: "C:/mod",
    sdkDir: "C:/sdk",
    files: new Map(),
    streams: [],
    manifests: new Map(),
    sourceCandidates: [],
    diagnostics: [],
    stats: {},
  };
}

const TEXT =
  `<AssetDeclaration>\n` +
  `  <GameObject id="CrateDebris_01"/>\n` +
  `  <ObjectCreationList id="OCL_CrateSpawn">\n` +
  `    <CreateObject>\n` +
  `      <CreateObject>CrateDebris_01</CreateObject>\n` +
  `    </CreateObject>\n` +
  `  </ObjectCreationList>\n` +
  `</AssetDeclaration>`;

test("hover on simple-content text shows the referenced definition", async () => {
  const def = {
    type: "GameObject",
    id: "CrateDebris_01",
    file: URI,
    line: 2,
    origin: "project",
  };
  const idx = makeIdx([def]);
  const scope = await makeScope(TEXT, idx);
  const provider = new Ra3HoverProvider({
    isRa3Workspace: () => true,
    getScope: async () => scope,
    searchPaths: () => null,
  });
  const line = TEXT.split("\n")[4];
  const pos = new Position(4, line.indexOf("CrateDebris_01") + 3);
  const hover = await provider.provideHover(makeDocument(TEXT), pos, {});
  assert.ok(hover, "hover is returned for typed content text");
  assert.match(hover.contents.value, /1 definition/);
  assert.match(hover.contents.value, /GameObject/);
});

test("Ctrl+click on simple-content text jumps to the definition", async () => {
  const def = {
    type: "GameObject",
    id: "CrateDebris_01",
    file: URI,
    line: 2,
    origin: "project",
  };
  const scope = await makeScope(TEXT, makeIdx([def]));
  const provider = new Ra3DefinitionProvider({
    isRa3Workspace: () => true,
    getScope: async () => scope,
    settings: { definitionMode: "all" },
    indexer: null,
  });
  const line = TEXT.split("\n")[4];
  const pos = new Position(4, line.indexOf("CrateDebris_01") + 3);
  const locations = await provider.provideDefinition(makeDocument(TEXT), pos, {});
  assert.ok(locations && locations.length === 1, "content definition resolves");
  const defStart = TEXT.indexOf('id="CrateDebris_01"') + 'id="'.length;
  const defEnd = defStart + "CrateDebris_01".length;
  assert.deepEqual(
    {
      start: locations[0].range.start,
      end: locations[0].range.end,
    },
    {
      start: makeDocument(TEXT).positionAt(defStart),
      end: makeDocument(TEXT).positionAt(defEnd),
    },
  );
});

test("diagnostics report unresolved typed content references only", async () => {
  const text =
    `<AssetDeclaration>\n` +
    `  <GameObject id="CrateDebris_01"/>\n` +
    `  <ObjectFilter>\n` +
    `    <IncludeThing>SomeValue</IncludeThing>\n` +
    `  </ObjectFilter>\n` +
    `  <ObjectCreationList id="OCL">\n` +
    `    <CreateObject>\n` +
    `      <CreateObject>CrateDebris_01</CreateObject>\n` +
    `      <CreateObject>MissingThing</CreateObject>\n` +
    `    </CreateObject>\n` +
    `  </ObjectCreationList>\n` +
    `</AssetDeclaration>`;
  const def = {
    type: "GameObject",
    id: "CrateDebris_01",
    file: URI,
    line: 2,
    origin: "project",
  };
  const scope = await makeScope(text, makeIdx([def]));
  const collection = new FakeDiagnosticCollection();
  const provider = new Ra3Diagnostics({
    isRa3Workspace: () => true,
    getScope: async () => scope,
    settings: {
      diagnoseUnknownElements: false,
      reportUnresolvedReferences: "warning",
    },
  });
  provider["collection"] = collection;
  await provider.update(makeDocument(text));
  const messages = collection.last.diags.map((d) => d.message);
  assert.ok(
    messages.some((m) => m.includes('Unresolved reference "MissingThing"')),
    "typed content refs are diagnosed",
  );
  assert.ok(
    !messages.some((m) => m.includes("SomeValue")),
    "untyped WeakReference content is not diagnosed as a global ref",
  );
});
