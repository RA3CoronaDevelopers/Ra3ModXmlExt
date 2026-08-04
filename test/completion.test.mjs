import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Minimal vscode shim so the compiled completion provider can run under plain
// node. Only the APIs used by the completion call path are implemented.
const CompletionItemKind = {
  Field: 1,
  Property: 2,
  EnumMember: 3,
  Value: 4,
  Constant: 5,
  File: 6,
};

class CompletionItem {
  constructor(label, kind) {
    this.label = label;
    this.kind = kind;
  }
}

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

class SnippetString {
  constructor(value) {
    this.value = value;
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
    CompletionItem,
    CompletionItemKind,
    Position,
    Range,
    MarkdownString,
    SnippetString,
  },
};

const { Ra3CompletionProvider } = require("../out/features/completion.js");
const { parseXml, LineMap } = require("../out/language/xmlParser.js");
const { expandDocument } = require("../out/indexer/logicalTree.js");

function makeDocument(text) {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  return {
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
  const expanded = await expandDocument("test.xml", parse, {
    resolve: () => null,
    readDom: async () => null,
  });
  return { expanded, merged: idx, overlay: {} };
}

// Enum completions do not consult the index, and value contexts now work
// even before the workspace index exists.
const makeProvider = (idx) =>
  new Ra3CompletionProvider({
    index: idx,
    isRa3Workspace: () => true,
    getScope: async (document) => makeScope(document.getText(), idx),
    log: () => {},
  });
const provider = makeProvider({});
const providerNoIndex = makeProvider(null);
const token = { isCancellationRequested: false };

test("Surfaces enum completion works with an unclosed quote", async () => {
  const text =
    `<AssetDeclaration>\n  <LocomotorTemplate id="x" Surfaces="G>\n  <Other/>\n</LocomotorTemplate>\n</AssetDeclaration>`;
  const line1 = text.split("\n")[1];
  const line1Start = text.indexOf("\n") + 1;
  const valueStart = text.indexOf('Surfaces="') + 'Surfaces="'.length;
  const pos = new Position(1, line1.indexOf("G") + 1);

  const items = await provider.provideCompletionItems(makeDocument(text), pos, token);
  const labels = items.map((i) => i.label);
  assert.ok(labels.includes("GROUND"));
  assert.ok(!labels.includes("WATER"));
  assert.ok(items.every((i) => i.kind === CompletionItemKind.EnumMember));

  // Replacement range covers only the value (start..cursor).
  const ground = items.find((i) => i.label === "GROUND");
  assert.equal(ground.range.start.character, valueStart - line1Start);
  assert.equal(ground.range.end.character, pos.character);
});

test("list values filter on the token after whitespace", async () => {
  const text =
    `<AssetDeclaration>\n  <LocomotorTemplate id="x" Surfaces="GROUND W>\n  <Other/>\n</LocomotorTemplate>\n</AssetDeclaration>`;
  const line1 = text.split("\n")[1];
  const line1Start = text.indexOf("\n") + 1;
  const valueStart = text.indexOf('Surfaces="') + 'Surfaces="'.length;
  const pos = new Position(1, line1.indexOf("W") + 1);

  const items = await provider.provideCompletionItems(makeDocument(text), pos, token);
  const labels = items.map((i) => i.label);
  assert.ok(labels.includes("WATER"));
  assert.ok(labels.includes("WALL_RAILING"));
  assert.ok(!labels.includes("GROUND"));

  // Replacement range covers only the second token, not "GROUND ".
  const water = items.find((i) => i.label === "WATER");
  assert.equal(water.range.start.character, valueStart + "GROUND ".length - line1Start);
});

test("list completion after a space offers only unused flags", async () => {
  const text =
    `<AssetDeclaration>\n  <LocomotorTemplate id="x" Surfaces="GROUND ">\n  <Other/>\n</LocomotorTemplate>\n</AssetDeclaration>`;
  const line1 = text.split("\n")[1];
  const pos = new Position(1, line1.indexOf("GROUND ") + "GROUND ".length);

  const items = await provider.provideCompletionItems(makeDocument(text), pos, token);
  const labels = items.map((i) => i.label);
  assert.equal(items.length, 10);
  assert.ok(labels.includes("WATER"));
  assert.ok(!labels.includes("GROUND"));

  // The replacement range is empty at the cursor: existing flags are kept.
  const water = items.find((i) => i.label === "WATER");
  assert.equal(water.range.start.character, pos.character);
  assert.equal(water.range.end.character, pos.character);
});

test("inserting a flag in the middle of a list does not delete trailing flags", async () => {
  const text =
    `<AssetDeclaration>\n  <LocomotorTemplate id="x" Surfaces="GROUND WATER">\n  <Other/>\n</LocomotorTemplate>\n</AssetDeclaration>`;
  const line1 = text.split("\n")[1];
  // Cursor right after the space between GROUND and WATER.
  const pos = new Position(1, line1.indexOf("GROUND ") + "GROUND ".length);

  const items = await provider.provideCompletionItems(makeDocument(text), pos, token);
  const labels = items.map((i) => i.label);
  assert.ok(labels.includes("WATER"));
  assert.ok(!labels.includes("GROUND"));
  const water = items.find((i) => i.label === "WATER");
  assert.equal(water.insertText, "WATER");
  // The range must end at the cursor, not at the end of the whole value
  // (which would replace the trailing "WATER" when accepting a suggestion).
  assert.equal(water.range.start.character, pos.character);
  assert.equal(water.range.end.character, pos.character);
});

test("complete flag at the end of a closed value appends the remaining flags", async () => {
  const text =
    `<AssetDeclaration>\n  <LocomotorTemplate id="x" Surfaces="GROUND">\n  <Other/>\n</LocomotorTemplate>\n</AssetDeclaration>`;
  const line1 = text.split("\n")[1];
  const pos = new Position(1, line1.indexOf("GROUND") + "GROUND".length);

  const items = await provider.provideCompletionItems(makeDocument(text), pos, token);
  const labels = items.map((i) => i.label);
  assert.equal(items.length, 10);
  assert.ok(!labels.includes("GROUND"));
  const water = items.find((i) => i.label === "WATER");
  assert.ok(water, "remaining flags are offered at the end of a complete flag");
  assert.equal(water.insertText, " WATER");
  assert.equal(water.range.start.character, pos.character);
  assert.equal(water.range.end.character, pos.character);
});

test("prefix-extended flags keep prefix filtering instead of append mode", async () => {
  const text =
    `<AssetDeclaration>\n  <ObjectFilter Include="CAN_ATTACK">\n  <Other/>\n</ObjectFilter>\n</AssetDeclaration>`;
  const line1 = text.split("\n")[1];
  const pos = new Position(1, line1.indexOf("CAN_ATTACK") + "CAN_ATTACK".length);

  const items = await provider.provideCompletionItems(makeDocument(text), pos, token);
  const labels = items.map((i) => i.label);
  assert.ok(labels.includes("CAN_ATTACK_WALLS"));
  assert.ok(labels.includes("CAN_ATTACK_STEALTHED"));
  assert.ok(!labels.includes("WATER"));
  const walls = items.find((i) => i.label === "CAN_ATTACK_WALLS");
  assert.equal(walls.insertText, "CAN_ATTACK_WALLS");
  // The range replaces the typed token instead of inserting after it.
  assert.equal(walls.range.start.character, pos.character - "CAN_ATTACK".length);
  assert.equal(walls.range.end.character, pos.character);
});

test("multi-line unterminated Disposition value offers remaining flags", async () => {
  const text =
    `<AssetDeclaration>\n` +
    `  <ObjectCreationList id="OCL_CrateSpawn">\n` +
    `    <CreateObject\n` +
    `      Options="IGNORE_ALL_OBJECTS"\n` +
    `      Disposition="RANDOM_FORCE `;
  const line4 = text.split("\n")[4];
  const pos = new Position(4, line4.length);

  const items = await provider.provideCompletionItems(makeDocument(text), pos, token);
  const labels = items.map((i) => i.label);
  assert.ok(labels.includes("DISPOSITION_NONE"));
  assert.ok(labels.includes("FLOATING"));
  assert.ok(!labels.includes("RANDOM_FORCE"));
});

test("empty unterminated value offers all enum values", async () => {
  const text =
    `<AssetDeclaration>\n  <LocomotorTemplate id="x" Surfaces=">\n  <Other/>\n</LocomotorTemplate>\n</AssetDeclaration>`;
  const line1 = text.split("\n")[1];
  const pos = new Position(1, line1.indexOf('Surfaces="') + 'Surfaces="'.length);

  const items = await provider.provideCompletionItems(makeDocument(text), pos, token);
  const labels = items.map((i) => i.label);
  assert.equal(items.length, 11);
  assert.ok(labels.includes("GROUND"));
  assert.ok(labels.includes("WATER"));
  assert.ok(labels.includes("CRUSHABLE_WALL"));
});

test("enum completions work without an index", async () => {
  const text =
    `<AssetDeclaration>\n  <LocomotorTemplate id="x" Surfaces="G>\n  <Other/>\n</LocomotorTemplate>\n</AssetDeclaration>`;
  const line1 = text.split("\n")[1];
  const pos = new Position(1, line1.indexOf("G") + 1);

  const items = await providerNoIndex.provideCompletionItems(
    makeDocument(text),
    pos,
    token,
  );
  const labels = items.map((i) => i.label);
  assert.ok(labels.includes("GROUND"), "enum value offered without an index");
  assert.ok(!labels.includes("WATER"));
});

test("element and attribute name completions work without an index", async () => {
  const text = `<AssetDeclaration>\n  <LocomotorTemplate `;
  const line1 = text.split("\n")[1];
  const pos = new Position(1, line1.length);

  const items = await providerNoIndex.provideCompletionItems(
    makeDocument(text),
    pos,
    token,
  );
  const labels = items.map((i) => i.label);
  assert.ok(labels.includes("id"));
  assert.ok(labels.includes("Surfaces"));
});

test("attribute completion after a closed quote inserts a space", async () => {
  const text =
    `<AssetDeclaration>\n` +
    `  <ObjectCreationList id="OCL_CrateSpawn">\n` +
    `    <CreateObject Options="IGNORE_ALL_OBJECTS" Disposition="RANDOM_FORCE RELATIVE_ANGLE">`;
  const line2 = text.split("\n")[2];
  const pos = new Position(
    2,
    line2.indexOf('RELATIVE_ANGLE"') + 'RELATIVE_ANGLE"'.length,
  );

  const items = await provider.provideCompletionItems(makeDocument(text), pos, token);
  const count = items.find((i) => i.label === "Count");
  assert.ok(count, "Count is a valid next attribute");
  assert.equal(count.insertText.value, ' Count="1"');
  // The replacement range is empty at the cursor; the space comes from the
  // insert text so the attribute never glues to the closing quote.
  assert.equal(count.range.start.character, pos.character);
  assert.equal(count.range.end.character, pos.character);
});

test("attribute completion on one-per-line elements adds a newline", async () => {
  const text =
    `<AssetDeclaration>\n` +
    `  <ObjectCreationList id="OCL_CrateSpawn">\n` +
    `    <CreateObject\n` +
    `      Options="IGNORE_ALL_OBJECTS"\n` +
    `      Disposition="RANDOM_FORCE RELATIVE_ANGLE">`;
  const line4 = text.split("\n")[4];
  const pos = new Position(
    4,
    line4.indexOf('RELATIVE_ANGLE"') + 'RELATIVE_ANGLE"'.length,
  );

  const items = await provider.provideCompletionItems(makeDocument(text), pos, token);
  const count = items.find((i) => i.label === "Count");
  assert.ok(count);
  // The editor adds the new line's base indentation itself; embedding our
  // own indent here would be added on top of it and compound line by line.
  assert.equal(count.insertText.value, '\nCount="1"');
  assert.equal(count.range.start.character, pos.character);
  assert.equal(count.range.end.character, pos.character);
});

test("attribute completion on a new line aligns with the neighbor indent", async () => {
  const text =
    `<AssetDeclaration>\n` +
    `  <ObjectCreationList id="OCL_CrateSpawn">\n` +
    `    <CreateObject\n` +
    `      Options="IGNORE_ALL_OBJECTS"\n` +
    `      Disposition="RANDOM_FORCE RELATIVE_ANGLE"\n` +
    `      `;
  const pos = new Position(5, 6);

  const items = await provider.provideCompletionItems(makeDocument(text), pos, token);
  const count = items.find((i) => i.label === "Count");
  assert.ok(count);
  assert.equal(count.insertText.value, '      Count="1"');
  // The range replaces the whitespace already typed on the new line.
  assert.equal(count.range.start.character, 0);
  assert.equal(count.range.end.character, 6);
});

test("a half-typed attribute on a new line does not drive the indent", async () => {
  const text =
    `<AssetDeclaration>\n` +
    `  <ObjectCreationList id="OCL_CrateSpawn">\n` +
    `    <CreateObject\n` +
    `      Options="IGNORE_ALL_OBJECTS"\n` +
    `      Disposition="RANDOM_FORCE RELATIVE_ANGLE"\n` +
    `      Count="1"\n` +
    `                    C`;
  // The "C" line carries a large editor auto-indent (20 spaces) that must
  // NOT become the anchor for the completed attribute.
  const pos = new Position(6, 21);

  const items = await provider.provideCompletionItems(makeDocument(text), pos, token);
  const createFX = items.find((i) => i.label === "CreateFX");
  assert.ok(createFX);
  assert.equal(createFX.insertText.value, '      CreateFX="$1"');
  // The range covers the auto-indented whitespace and the typed "C".
  assert.equal(createFX.range.start.character, 0);
  assert.equal(createFX.range.end.character, 21);
});

test("whitespace used to trigger the popup is consumed on newline insert", async () => {
  const text =
    `<AssetDeclaration>\n` +
    `  <ObjectCreationList id="OCL_CrateSpawn">\n` +
    `    <CreateObject\n` +
    `      Options="IGNORE_ALL_OBJECTS"\n` +
    `      Disposition="RANDOM_FORCE RELATIVE_ANGLE" >`;
  const line4 = text.split("\n")[4];
  const pos = new Position(
    4,
    line4.indexOf('RELATIVE_ANGLE" ') + 'RELATIVE_ANGLE" '.length,
  );

  const items = await provider.provideCompletionItems(makeDocument(text), pos, token);
  const count = items.find((i) => i.label === "Count");
  assert.ok(count);
  assert.equal(count.insertText.value, '\nCount="1"');
  // The range starts at the previous attribute's closing quote, so the
  // typed space is replaced by the newline instead of lingering.
  assert.equal(count.range.start.character, pos.character - 1);
  assert.equal(count.range.end.character, pos.character);
});

test("scalar attributes get typed default values, suggestion attributes keep $1", async () => {
  const text =
    `<AssetDeclaration>\n` +
    `  <ObjectCreationList id="OCL_CrateSpawn">\n` +
    `    <CreateObject `;
  const pos = new Position(2, text.split("\n")[2].length);

  const items = await provider.provideCompletionItems(makeDocument(text), pos, token);
  const item = (label) => items.find((i) => i.label === label);

  // XSD default wins.
  assert.equal(item("Count").insertText.value, 'Count="1"');
  // Type-based examples for scalars without an XSD default.
  assert.equal(item("FadeTime").insertText.value, 'FadeTime="0s"');
  assert.equal(item("DispositionAngle").insertText.value, 'DispositionAngle="0d"');
  // Suggestion-driven values keep the $1 placeholder and re-trigger suggest.
  assert.equal(item("CreateFX").insertText.value, 'CreateFX="$1"');
  assert.ok(item("CreateFX").command, "reference values re-trigger suggest");
  assert.equal(item("Options").insertText.value, 'Options="$1"');
  assert.ok(item("Options").command, "list values re-trigger suggest");
  assert.equal(item("DisabledWhileBusy").insertText.value, 'DisabledWhileBusy="$1"');
  assert.ok(item("DisabledWhileBusy").command, "boolean values re-trigger suggest");
  // Concrete defaults do not pop an empty suggest widget.
  assert.equal(item("Count").command, undefined);
});

test("content (child element) completions work without an index", async () => {
  const text =
    `<AssetDeclaration>\n  <LocomotorTemplate id="x">\n    \n  </LocomotorTemplate>\n</AssetDeclaration>`;
  const pos = new Position(2, 4);

  const items = await providerNoIndex.provideCompletionItems(
    makeDocument(text),
    pos,
    token,
  );
  const labels = items.map((i) => i.label);
  assert.ok(labels.length > 0, "child elements offered without an index");
});

test("Poid attributes offer ids from the enclosing GameObject's local scope", async () => {
  const text =
    `<AssetDeclaration>\n` +
    `  <GameObject id="Tank">\n` +
    `    <Draws>\n` +
    `      <TruckDraw id="ModuleTag_Draw" />\n` +
    `    </Draws>\n` +
    `    <BehaviorModules>\n` +
    `      <ReconstituteStateSpecialAbility UpdateModuleId="ModuleTag_D">\n` +
    `    </BehaviorModules>\n` +
    `  </GameObject>\n` +
    `</AssetDeclaration>`;
  const line6 = text.split("\n")[6];
  const pos = new Position(6, line6.indexOf("ModuleTag_D") + "ModuleTag_D".length);

  const items = await provider.provideCompletionItems(makeDocument(text), pos, token);
  const labels = items.map((i) => i.label);
  assert.ok(labels.includes("ModuleTag_Draw"));
  assert.ok(items.every((i) => i.kind === CompletionItemKind.Value));
  assert.ok(
    items.every((i) => i.detail === "local module"),
    "Poid completions are labelled as local-scope ids",
  );
});
