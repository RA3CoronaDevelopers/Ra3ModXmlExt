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

test("Include has reference/instance/all enum", () => {
  const attrs = model.attributesOfElement("Include");
  const type = attrs.find((a) => a.name === "type");
  assert.deepEqual(type?.enumValues, ["reference", "instance", "all"]);
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
