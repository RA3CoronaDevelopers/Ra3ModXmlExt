import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ModIndexer } from "../out/indexer/indexer.js";
import { CachedDirectoryWalker } from "../out/indexer/fileScanner.js";
import {
  isLocalReferenceAttribute,
  isReferenceAttribute,
  isReferenceAttributeOfType,
  resolveReferenceTargets,
  resolveReferenceTargetsForType,
} from "../out/indexer/refs.js";
import { parseXml } from "../out/language/xmlParser.js";
import { resolveElementType } from "../out/language/typeContext.js";
import * as model from "../out/model/schemaModel.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const project = join(root, "test", "fixtures", "minimod");
const sdk = join(root, "test", "fixtures", "fakesdk");

async function buildIndex() {
  const indexer = new ModIndexer({
    projectDir: project,
    sdkDir: sdk,
    builtmodsDirs: [join(sdk, "builtmods")],
    indexSageXml: true,
    additionalDataSearchPaths: [],
    walker: new CachedDirectoryWalker(),
  });
  return indexer.build();
}

test("definition resolution filters by the attribute's ref type", async () => {
  const idx = await buildIndex();
  const defs = idx.assetsById.get("sharedthing");
  assert.equal(defs.length, 2);
  const types = defs.map((d) => d.type).sort();
  assert.deepEqual(types, ["GameObject", "WeaponTemplate"]);

  // WeaponName="SharedThing" on a WeaponTemplateRef attribute must only resolve
  // to the WeaponTemplate definition.
  const targets = resolveReferenceTargets(idx, "FireWeaponNugget", "WeaponName", "SharedThing");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].def.type, "WeaponTemplate");
  assert.match(targets[0].def.file, /Refs\.xml/);

  // A non-reference attribute must never resolve anything.
  const none = resolveReferenceTargets(idx, "FireWeaponNugget", "EditorName", "SharedThing");
  assert.equal(none.length, 0);

  // inheritFrom filters to types assignable to the element itself.
  const inherit = resolveReferenceTargets(idx, "GameObject", "inheritFrom", "SharedThing");
  assert.equal(inherit.length, 1);
  assert.equal(inherit[0].def.type, "GameObject");
});

test("the model knows a real WeaponTemplateRef attribute pair", () => {
  const attrs = model.attributesOfElement("FireWeaponNugget");
  const weapon = attrs.find((a) => a.name === "WeaponName");
  assert.equal(weapon?.refType, "WeaponTemplate");
});

test("isReferenceAttribute distinguishes references from enums/paths", () => {
  // Include/@type and Include/@source must never be treated as references.
  assert.equal(isReferenceAttribute("Include", "type"), false);
  assert.equal(isReferenceAttribute("Include", "source"), false);
  // Typed references and inheritFrom are references.
  assert.equal(isReferenceAttribute("GameObject", "CommandSet"), true);
  assert.equal(isReferenceAttribute("GameObject", "inheritFrom"), true);
  assert.equal(isReferenceAttribute("FireWeaponNugget", "WeaponName"), true);
});

test("attribute-level xas:refType is preserved in the model", () => {
  // <xs:attribute name="Locomotor" type="AssetReference"
  //                xas:refType="LocomotorTemplate" /> — the refType lives on
  // the attribute node, not on the AssetReference simple type.
  assert.equal(
    model.attributesOfElement("LocomotorSet").find((a) => a.name === "Locomotor")?.refType,
    "LocomotorTemplate",
  );
  assert.equal(
    model.attributesOfElement("ArmorSet").find((a) => a.name === "Armor")?.refType,
    "ArmorTemplate",
  );
});

test("typed Locomotor references resolve only to LocomotorTemplate defs", () => {
  const idx = {
    assetsById: new Map([
      [
        "alliedantivehiclevehicletech1locomotor",
        [
          {
            type: "LocomotorTemplate",
            id: "AlliedAntiVehicleVehicleTech1Locomotor",
            file: "Locomotor.xml",
            line: 5,
            origin: "project",
          },
          {
            // Same id under a different type must NOT satisfy the reference.
            type: "GameObject",
            id: "AlliedAntiVehicleVehicleTech1Locomotor",
            file: "GameObject.xml",
            line: 1,
            origin: "project",
          },
        ],
      ],
    ]),
    assets: new Map(),
    projectDir: ".",
    sdkDir: ".",
    defines: new Map(),
    files: new Map(),
    streams: [],
    manifests: new Map(),
    sourceCandidates: [],
    diagnostics: [],
    stats: {},
  };
  assert.equal(isReferenceAttribute("LocomotorSet", "Locomotor"), true);
  const targets = resolveReferenceTargets(idx, "LocomotorSet", "Locomotor", "AlliedAntiVehicleVehicleTech1Locomotor");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].def.type, "LocomotorTemplate");
  // A non-reference attribute still returns nothing.
  assert.equal(resolveReferenceTargets(idx, "LocomotorSet", "EditorName", "X").length, 0);
});

