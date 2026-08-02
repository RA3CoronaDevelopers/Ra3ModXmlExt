import { test } from "node:test";
import assert from "node:assert/strict";
import { scanXmlShallow } from "../out/indexer/shallowScan.js";

test("extracts top-level assets, includes, defines and xi:include", () => {
  const text = `<?xml version="1.0"?>
<AssetDeclaration xmlns="uri:ea.com:eala:asset">
  <Defines>
    <Define name="MODEL_SCALE" value="1.0"/>
  </Defines>
  <Includes>
    <Include type="all" source="Art/Model_SKN.w3x"/>
    <Include type="reference" source="DATA:static.xml"/>
  </Includes>
  <W3DContainer id="Model_SKN" Hierarchy="Model_SKL">
    <SubObject SubObjectID="GUN">
      <RenderObject><Mesh>Model_SKN.GUN</Mesh></RenderObject>
    </SubObject>
  </W3DContainer>
  <W3DMesh id="Model_SKN.GUN"/>
  <xi:include href="DATA:Includes/Extra.xml" xpointer="xmlns(n=uri:ea.com:eala:asset) xpointer(/n:Extra/child::*)"/>
</AssetDeclaration>`;
  const doc = scanXmlShallow(text);
  assert.equal(doc.errors.length, 0);
  assert.deepEqual(
    doc.assets.map((a) => `${a.name}:${a.id}`),
    ["W3DContainer:Model_SKN", "W3DMesh:Model_SKN.GUN"],
  );
  assert.equal(doc.includes.length, 2);
  assert.equal(doc.includes[0].type, "all");
  assert.equal(doc.includes[0].source, "Art/Model_SKN.w3x");
  assert.equal(doc.includes[1].type, "reference");
  assert.equal(doc.defines.length, 1);
  assert.equal(doc.defines[0].name, "MODEL_SCALE");
  assert.equal(doc.defines[0].value, "1.0");
  assert.equal(doc.rootXiIncludes.length, 1);
  assert.equal(doc.rootXiIncludes[0].href, "DATA:Includes/Extra.xml");
  assert.match(doc.rootXiIncludes[0].xpointer, /xpointer\(/);
  assert.equal(doc.nestedXiIncludes.length, 0);

  // Recorded offsets must slice the original text back out.
  const container = doc.assets[0];
  assert.equal(text.slice(container.idValueStart, container.idValueEnd), "Model_SKN");
  assert.equal(text.slice(container.start, container.startTagEnd).startsWith("<W3DContainer"), true);
  const mesh = doc.assets[1];
  assert.equal(text.slice(mesh.idValueStart, mesh.idValueEnd), "Model_SKN.GUN");
});

test("handles > and / inside quoted values, self-closing tags and comments", () => {
  const text = `<?xml version="1.0"?>
<!-- a > comment with < inside -->
<AssetDeclaration xmlns="uri:ea.com:eala:asset">
  <W3DContainer id="Weird" Description="a > b < c" />
  <W3DMesh id="X" VertexData="a / b"/>
</AssetDeclaration>`;
  const doc = scanXmlShallow(text);
  assert.equal(doc.errors.length, 0);
  assert.deepEqual(
    doc.assets.map((a) => a.id),
    ["Weird", "X"],
  );
});

test("skips CDATA and processing instructions", () => {
  const text = `<AssetDeclaration>
  <!-- <W3DMesh id="FAKE"/> -->
  <![CDATA[ <W3DMesh id="FAKE2"/> ]]>
  <?xml-stylesheet href="x"?>
  <W3DContainer id="REAL"/>
</AssetDeclaration>`;
  const doc = scanXmlShallow(text);
  assert.equal(doc.errors.length, 0);
  assert.deepEqual(
    doc.assets.map((a) => a.id),
    ["REAL"],
  );
});

test("reports unterminated tags and keeps partial results", () => {
  const doc = scanXmlShallow('<AssetDeclaration><W3DMesh id="A"/><W3DMesh id="B"');
  assert.ok(doc.errors.length >= 1);
  assert.deepEqual(
    doc.assets.map((a) => a.id),
    ["A"],
  );
});

test("nested module payload does not create asset records", () => {
  // Only top-level elements with an id are assets; the hundreds of thousands
  // of numeric V/T elements inside a mesh are not.
  const doc = scanXmlShallow(`<AssetDeclaration>
  <W3DMesh id="MESH">
    <Vertices><V X="1" Y="2" Z="3"/><V X="4" Y="5" Z="6"/></Vertices>
    <Triangles><T A="0" B="1" C="2"/></Triangles>
  </W3DMesh>
</AssetDeclaration>`);
  assert.deepEqual(
    doc.assets.map((a) => a.id),
    ["MESH"],
  );
});

test("distinguishes root-level and nested xi:include", () => {
  const doc = scanXmlShallow(`<AssetDeclaration>
  <xi:include href="DATA:Top.xml"/>
  <W3DMesh id="MESH">
    <SubObject>
      <RenderObject>
        <xi:include href="DATA:Nested.xml" xpointer="xmlns(n=uri:ea.com:eala:asset) xpointer(/n:X/child::*)"/>
      </RenderObject>
    </SubObject>
  </W3DMesh>
</AssetDeclaration>`);
  assert.deepEqual(
    doc.rootXiIncludes.map((x) => x.href),
    ["DATA:Top.xml"],
  );
  assert.deepEqual(
    doc.nestedXiIncludes.map((x) => x.href),
    ["DATA:Nested.xml"],
  );
});
