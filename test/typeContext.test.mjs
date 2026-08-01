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