test("module ids declare the element itself and are never global references", () => {
  // The exact reported scenario: <TruckDraw id="ModuleTag_Draw"/> inside a
  // GameObject. ModuleData@id carries xas:refType="ModuleData", which is the
  // element's own base type -> a definition site, not a reference.
  const xml = `
<AssetDeclaration>
  <GameObject id="GuardianTank">
    <Draws>
      <TruckDraw id="ModuleTag_Draw" />
    </Draws>
  </GameObject>
</AssetDeclaration>`;
  const doc = parseXml(xml);
  const truckDraw = doc.elements.find((e) => e.name === "TruckDraw");
  assert.ok(truckDraw);
  const elType = resolveElementType(truckDraw);
  assert.equal(elType, "W3DTruckDrawModuleData");
  assert.equal(isLocalReferenceAttribute(elType, "id"), true);
  assert.equal(isReferenceAttributeOfType(elType, "id"), false);
  const idx = { assetsById: new Map(), assets: new Map(), defines: new Map() };
  assert.equal(
    resolveReferenceTargetsForType(idx, elType, "id", "ModuleTag_Draw").length,
    0,
  );
});

test("Poid attributes reference pipeline-local objects, not global assets", () => {
  // AttachModuleId / ModuleId / AutoResolveBody are Poid-typed references to
  // modules inside the same GameObject; the global index cannot judge them.
  assert.equal(isReferenceAttributeOfType("AttachNugget", "AttachModuleId"), false);
  assert.equal(isLocalReferenceAttribute("AttachNugget", "AttachModuleId"), true);
  const idx = { assetsById: new Map(), assets: new Map(), defines: new Map() };
  assert.equal(
    resolveReferenceTargetsForType(idx, "AttachNugget", "AttachModuleId", "ModuleTag_X").length,
    0,
  );
});

test("cross-type id references (RoadObject@id -> Road) stay real references", () => {
  // RoadObject declares its id with xas:refType="Road" (an AssetReference,
  // NOT the element's own type), so it must keep reference semantics.
  assert.equal(
    model.attributesOfType("RoadObject").find((a) => a.name === "id")?.refType,
    "Road",
  );
  assert.equal(isReferenceAttributeOfType("RoadObject", "id"), true);
  const idx = {
    assetsById: new Map([
      [
        "road01",
        [
          {
            type: "Road",
            id: "Road01",
            file: "Roads.xml",
            line: 3,
            origin: "project",
          },
        ],
      ],
    ]),
    assets: new Map(),
    projectDir: ".",
    sdkDir: ".",
    defines: new Map(),
    files: new Map(),
    streams: [],
    manifests: new Map(),
    sourceCandidates: [],
    diagnostics: [],
    stats: {},
  };
  const targets = resolveReferenceTargetsForType(idx, "RoadObject", "id", "Road01");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].def.type, "Road");
});

test("top-level asset ids with plain pipeline ids are not references", () => {
  // LocomotorSet@id / ArmorSet@id are Poid pipeline ids without a refType:
  // they identify the element and never need a global definition.
  assert.equal(isReferenceAttributeOfType("LocomotorSet", "id"), false);
  assert.equal(isReferenceAttributeOfType("ArmorTemplateSet", "id"), false);
  const idx = { assetsById: new Map(), assets: new Map(), defines: new Map() };
  assert.equal(
    resolveReferenceTargetsForType(idx, "LocomotorSet", "id", "AnyLocalId").length,
    0,
  );
});

test("xi:include elements are outside the XSD model and unvalidated", () => {
  // The nested XInclude inside a GameObject draw list (HeadlightDraw2.xml)
  // must resolve to no XSD type, so href/xpointer can never be flagged as
  // unknown attributes.
  const xml = `
<AssetDeclaration>
  <GameObject id="GuardianTank">
    <Draws>
      <xi:include
        href="DATA:Includes/HeadlightDraw2.xml"
        xpointer="xmlns(n=uri:ea.com:eala:asset) xpointer(/n:HeadlightDraw2/child::*)" />
    </Draws>
  </GameObject>
</AssetDeclaration>`;
  const doc = parseXml(xml);
  const inc = doc.elements.find((e) => e.name === "xi:include");
  assert.ok(inc);
  assert.equal(model.isXsdElementName(inc.name), false);
  assert.equal(resolveElementType(inc), null);
  // The XInclude attributes themselves are unprefixed (model-valid name
  // shape); the element-level foreign check is what keeps them quiet.
  for (const a of inc.attrs) {
    assert.equal(model.isXsdAttributeName(a.name), true, a.name);
  }
});
