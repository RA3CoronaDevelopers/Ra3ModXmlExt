import { test } from "node:test";
import assert from "node:assert/strict";
import { parseXml, LineMap } from "../out/language/xmlParser.js";
import { extractIndexRecords, recordsFromShallow } from "../out/indexer/records.js";
import { scanXmlShallow } from "../out/indexer/shallowScan.js";

test("extractIndexRecords mirrors the walk semantics", () => {
  const text = `<?xml version="1.0"?>
<AssetDeclaration>
  <Defines>
    <Define name="HP" value="100"/>
  </Defines>
  <Includes>
    <Include type="all" source="Units.xml"/>
    <Include type="instance" source="Base.xml"/>
  </Includes>
  <GameObject id="Tank" CommandSet="TankCommandSet"/>
  <WeaponTemplate id="TankGun"/>
  <xi:include href="DATA:Extra.xml" xpointer="xmlns(n=uri:ea.com:eala:asset) xpointer(/n:Extra/child::*)"/>
  <GameObject id="Tank2">
    <Draws>
      <xi:include href="DATA:Nested.xml"/>
    </Draws>
  </GameObject>
</AssetDeclaration>`;
  const lineMap = new LineMap(text);
  const records = extractIndexRecords(parseXml(text), lineMap, text);
  assert.deepEqual(
    records.assets.map((a) => [a.type, a.id, a.line]),
    [
      ["GameObject", "Tank", 10],
      ["WeaponTemplate", "TankGun", 11],
      ["GameObject", "Tank2", 13],
    ],
  );
  assert.deepEqual(
    records.defines.map((d) => [d.name, d.value]),
    [["HP", "100"]],
  );
  assert.deepEqual(
    records.includes.map((i) => [i.type, i.source]),
    [
      ["all", "Units.xml"],
      ["instance", "Base.xml"],
    ],
  );
  assert.deepEqual(
    records.rootXiIncludes.map((x) => [x.href, x.line]),
    [["DATA:Extra.xml", 12]],
  );
  assert.deepEqual(
    records.nestedXiIncludes.map((x) => [x.href, x.line]),
    [["DATA:Nested.xml", 15]],
  );
});

test("recordsFromShallow converts offsets to 1-based lines", () => {
  const text = `<AssetDeclaration>\n  <W3DContainer id="A"/>\n</AssetDeclaration>`;
  const lineMap = new LineMap(text);
  const records = recordsFromShallow(scanXmlShallow(text), lineMap);
  assert.equal(records.assets.length, 1);
  assert.equal(records.assets[0].type, "W3DContainer");
  assert.equal(records.assets[0].id, "A");
  assert.equal(records.assets[0].line, 2);
  assert.deepEqual(records.references, []);
});

test("extractIndexRecords records typed references and skips non-references", () => {
  const text = `<AssetDeclaration>
  <GameObject id="Tank" CommandSet="CS" inheritFrom="Base" KindOf="SELECTABLE"/>
  <ObjectCreationList id="OCL">
    <CreateObject>
      <CreateObject>Tank</CreateObject>
    </CreateObject>
  </ObjectCreationList>
  <CameraSettings id="S"/>
</AssetDeclaration>`;
  const lineMap = new LineMap(text);
  const records = extractIndexRecords(parseXml(text), lineMap, text);

  const attrs = records.references.filter((r) => r.kind === "attr");
  const content = records.references.filter((r) => r.kind === "content");

  // Typed attribute reference keeps the XSD refType.
  const cs = attrs.find((r) => r.value === "CS");
  assert.ok(cs, "CommandSet reference is recorded");
  assert.equal(cs.refType, "LogicCommandSet");
  assert.equal(cs.selfType, null);
  assert.equal(cs.line, 2);
  assert.equal(records.references.some((r) => r.start === cs.start && r.end === cs.end), true);

  // inheritFrom records the element type as selfType instead of refType.
  const base = attrs.find((r) => r.value === "Base");
  assert.ok(base, "inheritFrom reference is recorded");
  assert.equal(base.refType, null);
  assert.equal(base.selfType, "GameObject");

  // Enums and non-reference values are not references.
  assert.equal(attrs.some((r) => r.value === "SELECTABLE"), false);

  // Simple-content text is recorded with its content refType and offsets.
  const tank = content.find((r) => r.value === "Tank");
  assert.ok(tank, "content reference is recorded");
  assert.equal(tank.refType, "GameObject");
  const line = text.split("\n")[4];
  assert.equal(line.slice(tank.start - text.indexOf(line), tank.end - text.indexOf(line)), "Tank");

  // The id definition itself is never recorded as a reference.
  assert.equal(
    records.references.some(
      (r) => r.value === "Tank" && r.kind === "attr",
    ),
    false,
  );
});
