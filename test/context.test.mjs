import { test } from "node:test";
import assert from "node:assert/strict";
import { parseXml } from "../out/language/xmlParser.js";
import { analyzeContext, splitListValuePrefix } from "../out/language/context.js";

test("unterminated quote is still an attribute-value context", () => {
  const text = `<Locomotor id="x" Surfaces="GROUND>\n  <Other/>\n</Locomotor>`;
  const cursor = text.indexOf("GROUND") + 6;
  const doc = parseXml(text);
  const ctx = analyzeContext(doc, text, cursor);
  assert.equal(ctx.kind, "attribute-value");
  assert.equal(ctx.attr?.name, "Surfaces");
  assert.equal(ctx.valuePrefix, "GROUND");
  assert.equal(ctx.element?.name, "Locomotor");
});

test("empty unterminated value keeps attribute-value context", () => {
  const text = `<Locomotor id="x" Surfaces="\n</Locomotor>`;
  const cursor = text.indexOf('Surfaces="') + 'Surfaces="'.length;
  const doc = parseXml(text);
  const ctx = analyzeContext(doc, text, cursor);
  assert.equal(ctx.kind, "attribute-value");
  assert.equal(ctx.attr?.name, "Surfaces");
  assert.equal(ctx.valuePrefix, "");
});

test("closed quote still resolves value context", () => {
  const text = `<Locomotor id="x" Surfaces="GROUND">\n</Locomotor>`;
  const cursor = text.indexOf("GROUND") + 6;
  const doc = parseXml(text);
  const ctx = analyzeContext(doc, text, cursor);
  assert.equal(ctx.kind, "attribute-value");
  assert.equal(ctx.attr?.name, "Surfaces");
  assert.equal(ctx.valuePrefix, "GROUND");
});

test("splitListValuePrefix isolates the token being edited", () => {
  assert.deepEqual(splitListValuePrefix("GROUND WA"), { token: "WA", start: 7 });
  assert.deepEqual(splitListValuePrefix("GROUND "), { token: "", start: 7 });
  assert.deepEqual(splitListValuePrefix("WA"), { token: "WA", start: 0 });
  assert.deepEqual(splitListValuePrefix(""), { token: "", start: 0 });
});
