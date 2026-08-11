import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

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
    this.range = range instanceof Position ? new Range(range, range) : range;
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

test("qualified Type:Id inheritFrom is diagnosed and navigated as resolved", async () => {
  const text =
    `<AssetDeclaration xmlns="uri:ea.com:eala:asset">\n` +
    `  <AudioEvent id="BaseSoundEffect"/>\n` +
    `  <AudioEvent id="X" inheritFrom="AudioEvent:BaseSoundEffect"/>\n` +
    `</AssetDeclaration>`;
  const def = {
    type: "AudioEvent",
    id: "BaseSoundEffect",
    file: URI,
    line: 1,
    origin: "project",
  };
  const idx = makeIdx([def]);
  const scope = await makeScope(text, idx);

  // Diagnostics: the manifest-style qualified value must not be reported as
  // an unresolved reference (the reported FutureTank scenario).
  const collection = new FakeDiagnosticCollection();
  const diagnostics = new Ra3Diagnostics({
    isRa3Workspace: () => true,
    getScope: async () => scope,
    settings: {
      diagnoseUnknownElements: false,
      reportUnresolvedReferences: "warning",
    },
  });
  diagnostics["collection"] = collection;
  await diagnostics.update(makeDocument(text));
  const messages = collection.last.diags.map((d) => d.message);
  assert.ok(
    !messages.some((m) => m.includes("AudioEvent:BaseSoundEffect")),
    "qualified inheritFrom is not unresolved",
  );

  // Ctrl+click on the qualified value jumps to the plain-id definition.
  const provider = new Ra3DefinitionProvider({
    isRa3Workspace: () => true,
    getScope: async () => scope,
    settings: { definitionMode: "all" },
    indexer: null,
  });
  const line = text.split("\n")[2];
  const pos = new Position(2, line.indexOf("AudioEvent:BaseSoundEffect") + 8);
  const locations = await provider.provideDefinition(makeDocument(text), pos, {});
  assert.ok(locations && locations.length === 1, "qualified reference resolves");
  const defLine = text.split("\n")[1];
  const defStartChar =
    defLine.indexOf('id="BaseSoundEffect"') + 'id="'.length;
  assert.equal(locations[0].range.start.line, 1);
  assert.equal(locations[0].range.start.character, defStartChar);
  assert.equal(
    locations[0].range.end.character,
    defStartChar + "BaseSoundEffect".length,
  );
});

test("hover on simpleContent complex content shows the referenced definition", async () => {
  const text =
    `<AssetDeclaration>\n` +
    `  <AudioEvent id="A">\n` +
    `    <Sound>VoiceFile</Sound>\n` +
    `  </AudioEvent>\n` +
    `</AssetDeclaration>`;
  const def = {
    type: "AudioFile",
    id: "VoiceFile",
    file: URI,
    line: 2,
    origin: "project",
  };
  const scope = await makeScope(text, makeIdx([def]));
  const provider = new Ra3HoverProvider({
    isRa3Workspace: () => true,
    getScope: async () => scope,
    searchPaths: () => null,
  });
  const line = text.split("\n")[2];
  const pos = new Position(2, line.indexOf("VoiceFile") + 3);
  const hover = await provider.provideHover(makeDocument(text), pos, {});
  assert.ok(hover, "hover is returned for AudioFileRefWithWeight content");
  assert.match(hover.contents.value, /1 definition/);
  assert.match(hover.contents.value, /AudioFile/);
});

test("Ctrl+click on simpleContent complex content jumps to the definition", async () => {
  const text =
    `<AssetDeclaration>\n` +
    `  <AudioEvent id="A">\n` +
    `    <Sound>VoiceFile</Sound>\n` +
    `  </AudioEvent>\n` +
    `</AssetDeclaration>`;
  const def = {
    type: "AudioFile",
    id: "VoiceFile",
    file: URI,
    line: 2,
    origin: "project",
  };
  const scope = await makeScope(text, makeIdx([def]));
  const provider = new Ra3DefinitionProvider({
    isRa3Workspace: () => true,
    getScope: async () => scope,
    settings: { definitionMode: "all" },
    indexer: null,
  });
  const line = text.split("\n")[2];
  const pos = new Position(2, line.indexOf("VoiceFile") + 3);
  const locations = await provider.provideDefinition(makeDocument(text), pos, {});
  assert.ok(locations && locations.length === 1);
  assert.equal(locations[0].uri.fsPath, URI);
});

