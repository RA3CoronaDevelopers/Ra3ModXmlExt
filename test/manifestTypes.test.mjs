import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveAssetId, deriveAssetType } from "../out/indexer/manifestParser.js";
import { isAssignableTo } from "../out/model/schemaModel.js";
import {
  isReferenceAttributeOfType,
  resolveReferenceTargetsForType,
} from "../out/indexer/refs.js";

test("deriveAssetType falls back to the TypeName:Id prefix", () => {
  assert.equal(deriveAssetType(null, "PlayerTemplate:Allies"), "PlayerTemplate");
  assert.equal(deriveAssetType(null, "AudioFile:A06_Loop"), "AudioFile");
  assert.equal(deriveAssetType("GameObject", "GameObject:X"), "GameObject");
  assert.equal(deriveAssetType(null, "NoColonHere"), null);
  assert.equal(deriveAssetType(null, ":LeadingColon"), null);
});

test("deriveAssetId uses the last colon segment", () => {
  // Art assets carry an extra subtype segment: Type:SubType:FileName.
  assert.equal(
    deriveAssetId("W3dContainer:W3DContainer:AUANTIVEHICLEVEHICLETECH1_SKN"),
    "AUANTIVEHICLEVEHICLETECH1_SKN",
  );
  assert.equal(deriveAssetId("PlayerTemplate:Allies"), "Allies");
  assert.equal(deriveAssetId("AudioFile:A06_Loop"), "A06_Loop");
  assert.equal(deriveAssetId("Texture:Texture:AUAntiVehicleVehicleTech1"), "AUAntiVehicleVehicleTech1");
  assert.equal(deriveAssetId("NoColon"), "NoColon");
});

test("case-normalized type matching follows the XSD inheritance chain", () => {
  // Manifest hashes use "W3d*" casing while the XSD types are "W3D*"; the
  // canonical lookup must bridge the two and respect the real chain.
  assert.ok(
    isAssignableTo("W3dContainer", "BaseRenderAssetType"),
    "W3dContainer is a render asset",
  );
  assert.ok(
    isAssignableTo("W3DMesh", "BaseRenderAssetType"),
    "W3DMesh is a render asset",
  );
  assert.ok(
    !isAssignableTo("W3dHierarchy", "BaseRenderAssetType"),
    "W3dHierarchy is NOT a render asset (per XSD)",
  );
});

test("manifest-derived PlayerTemplate ids satisfy Side references", () => {
  // Simulate a manifest asset whose TypeId hash is unknown but whose name
  // carries the type prefix (exactly what global.manifest does for
  // PlayerTemplate:Allies).
  const idx = {
    assetsById: new Map([
      [
        "allies",
        [
          {
            type: "PlayerTemplate",
            id: "Allies",
            file: "global.manifest",
            line: 0,
            origin: "manifest",
          },
        ],
      ],
    ]),
    assets: new Map([["PlayerTemplate", new Map([["allies", []]])]]),
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

  assert.ok(isAssignableTo("PlayerTemplate", "PlayerTemplate"));
  assert.equal(isReferenceAttributeOfType("GameObject", "Side"), true);
  const targets = resolveReferenceTargetsForType(idx, "GameObject", "Side", "Allies");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].def.type, "PlayerTemplate");
});
