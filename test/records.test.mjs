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
  const records = extractIndexRecords(parseXml(text), lineMap);
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
});
