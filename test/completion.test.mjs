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

// Enum completions do not consult the index, but provideCompletionItems only
// routes value contexts when the workspace index is present.
const provider = new Ra3CompletionProvider({ index: {} });
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
