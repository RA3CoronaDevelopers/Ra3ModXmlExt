import { test } from "node:test";
import assert from "node:assert/strict";
import * as model from "../out/model/schemaModel.js";

test("top-level elements include core asset types", () => {
  for (const name of ["GameObject", "WeaponTemplate", "Texture", "LogicCommandSet", "SpecialPowerTemplate"]) {
    assert.ok(model.isTopLevelElement(name), name);
  }
});

test("GameObject has expected attributes", () => {
  const attrs = model.attributesOfElement("GameObject");
  const id = attrs.find((a) => a.name === "id");
  assert.ok(id?.required);
  const cmd = attrs.find((a) => a.name === "CommandSet");
  assert.equal(cmd?.refType, "LogicCommandSet");
  assert.ok(attrs.some((a) => a.name === "inheritFrom"));
});

test("attribute-level xas:refType is captured (module ids, map objects)", () => {
  // ModuleData@id is declared as <xs:attribute name="id" type="Poid"
  // xas:refType="ModuleData" />; the refType must reach every module subtype.
  const moduleId = model.attributesOfType("ModuleData").find((a) => a.name === "id");
  assert.equal(moduleId?.refType, "ModuleData");
  assert.equal(
    model.attributesOfType("W3DTruckDrawModuleData").find((a) => a.name === "id")?.refType,
    "ModuleData",
  );
  // MapObject@id declares itself; ThingTemplate references a GameObject.
  assert.equal(
    model.attributesOfType("MapObject").find((a) => a.name === "id")?.refType,
    "MapObject",
  );
  assert.equal(
    model.attributesOfType("MapObject").find((a) => a.name === "ThingTemplate")?.refType,
    "GameObject",
  );
  // RoadObject@id references a different global asset type (Road).
  assert.equal(
    model.attributesOfType("RoadObject").find((a) => a.name === "id")?.refType,
    "Road",
  );
  // Poid pipeline-local references keep their typed targets.
  assert.equal(
    model.attributesOfType("AttachNugget").find((a) => a.name === "AttachModuleId")?.refType,
    "ModuleData",
  );
});

test("Include has reference/instance/all enum", () => {
  const attrs = model.attributesOfElement("Include");
  const type = attrs.find((a) => a.name === "type");
  assert.deepEqual(type?.enumValues, ["reference", "instance", "all"]);
});

test("xs:list types expose their item enum and isList flag", () => {
  const expected = [
    "GROUND", "WATER", "CLIFF", "AIR", "RUBBLE", "OBSTACLE", "IMPASSABLE",
    "DEEP_WATER", "WALL_RAILING", "CRUSHABLE_OBSTACLE", "CRUSHABLE_WALL",
  ];
  const flags = model.typeInfo("LocomotorSurfaceBitFlags");
  assert.equal(flags.isList, true);
  assert.deepEqual(flags.enumValues, expected);
  const surfaces = model
    .attributesOfType("LocomotorTemplate")
    .find((a) => a.name === "Surfaces");
  assert.equal(surfaces.isList, true);
  assert.deepEqual(surfaces.enumValues, expected);
});

test("numeric list types do not invent enums", () => {
  const list = model.typeInfo("SageUnsignedIntList");
  assert.equal(list.isList, true);
  assert.deepEqual(list.enumValues, []);
  // Plain restriction enums keep isList=false.
  const plain = model.typeInfo("Surface");
  assert.equal(plain.isList, false);
  assert.ok(plain.enumValues.length > 0);
});

test("foreign namespaces are excluded from XSD validation", () => {
  // XInclude elements (xi:include / xi:fallback) come from the W3C XInclude
  // namespace, not from the EA asset XSD.
  assert.equal(model.isXsdElementName("xi:include"), false);
  assert.equal(model.isXsdElementName("xi:fallback"), false);
  assert.equal(model.isXsdElementName("GameObject"), true);
  assert.equal(model.isXsdElementName("AssetDeclaration"), true);
  // EA schema attributes are unprefixed; prefixed attributes (xai:, xi:,
  // xlink:, xml:, xsi:, xmlns:*) are namespace machinery.
  assert.equal(model.isXsdAttributeName("href"), true);
  assert.equal(model.isXsdAttributeName("xpointer"), true);
  assert.equal(model.isXsdAttributeName("xai:joinAction"), false);
  assert.equal(model.isXsdAttributeName("xlink:href"), false);
  assert.equal(model.isXsdAttributeName("xml:space"), false);
  assert.equal(model.isXsdAttributeName("xmlns:xi"), false);
});

test("type assignability follows inheritance", () => {
  assert.ok(model.isAssignableTo("GameObject", "BaseInheritableAsset"));
  assert.ok(model.isAssignableTo("GameObject", "GameObject"));
  assert.ok(!model.isAssignableTo("WeaponTemplate", "GameObject"));
});

test("asset type hashes resolve", () => {
  assert.equal(model.assetTypeNameFromHash(0x942fff2d), "GameObject");
  assert.equal(model.assetTypeNameFromHash(0x166b084d), "AudioFile");
});
