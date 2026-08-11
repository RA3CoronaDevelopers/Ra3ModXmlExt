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
  isReferenceContentType,
  isReferenceTargetType,
  normalizeReferenceId,
  resolveContentReferenceTargets,
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
  assert.equal(isReferenceAttribute("FXList", "inheritFrom"), true);
  assert.equal(isReferenceAttribute("AIMicroManagerData", "inheritFrom"), true);
  assert.equal(isReferenceAttribute("FireWeaponNugget", "WeaponName"), true);
  // inheritFrom is an asset-level attribute; non-asset elements stay non-refs.
  assert.equal(isReferenceAttribute("Include", "inheritFrom"), false);
});

test("universal inheritFrom legality is separate from CodeLens target design", () => {
  // FXList and other BaseAssetType descendants legally accept inheritFrom,
  // but the XSD does not declare it there. That must not widen the designed
  // reference-target set (Credits is still not a CodeLens target).
  assert.ok(
    model.attributesOfElement("FXList").some((a) => a.name === "inheritFrom"),
  );
  assert.ok(
    model.attributesOfElement("Credits").some((a) => a.name === "inheritFrom"),
  );
  assert.equal(isReferenceTargetType("Credits"), false);
  assert.equal(isReferenceTargetType("FXList"), true); // via FXListRef, not universal attr
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

test("typed simple content resolves like a typed attribute reference", () => {
  // <CreateObject>CrateDebris_01</CreateObject> uses GameObjectWeakRef:
  // the content is a GameObject reference, not a child element.
  assert.equal(isReferenceContentType("GameObjectWeakRef"), true);
  const idx = {
    assetsById: new Map([
      [
        "cratedebris_01",
        [
          {
            type: "GameObject",
            id: "CrateDebris_01",
            file: "Crates.xml",
            line: 2,
            origin: "project",
          },
          {
            type: "WeaponTemplate",
            id: "CrateDebris_01",
            file: "Weapons.xml",
            line: 4,
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
  const targets = resolveContentReferenceTargets(idx, "GameObjectWeakRef", "CrateDebris_01");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].def.type, "GameObject");
});

test("simpleContent complex types resolve as typed content references", () => {
  // <Sound>AudioFile</Sound> / <Subsound>VoiceEvent</Subsound> use
  // simpleContent complex types (AudioFileRefWithWeight /
  // MultisoundSubsoundRef) whose text is still a typed asset reference.
  assert.equal(isReferenceContentType("AudioFileRefWithWeight"), true);
  assert.equal(isReferenceContentType("MultisoundSubsoundRef"), true);
  // Inline Frame's simpleContent is a scalar float, not a reference.
  assert.equal(isReferenceContentType("@inline:Frame"), false);

  const idx = {
    assetsById: new Map([
      [
        "shared",
        [
          { type: "AudioFile", id: "Shared", file: "Audio.xml", line: 1, origin: "project" },
          { type: "AudioEvent", id: "Shared", file: "Voice.xml", line: 2, origin: "project" },
        ],
      ],
    ]),
    assets: new Map(),
    defines: new Map(),
  };

  const soundTargets = resolveContentReferenceTargets(
    idx,
    "AudioFileRefWithWeight",
    "Shared",
  );
  assert.equal(soundTargets.length, 1);
  assert.equal(soundTargets[0].def.type, "AudioFile");

  const subsoundTargets = resolveContentReferenceTargets(
    idx,
    "MultisoundSubsoundRef",
    "Shared",
  );
  assert.equal(subsoundTargets.length, 1);
  assert.equal(subsoundTargets[0].def.type, "AudioEvent");
});

test("normalizeReferenceId strips a manifest-style Type: prefix", () => {
  assert.equal(normalizeReferenceId("BaseSoundEffect"), "BaseSoundEffect");
  assert.equal(
    normalizeReferenceId("AudioEvent:BaseSoundEffect"),
    "BaseSoundEffect",
  );
  // Art-asset manifest names can carry a subtype segment; the referenceable
  // id is still the last colon segment.
  assert.equal(
    normalizeReferenceId("W3dContainer:W3DContainer:ABC_SKN"),
    "ABC_SKN",
  );
  // A trailing colon has no id yet; keep the raw value so a half-typed
  // qualified value never matches anything.
  assert.equal(normalizeReferenceId("AudioEvent:"), "AudioEvent:");
});

test("qualified Type:Id inheritFrom values resolve to plain-id definitions", () => {
  const def = {
    type: "AudioEvent",
    id: "BaseSoundEffect",
    file: "Sounds.xml",
    line: 1,
    origin: "sdk",
  };
  const idx = {
    assetsById: new Map([["basesoundeffect", [def]]]),
    assets: new Map(),
    defines: new Map(),
  };

  // The reported scenario: <AudioEvent inheritFrom="AudioEvent:BaseSoundEffect"/>.
  const qualified = resolveReferenceTargetsForType(
    idx,
    "AudioEvent",
    "inheritFrom",
    "AudioEvent:BaseSoundEffect",
  );
  assert.equal(qualified.length, 1);
  assert.equal(qualified[0].def.id, "BaseSoundEffect");

  // Plain ids keep working unchanged.
  assert.equal(
    resolveReferenceTargetsForType(idx, "AudioEvent", "inheritFrom", "BaseSoundEffect")
      .length,
    1,
  );

  // A wrong type prefix is still filtered by selfType: the AudioEvent def
  // must never satisfy a GameObject inheritFrom.
  assert.equal(
    resolveReferenceTargetsForType(
      idx,
      "GameObject",
      "inheritFrom",
      "GameObject:BaseSoundEffect",
    ).length,
    0,
  );
});

test("qualified Type:Id values resolve for typed attributes and content refs", () => {
  const audioEvent = {
    type: "AudioEvent",
    id: "JAP_Refinery_Select",
    file: "SoundEffects.xml",
    line: 1,
    origin: "sdk",
  };
  const playerTemplate = {
    type: "PlayerTemplate",
    id: "Allies",
    file: "PlayerTemplates.xml",
    line: 1,
    origin: "manifest",
  };
  const audioFile = {
    type: "AudioFile",
    id: "Shared",
    file: "Audio.xml",
    line: 1,
    origin: "project",
  };
  const idx = {
    assetsById: new Map([
      ["jap_refinery_select", [audioEvent]],
      ["allies", [playerTemplate]],
      ["shared", [audioFile]],
    ]),
    assets: new Map(),
    defines: new Map(),
  };

  // SoundOrEvaEvent@Sound refType is BaseAudioEventInfo; the concrete
  // "AudioEvent:" prefix must survive normalization and the type filter.
  const soundTargets = resolveReferenceTargetsForType(
    idx,
    "SoundOrEvaEvent",
    "Sound",
    "AudioEvent:JAP_Refinery_Select",
  );
  assert.equal(soundTargets.length, 1);
  assert.equal(soundTargets[0].def.type, "AudioEvent");

  // Side="PlayerTemplate:Allies" style attribute.
  const sideTargets = resolveReferenceTargetsForType(
    idx,
    "SideSound",
    "Side",
    "PlayerTemplate:Allies",
  );
  assert.equal(sideTargets.length, 1);
  assert.equal(sideTargets[0].def.type, "PlayerTemplate");

  // Simple-content references use the same convention.
  const contentTargets = resolveContentReferenceTargets(
    idx,
    "AudioFileRefWithWeight",
    "AudioFile:Shared",
  );
  assert.equal(contentTargets.length, 1);
  assert.equal(contentTargets[0].def.type, "AudioFile");
});

test("untyped and pipeline-local content is not a global reference", () => {
  // Generic AssetReference content is used for shader constants and model
  // sub-object names, not global asset ids; Poid is pipeline-local.
  assert.equal(isReferenceContentType("AssetReference"), false);
  assert.equal(isReferenceContentType("Poid"), false);
  assert.equal(isReferenceContentType("string"), false);
  const idx = { assetsById: new Map(), assets: new Map(), defines: new Map() };
  assert.equal(
    resolveContentReferenceTargets(idx, "AssetReference", "Anything").length,
    0,
  );
  assert.equal(resolveContentReferenceTargets(idx, "Poid", "Anything").length, 0);
});
