import { test } from "node:test";
import assert from "node:assert/strict";
import { parseXml } from "../out/language/xmlParser.js";
import { resolveElementType } from "../out/language/typeContext.js";
import * as model from "../out/model/schemaModel.js";

test("context-aware type resolution follows the parent chain", () => {
  const text = `<?xml version="1.0"?>
<AssetDeclaration xmlns="uri:ea.com:eala:asset">
  <GameObject id="Tank">
    <BehaviorModules>
      <WeaponSetUpdate>
        <WeaponSlotTurret ID="1">
          <Weapon Ordering="PRIMARY_WEAPON" />
        </WeaponSlotTurret>
      </WeaponSetUpdate>
    </BehaviorModules>
  </GameObject>
</AssetDeclaration>`;
  const doc = parseXml(text);
  const weapon = doc.elements.find((e) => e.name === "Weapon");
  assert.ok(weapon, "Weapon element parsed");

  const weaponType = resolveElementType(weapon);
  assert.equal(weaponType, "WeaponSlot_WeaponData");

  const attrs = model.attributesOfType(weaponType);
  assert.ok(attrs.some((a) => a.name === "Ordering"), "Ordering attribute present");

  // The same element name in a non-slot context resolves differently
  // (e.g. a plain WeaponRef) and must not leak the slot attributes.
  const slot = doc.elements.find((e) => e.name === "WeaponSlotTurret");
  assert.equal(resolveElementType(slot), "WeaponSlot_Turret");
});

test("model childTypeOf primitives", () => {
  assert.equal(model.childTypeOf("WeaponSetUpdateModuleData", "WeaponSlotTurret"), "WeaponSlot_Turret");
  assert.equal(model.childTypeOf("WeaponSlot_Turret", "Weapon"), "WeaponSlot_WeaponData");
  assert.equal(model.childTypeOf("WeaponSlot_WeaponData", "Weapon"), null);
  assert.equal(model.childTypeOf(null, "Weapon"), null);
});

test("fragment roots prefer top-level AssetDeclaration types over name collisions", () => {
  // <EvaEvent> is both a top-level asset and an FXNugget child. A fragment
  // root has no parent context, so it must resolve to the top-level asset
  // type (with Priority / TimeBetweenEvents etc.), not to EvaEventFXNugget.
  const evaDoc = parseXml(
    `<EvaEvent id="IncomingTransmission" Priority="100" TimeBetweenEvents="0ms" ExpirationTime="10000ms"/>`,
  );
  assert.equal(resolveElementType(evaDoc.root), "EvaEvent");
  assert.ok(
    model.attributesOfType("EvaEvent").some((a) => a.name === "Priority"),
  );

  const upgradeDoc = parseXml(`<UpgradeTemplate id="Upgrade_X" inheritFrom="Base"/>`);
  assert.equal(resolveElementType(upgradeDoc.root), "UpgradeTemplate");

  // Non-top-level fragment roots still fall back to the contextual child
  // mapping (no AssetDeclaration child exists for Weapon).
  const weaponDoc = parseXml(`<Weapon Ordering="PRIMARY_WEAPON"/>`);
  assert.equal(resolveElementType(weaponDoc.root), "WeaponRef");
});
