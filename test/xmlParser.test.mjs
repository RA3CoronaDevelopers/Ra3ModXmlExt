import { test } from "node:test";
import assert from "node:assert/strict";
import { parseXml, findElementAt } from "../out/language/xmlParser.js";

test("parses elements, attributes and positions", () => {
  const text = `<AssetDeclaration xmlns="uri:ea.com:eala:asset">\n\t<GameObject id="X" KindOf="A B"/>\n</AssetDeclaration>`;
  const doc = parseXml(text);
  assert.equal(doc.errors.length, 0);
  assert.equal(doc.root.name, "AssetDeclaration");
  const go = doc.root.children[0];
  assert.equal(go.name, "GameObject");
  assert.equal(go.selfClosing, true);
  assert.equal(go.attrs.length, 2);
  assert.equal(go.attrs[0].name, "id");
  assert.equal(go.attrs[0].value, "X");
  assert.equal(go.attrs[1].value, "A B");
  const idAttr = go.attrs[0];
  assert.equal(text.slice(idAttr.valueStart, idAttr.valueEnd), "X");
});

test("detects mismatched and unclosed tags", () => {
  const doc = parseXml("<A><B></A>");
  assert.ok(doc.errors.length >= 1);
  assert.match(doc.errors[0].message, /Mismatched|never closed/);
});

test("handles CRLF and comments", () => {
  const text = "<?xml version=\"1.0\"?>\r\n<!-- hello -->\r\n<AssetDeclaration>\r\n</AssetDeclaration>\r\n";
  const doc = parseXml(text);
  assert.equal(doc.errors.length, 0);
  assert.equal(doc.root.name, "AssetDeclaration");
});

test("findElementAt returns innermost element", () => {
  const text = `<A><B id="1"><C/></B></A>`;
  const doc = parseXml(text);
  const c = doc.elements.find((e) => e.name === "C");
  const at = findElementAt(doc, c.start + 1);
  assert.equal(at.name, "C");
});

test("tolerates partial input while typing", () => {
  const text = `<AssetDeclaration>\n\t<GameObject id="TestTank" Com`;
  const doc = parseXml(text);
  assert.ok(doc.errors.length >= 1); // unclosed
  assert.equal(doc.elements.length, 2);
});
