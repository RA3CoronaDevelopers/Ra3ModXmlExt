import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Minimal vscode shim so the compiled semantic tokens provider can run under
// plain node. Only the APIs used by the provider call path are implemented.
class Range {
  constructor(startLine, startCharacter, endLine, endCharacter) {
    this.start = { line: startLine, character: startCharacter };
    this.end = { line: endLine, character: endCharacter };
  }
}

class SemanticTokensLegend {
  constructor(tokenTypes) {
    this.tokenTypes = tokenTypes;
  }
}

class SemanticTokens {
  constructor(data) {
    this.data = data;
  }
}

class SemanticTokensBuilder {
  constructor(legend) {
    this.legend = legend;
    this.pushed = [];
  }
  push(range, tokenType) {
    this.pushed.push({ range, tokenType });
  }
  build() {
    return new SemanticTokens(new Uint32Array(this.pushed.length * 5));
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
    SemanticTokens,
    SemanticTokensBuilder,
    SemanticTokensLegend,
  },
};

const { parseXml } = require("../out/language/xmlParser.js");
const { buildSemanticTokenRanges } = require("../out/language/semanticTokens.js");
const { Ra3SemanticTokensProvider } = require("../out/features/semanticTokens.js");

function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function sliceAt(text, token) {
  const starts = lineStartsOf(text);
  const offset = starts[token.line] + token.startChar;
  return text.slice(offset, offset + token.length);
}

function makeDocument(text) {
  const lineStarts = lineStartsOf(text);
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
      return { line: lo, character: offset - lineStarts[lo] };
    },
  };
}

const MALFORMED =
  `<AssetDeclaration>\n  <LocomotorTemplate id="x" Surfaces="GROUND>\n  <Other/>\n</LocomotorTemplate>\n</AssetDeclaration>`;

test("fallback tokens cover names, attributes and values", () => {
  const doc = parseXml(MALFORMED);
  assert.ok(doc.errors.length > 0);
  const tokens = buildSemanticTokenRanges(doc, MALFORMED);

  // Element names (opening and closing tags).
  assert.ok(tokens.some((t) => t.tokenType === "type" && sliceAt(MALFORMED, t) === "AssetDeclaration"));
  assert.ok(tokens.some((t) => t.tokenType === "type" && sliceAt(MALFORMED, t) === "LocomotorTemplate"));
  assert.ok(tokens.some((t) => t.tokenType === "type" && sliceAt(MALFORMED, t) === "Other"));
  assert.ok(
    tokens.some(
      (t) => t.tokenType === "type" && sliceAt(MALFORMED, t) === "LocomotorTemplate" && t.line === 3,
    ),
  );

  // Attribute names.
  assert.ok(tokens.some((t) => t.tokenType === "property" && sliceAt(MALFORMED, t) === "Surfaces"));
  assert.ok(tokens.some((t) => t.tokenType === "property" && sliceAt(MALFORMED, t) === "id"));

  // Attribute values: closed quotes include both quotes; the unterminated
  // Surfaces value keeps the opening quote and everything up to the recovered
  // line end (the `>` is still inside the unclosed string).
  const strings = tokens.filter((t) => t.tokenType === "string").map((t) => sliceAt(MALFORMED, t));
  assert.ok(strings.includes('"x"'));
  assert.ok(strings.includes('"GROUND>'));

  // Tokens are sorted by position for the vscode encoder.
  for (let i = 1; i < tokens.length; i++) {
    const a = tokens[i - 1];
    const b = tokens[i];
    assert.ok(a.line < b.line || (a.line === b.line && a.startChar <= b.startChar));
  }
});

test("well-formed XML gets no semantic fallback tokens", async () => {
  const text = `<AssetDeclaration>\n  <LocomotorTemplate id="x" Surfaces="GROUND"/>\n</AssetDeclaration>`;
  const provider = new Ra3SemanticTokensProvider();
  const result = await provider.provideDocumentSemanticTokens(makeDocument(text), {});
  assert.equal(result.data.length, 0);
});

test("malformed XML gets semantic fallback tokens", async () => {
  const provider = new Ra3SemanticTokensProvider();
  const result = await provider.provideDocumentSemanticTokens(
    makeDocument(MALFORMED),
    {},
  );
  assert.ok(result.data.length > 0);
});
