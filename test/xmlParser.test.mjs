import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseXml,
  findElementAt,
  stripBom,
  textContentTokenAt,
} from "../out/language/xmlParser.js";

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

test("findElementAt treats a completed element's end as exclusive", () => {
  const text = `<A><B>X</B></A>`;
  const doc = parseXml(text);
  const b = doc.elements.find((e) => e.name === "B");
  const at = findElementAt(doc, b.end);
  assert.equal(at?.name, "A", "cursor after </B> belongs to the parent");

  const self = `<A><B/></A>`;
  const selfDoc = parseXml(self);
  const b2 = selfDoc.elements.find((e) => e.name === "B");
  const atSelf = findElementAt(selfDoc, b2.end);
  assert.equal(atSelf?.name, "A", "cursor after <B/> belongs to the parent");
});

test("findElementAt still includes EOF inside an unclosed element", () => {
  const text = `<A><B>C`;
  const doc = parseXml(text);
  const b = doc.elements.find((e) => e.name === "B");
  assert.equal(findElementAt(doc, text.length)?.name, "B");
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

test("textContentTokenAt returns the token inside element content", () => {
  const text =
    `<AssetDeclaration>` +
    `<CreateObject>  CrateDebris_01  </CreateObject>` +
    `</AssetDeclaration>`;
  const doc = parseXml(text);
  const el = doc.elements.find((e) => e.name === "CreateObject");
  const tokenStart = text.indexOf("Crate");
  const cursor = tokenStart + 3;
  const token = textContentTokenAt(text, el, cursor);
  assert.deepEqual(token, {
    value: "CrateDebris_01",
    start: tokenStart,
    end: tokenStart + "CrateDebris_01".length,
  });
  // The start tag, closing tag and whitespace-only content are not tokens.
  assert.equal(textContentTokenAt(text, el, el.start + 1), null);
  assert.equal(textContentTokenAt(text, el, text.indexOf("</CreateObject") + 1), null);
  const empty = `<A><B/></A><C>   </C>`;
  const c = parseXml(empty).elements.find((e) => e.name === "C");
  assert.equal(textContentTokenAt(empty, c, c.startTagEnd + 1), null);
});

test("textContentTokenAt works before the closing tag is typed", () => {
  const text = `<A><B>C`;
  const doc = parseXml(text);
  const b = doc.elements.find((e) => e.name === "B");
  assert.ok(b);
  assert.equal(b.closeTagStart, -1);
  const token = textContentTokenAt(text, b, text.length);
  assert.deepEqual(token, {
    value: "C",
    start: text.indexOf("C"),
    end: text.length,
  });
});

test("a typed < in content followed by a closing tag does not swallow it", () => {
  // In a real file the "<" the user just typed is followed by
  // "</CreateObject>" on the next line. The parser must NOT treat that
  // closing tag's ">" as the end of the malformed start tag (which would
  // create a bogus empty-name element and break content completion).
  const text =
    `<AssetDeclaration>` +
    `<ObjectCreationList>` +
    `<CreateObject>\n\t<Offset/>\n\t<\n</CreateObject>` +
    `</ObjectCreationList>` +
    `</AssetDeclaration>`;
  const doc = parseXml(text);
  assert.ok(doc.errors.some((e) => /Unterminated start tag/.test(e.message)));
  assert.ok(!doc.elements.some((e) => e.name === ""), "no bogus empty-name element");
  const co = doc.elements.find((e) => e.name === "CreateObject");
  assert.ok(co, "outer CreateObject still parsed");
  assert.equal(co.end, text.indexOf("</CreateObject>") + "</CreateObject>".length);
});

test("a partial child name in content is recovered, not glued to the closing tag", () => {
  const text = `<A><B>\n\t<Cr\n</B></A>`;
  const doc = parseXml(text);
  const cr = doc.elements.find((e) => e.name === "Cr");
  assert.ok(cr, "partial name is recovered as an element shell");
  assert.equal(cr.recoveredStartTag, true);
  // The mismatched closing tag later closes the recovered shell (parser
  // recovery), so the element stays a valid container for completion.
  assert.equal(cr.closeTagStart, text.indexOf("</B>"));
  assert.ok(cr.end > cr.startTagEnd);
  const b = doc.elements.find((e) => e.name === "B");
  assert.equal(b.end, text.length);
});