test("diagnostics report unresolved simpleContent complex content references", async () => {
  const text =
    `<AssetDeclaration>\n` +
    `  <Multisound id="M">\n` +
    `    <Subsound>MissingEvent</Subsound>\n` +
    `  </Multisound>\n` +
    `</AssetDeclaration>`;
  const scope = await makeScope(text, makeIdx([]));
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
    messages.some((m) => m.includes('Unresolved reference "MissingEvent"')),
    "MultisoundSubsoundRef text is diagnosed as a typed content reference",
  );
});

test("Ctrl+click on a manifest definition maps to SageXml even when the mod shadows the DATA path", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "ra3-nav-manifest-"));
  try {
    const sdkDir = join(tmp, "sdk");
    const projectDir = join(tmp, "project");
    const sageFile = join(sdkDir, "SageXml", "globaldata", "weapon.xml");
    const modFile = join(projectDir, "Data", "globaldata", "weapon.xml");
    mkdirSync(dirname(sageFile), { recursive: true });
    mkdirSync(dirname(modFile), { recursive: true });
    writeFileSync(
      sageFile,
      '<AssetDeclaration xmlns="uri:ea.com:eala:asset"><GameObject id="AlliedCommandoDesertEagles"/></AssetDeclaration>',
      "utf8",
    );
    writeFileSync(
      modFile,
      '<AssetDeclaration xmlns="uri:ea.com:eala:asset"><GameObject id="ModOnly"/></AssetDeclaration>',
      "utf8",
    );

    const manifestDef = {
      type: "GameObject",
      id: "AlliedCommandoDesertEagles",
      file: join(sdkDir, "builtmods", "static.manifest"),
      line: 0,
      origin: "manifest",
      manifestSource: "DATA:globaldata/weapon.xml",
    };
    const idx = makeIdx([manifestDef]);
    idx.projectDir = projectDir;
    idx.sdkDir = sdkDir;
    const text =
      '<AssetDeclaration xmlns="uri:ea.com:eala:asset">\n' +
      '  <GameObject id="MyUnit" inheritFrom="AlliedCommandoDesertEagles"/>\n' +
      "</AssetDeclaration>";
    const scope = await makeScope(text, idx);
    const provider = new Ra3DefinitionProvider({
      isRa3Workspace: () => true,
      getScope: async () => scope,
      settings: { definitionMode: "all" },
      indexer: { readDom: async () => null },
    });

    const line = text.split("\n")[1];
    const pos = new Position(
      1,
      line.indexOf("AlliedCommandoDesertEagles") + 3,
    );
    const locations = await provider.provideDefinition(makeDocument(text), pos, {});
    assert.ok(locations && locations.length === 1, "manifest definition resolves");
    assert.equal(
      locations[0].uri.fsPath,
      sageFile,
      "manifest source must resolve to SageXml, not the mod shadow file",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("manifest definition stays manifest-only when the SageXml source is missing", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "ra3-nav-manifest-missing-"));
  try {
    const sdkDir = join(tmp, "sdk");
    const projectDir = join(tmp, "project");
    const modFile = join(projectDir, "Data", "globaldata", "weapon.xml");
    mkdirSync(dirname(modFile), { recursive: true });
    writeFileSync(
      modFile,
      '<AssetDeclaration xmlns="uri:ea.com:eala:asset"><GameObject id="AlliedCommandoDesertEagles"/></AssetDeclaration>',
      "utf8",
    );

    const manifestDef = {
      type: "GameObject",
      id: "AlliedCommandoDesertEagles",
      file: join(sdkDir, "builtmods", "static.manifest"),
      line: 0,
      origin: "manifest",
      manifestSource: "DATA:globaldata/weapon.xml",
    };
    const idx = makeIdx([manifestDef]);
    idx.projectDir = projectDir;
    idx.sdkDir = sdkDir;
    const text =
      '<AssetDeclaration xmlns="uri:ea.com:eala:asset">\n' +
      '  <GameObject id="MyUnit" inheritFrom="AlliedCommandoDesertEagles"/>\n' +
      "</AssetDeclaration>";
    const scope = await makeScope(text, idx);
    const provider = new Ra3DefinitionProvider({
      isRa3Workspace: () => true,
      getScope: async () => scope,
      settings: { definitionMode: "all" },
      indexer: { readDom: async () => null },
    });

    const line = text.split("\n")[1];
    const pos = new Position(
      1,
      line.indexOf("AlliedCommandoDesertEagles") + 3,
    );
    const locations = await provider.provideDefinition(makeDocument(text), pos, {});
    assert.equal(
      locations,
      null,
      "missing vanilla source must not fall back to the mod shadow file",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("manifest definition opens the SageXml file at the top when the id is no longer there", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "ra3-nav-manifest-stale-"));
  try {
    const sdkDir = join(tmp, "sdk");
    const projectDir = join(tmp, "project");
    const sageFile = join(sdkDir, "SageXml", "globaldata", "weapon.xml");
    const modFile = join(projectDir, "Data", "globaldata", "weapon.xml");
    mkdirSync(dirname(sageFile), { recursive: true });
    mkdirSync(dirname(modFile), { recursive: true });
    writeFileSync(
      sageFile,
      '<AssetDeclaration xmlns="uri:ea.com:eala:asset"/>',
      "utf8",
    );
    writeFileSync(
      modFile,
      '<AssetDeclaration xmlns="uri:ea.com:eala:asset"><GameObject id="AlliedCommandoDesertEagles"/></AssetDeclaration>',
      "utf8",
    );

    const manifestDef = {
      type: "GameObject",
      id: "AlliedCommandoDesertEagles",
      file: join(sdkDir, "builtmods", "static.manifest"),
      line: 0,
      origin: "manifest",
      manifestSource: "DATA:globaldata/weapon.xml",
    };
    const idx = makeIdx([manifestDef]);
    idx.projectDir = projectDir;
    idx.sdkDir = sdkDir;
    const text =
      '<AssetDeclaration xmlns="uri:ea.com:eala:asset">\n' +
      '  <GameObject id="MyUnit" inheritFrom="AlliedCommandoDesertEagles"/>\n' +
      "</AssetDeclaration>";
    const scope = await makeScope(text, idx);
    const provider = new Ra3DefinitionProvider({
      isRa3Workspace: () => true,
      getScope: async () => scope,
      settings: { definitionMode: "all" },
      indexer: { readDom: async () => null },
    });

    const line = text.split("\n")[1];
    const pos = new Position(
      1,
      line.indexOf("AlliedCommandoDesertEagles") + 3,
    );
    const locations = await provider.provideDefinition(makeDocument(text), pos, {});
    assert.ok(locations && locations.length === 1);
    assert.equal(locations[0].uri.fsPath, sageFile);
    assert.equal(locations[0].range.start.line, 0);
    assert.equal(locations[0].range.start.character, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
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

test("fragment diagnostics skip document-level checks but keep subtree validation", async () => {
  const text =
    `<CreateObjectDie xmlns="uri:ea.com:eala:asset" id="ModuleTag_X" CreationList="OCL_X">\n` +
    `  <DieMuxData DeathTypo="SUICIDED"/>\n` +
    `</CreateObjectDie>`;
  const scope = await makeScope(text, makeIdx([]));
  const collection = new FakeDiagnosticCollection();
  const provider = new Ra3Diagnostics({
    isRa3Workspace: () => true,
    getScope: async () => scope,
    settings: {
      diagnoseUnknownElements: true,
      reportUnresolvedReferences: "warning",
    },
  });
  provider["collection"] = collection;
  await provider.update(makeDocument(text));
  const codes = collection.last.diags.map((d) => d.code);
  assert.ok(
    !codes.includes("missing-id"),
    "fragment children are not treated as top-level assets",
  );
  assert.ok(
    !codes.some((c) => c.startsWith("unresolved-reference")),
    "fragment references are deferred to the includer context",
  );
  assert.ok(
    codes.includes("unknown-attribute"),
    "a known fragment root still validates its subtree attributes",
  );
});

test("fragment diagnostics ignore unknown wrapper roots and still report missing xi:include", async () => {
  const text =
    `<CommonArmorDraws xmlns="uri:ea.com:eala:asset" xmlns:xi="http://www.w3.org/2001/XInclude">\n` +
    `  <ScriptedModelDraw id="M" Bogus="x"/>\n` +
    `  <xi:include href="MissingTarget.xml"/>\n` +
    `</CommonArmorDraws>`;
  const scope = await makeScope(text, makeIdx([]));
  const collection = new FakeDiagnosticCollection();
  const provider = new Ra3Diagnostics({
    isRa3Workspace: () => true,
    getScope: async () => scope,
    settings: {
      diagnoseUnknownElements: true,
      reportUnresolvedReferences: "warning",
    },
  });
  provider["collection"] = collection;
  await provider.update(makeDocument(text));
  const codes = collection.last.diags.map((d) => d.code);
  assert.ok(
    !codes.includes("unknown-element"),
    "wrapper roots are not validated as standalone documents",
  );
  assert.ok(
    !codes.includes("unknown-attribute"),
    "unknown wrapper roots do not trigger subtree attribute guessing",
  );
  assert.ok(
    codes.includes("include-not-found"),
    "missing xi:include targets inside fragments are still reported",
  );
});

test("diagnostics accept universal inheritFrom on asset types", async () => {
  const text =
    `<AssetDeclaration>\n` +
    `  <FXList id="FX_A" inheritFrom="FX_Base">\n` +
    `    <NuggetList/>\n` +
    `  </FXList>\n` +
    `</AssetDeclaration>`;
  const scope = await makeScope(text, makeIdx([]));
  const collection = new FakeDiagnosticCollection();
  const provider = new Ra3Diagnostics({
    isRa3Workspace: () => true,
    getScope: async () => scope,
    settings: {
      diagnoseUnknownElements: true,
      reportUnresolvedReferences: "none",
    },
  });
  provider["collection"] = collection;
  await provider.update(makeDocument(text));
  const codes = collection.last.diags.map((d) => d.code);
  assert.ok(
    !codes.includes("unknown-attribute"),
    "FXList inheritFrom must not be flagged as unknown",
  );

  const badText =
    `<AssetDeclaration>\n` +
    `  <FXList id="FX_B" Bogus="x">\n` +
    `    <NuggetList/>\n` +
    `  </FXList>\n` +
    `</AssetDeclaration>`;
  const badScope = await makeScope(badText, makeIdx([]));
  const badCollection = new FakeDiagnosticCollection();
  const badProvider = new Ra3Diagnostics({
    isRa3Workspace: () => true,
    getScope: async () => badScope,
    settings: {
      diagnoseUnknownElements: true,
      reportUnresolvedReferences: "none",
    },
  });
  badProvider["collection"] = badCollection;
  await badProvider.update(makeDocument(badText));
  assert.ok(
    badCollection.last.diags.map((d) => d.code).includes("unknown-attribute"),
    "a real unknown attribute is still reported",
  );
});

test("diagnostics keep simpleContent extension attributes known", async () => {
  const text =
    `<AssetDeclaration>\n` +
    `  <AudioEvent id="A">\n` +
    `    <Sound Weight="100">AudioFile</Sound>\n` +
    `  </AudioEvent>\n` +
    `</AssetDeclaration>`;
  const scope = await makeScope(text, makeIdx([]));
  const collection = new FakeDiagnosticCollection();
  const provider = new Ra3Diagnostics({
    isRa3Workspace: () => true,
    getScope: async () => scope,
    settings: {
      diagnoseUnknownElements: true,
      reportUnresolvedReferences: "none",
    },
  });
  provider["collection"] = collection;
  await provider.update(makeDocument(text));
  const codes = collection.last.diags.map((d) => d.code);
  assert.ok(
    !codes.includes("unknown-attribute"),
    "Weight on AudioFileRefWithWeight must be known",
  );
});

test("diagnostics use the top-level asset type for colliding fragment roots", async () => {
  const text =
    `<EvaEvent id="IncomingTransmission" Priority="100" TimeBetweenEvents="0ms" ExpirationTime="10000ms"/>`;
  const scope = await makeScope(text, makeIdx([]));
  const collection = new FakeDiagnosticCollection();
  const provider = new Ra3Diagnostics({
    isRa3Workspace: () => true,
    getScope: async () => scope,
    settings: {
      diagnoseUnknownElements: true,
      reportUnresolvedReferences: "none",
    },
  });
  provider["collection"] = collection;
  await provider.update(makeDocument(text));
  const codes = collection.last.diags.map((d) => d.code);
  assert.ok(
    !codes.includes("unknown-attribute"),
    "EvaEvent fragment root attributes must resolve against the top-level asset type",
  );
});

test("full documents still require ids on top-level assets", async () => {
  const text = `<AssetDeclaration>\n  <GameObject/>\n</AssetDeclaration>`;
  const scope = await makeScope(text, makeIdx([]));
  const collection = new FakeDiagnosticCollection();
  const provider = new Ra3Diagnostics({
    isRa3Workspace: () => true,
    getScope: async () => scope,
    settings: {
      diagnoseUnknownElements: true,
      reportUnresolvedReferences: "warning",
    },
  });
  provider["collection"] = collection;
  await provider.update(makeDocument(text));
  const codes = collection.last.diags.map((d) => d.code);
  assert.ok(
    codes.includes("missing-id"),
    "AssetDeclaration documents keep top-level id checks",
  );
});
