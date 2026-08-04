import { test } from "node:test";
import assert from "node:assert/strict";
import { parseXml, findElementAt, stripBom } from "../out/language/xmlParser.js";

test("stripBom removes a leading UTF-8 byte-order mark", () => {
  assert.equal(stripBom("\uFEFF<A/>"), "<A/>");
  assert.equal(stripBom("<A/>"), "<A/>");
});

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

test("recovers from an unterminated attribute value at end of line", () => {
  // Typing an attribute value quote without its closing quote makes the tag
  // malformed; the parser must stop the broken start tag at the line break so
  // the rest of the document (and completion for it) keeps working.
  const text = `<AssetDeclaration>\n  <A x="1" y="abc\n  <B/>\n  </A>\n</AssetDeclaration>`;
  const doc = parseXml(text);
  assert.ok(doc.errors.some((e) => e.message === "Unterminated start tag"));
  assert.deepEqual(doc.elements.map((e) => e.name), ["AssetDeclaration", "A", "B"]);
  const a = doc.elements.find((e) => e.name === "A");
  const y = a.attrs.find((at) => at.name === "y");
  assert.equal(y.quoteEnd, -1);
  assert.equal(text.slice(y.valueStart, y.valueEnd), "abc");
  const b = doc.elements.find((e) => e.name === "B");
  assert.ok(b.start > a.start);
});

test("marks recovered start tags for partial completion re-parsing", () => {
  const text = `<AssetDeclaration>\n  <A x="1" y="abc\n  <B/>\n  </A>\n</AssetDeclaration>`;
  const doc = parseXml(text);
  const a = doc.elements.find((e) => e.name === "A");
  assert.equal(a.recoveredStartTag, true);
  // Well-formed elements parsed normally do not carry the marker.
  const b = doc.elements.find((e) => e.name === "B");
  assert.equal(b.recoveredStartTag, undefined);
});

test("reports an unterminated attribute value at EOF", () => {
  const text = `<A x="abc`;
  const doc = parseXml(text);
  assert.ok(doc.errors.some((e) => /Unterminated start tag/.test(e.message)));
  assert.equal(doc.elements.length, 1);
  const a = doc.elements[0];
  assert.equal(a.attrs[0].value, "abc");
  assert.equal(a.attrs[0].quoteEnd, -1);
});
