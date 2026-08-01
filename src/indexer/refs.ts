import {
  attributesOfType,
  elementTypeName,
  isAssignableTo,
} from "../model/schemaModel";
import type { AssetDef, ModIndex } from "./types";

export interface ReferenceTarget {
  def: AssetDef;
  score: number;
}

/**
 * True when an attribute is a typed reference: either the instance
 * inheritance attribute `inheritFrom`, or an XSD attribute whose simple type
 * carries an `xas:refType`. Enumerations and file paths (e.g.
 * `Include/@type`, `Include/@source`) are not references.
 */
export function isReferenceAttribute(elementName: string, attrName: string): boolean {
  return isReferenceAttributeOfType(elementTypeName(elementName), attrName);
}

/** Same check, but driven by a resolved XSD type name. */
export function isReferenceAttributeOfType(
  typeName: string | null,
  attrName: string,
): boolean {
  if (attrName.toLowerCase() === "inheritfrom") return true;
  const attr = attributesOfType(typeName).find((a) => a.name === attrName);
  return attr != null && (attr.refType != null || attr.isRef);
}

/**
 * Resolves the definitions a reference attribute value should point to.
 *
 * The result is strictly filtered by the attribute's reference type (from the
 * XSD model) so that an id shared by several asset types only resolves to the
 * matching definition (e.g. `Weapon="X"` jumps to the WeaponTemplate with
 * id "X", never to a GameObject that happens to share the id).
 *
 * Returns [] when the attribute is not a typed reference or nothing matches.
 */
export function resolveReferenceTargets(
  idx: ModIndex,
  elementType: string,
  attrName: string,
  id: string,
): ReferenceTarget[] {
  return resolveReferenceTargetsForType(
    idx,
    elementTypeName(elementType),
    attrName,
    id,
  );
}

/** Same resolution, driven by a resolved XSD type name. */
export function resolveReferenceTargetsForType(
  idx: ModIndex,
  typeName: string | null,
  attrName: string,
  id: string,
): ReferenceTarget[] {
  const defs = idx.assetsById.get(id.toLowerCase());
  if (!defs?.length) return [];

  const nameLower = attrName.toLowerCase();
  let refType: string | null = null;
  let selfType: string | null = null;

  if (nameLower === "inheritfrom") {
    selfType = typeName;
  } else {
    const attr = attributesOfType(typeName).find((a) => a.name === attrName);
    if (!attr || (!attr.refType && !attr.isRef)) return [];
    refType = attr.refType;
  }

  const targets: ReferenceTarget[] = [];
  for (const def of defs) {
    if (refType && !isAssignableTo(def.type, refType)) continue;
    if (selfType && !isAssignableTo(def.type, selfType)) continue;
    let score = 3;
    if (def.origin === "project") score = 0;
    else if (def.origin === "sdk") score = 1;
    else score = 2;
    targets.push({ def, score });
  }
  targets.sort((a, b) => a.score - b.score || a.def.id.localeCompare(b.def.id));
  return targets;
}
