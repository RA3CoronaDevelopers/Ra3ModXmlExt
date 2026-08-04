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

test("multi-line unterminated quote keeps attribute-value context", () => {
  const text =
    `<AssetDeclaration>\n` +
    `  <ObjectCreationList id="OCL_CrateSpawn">\n` +
    `    <CreateObject\n` +
    `      Options="IGNORE_ALL_OBJECTS"\n` +
    `      Disposition="`;
  const cursor = text.length;
  const doc = parseXml(text);
  const ctx = analyzeContext(doc, text, cursor);
  assert.equal(ctx.kind, "attribute-value");
  assert.equal(ctx.attr?.name, "Disposition");
  assert.equal(ctx.valuePrefix, "");
  assert.equal(ctx.element?.name, "CreateObject");
});

test("multi-line unterminated value prefix includes typed flags", () => {
  const text =
    `<AssetDeclaration>\n` +
    `  <ObjectCreationList id="OCL_CrateSpawn">\n` +
    `    <CreateObject\n` +
    `      Options="IGNORE_ALL_OBJECTS"\n` +
    `      Disposition="RANDOM_FORCE `;
  const cursor = text.length;
  const doc = parseXml(text);
  const ctx = analyzeContext(doc, text, cursor);
  assert.equal(ctx.kind, "attribute-value");
  assert.equal(ctx.attr?.name, "Disposition");
  assert.equal(ctx.valuePrefix, "RANDOM_FORCE ");
});

test("cursor after a closed quote is an attribute-name context", () => {
  const text = `<Locomotor id="x" Surfaces="GROUND">\n</Locomotor>`;
  const cursor = text.indexOf('GROUND"') + 'GROUND"'.length;
  const doc = parseXml(text);
  const ctx = analyzeContext(doc, text, cursor);
  assert.equal(ctx.kind, "attribute-name");
  assert.equal(ctx.attr, null);
});

test("cursor exactly after an opening tag with a closing tag is content", () => {
  const text = `<CreateObject></CreateObject>`;
  const cursor = text.indexOf(">") + 1;
  const doc = parseXml(text);
  const ctx = analyzeContext(doc, text, cursor);
  assert.equal(ctx.kind, "content");
  assert.equal(ctx.element?.name, "CreateObject");
});

test("cursor after a typed > but before the closing tag is content too", () => {
  const text = `<CreateObject>`;
  const cursor = text.length;
  const doc = parseXml(text);
  const ctx = analyzeContext(doc, text, cursor);
  assert.equal(ctx.kind, "content");
  assert.equal(ctx.element?.name, "CreateObject");
});

test("cursor after a closed child element belongs to the parent content", () => {
  const text =
    `<AssetDeclaration>` +
    `<ObjectCreationList>` +
    `<CreateObject>X</CreateObject>` +
    `</ObjectCreationList>` +
    `</AssetDeclaration>`;
  const cursor = text.indexOf("</CreateObject>") + "</CreateObject>".length;
  const doc = parseXml(text);
  const ctx = analyzeContext(doc, text, cursor);
  assert.equal(ctx.kind, "content");
  assert.equal(ctx.element?.name, "ObjectCreationList");
});

test("splitListValuePrefix isolates the token being edited", () => {
  assert.deepEqual(splitListValuePrefix("GROUND WA"), { token: "WA", start: 7 });
  assert.deepEqual(splitListValuePrefix("GROUND "), { token: "", start: 7 });
  assert.deepEqual(splitListValuePrefix("WA"), { token: "WA", start: 0 });
  assert.deepEqual(splitListValuePrefix(""), { token: "", start: 0 });
});
