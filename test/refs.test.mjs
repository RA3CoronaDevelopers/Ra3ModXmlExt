import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ModIndexer } from "../out/indexer/indexer.js";
import { CachedDirectoryWalker } from "../out/indexer/fileScanner.js";
import { isReferenceAttribute, resolveReferenceTargets } from "../out/indexer/refs.js";
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

test("untyped references (isRef without refType) resolve to any declared id", () => {
  // LocomotorSet/@Locomotor has type AssetReference: xas:isRef="true" with
  // no refType. It must be treated as a reference and match the id regardless
  // of the target asset type.
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
