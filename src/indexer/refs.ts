import {
  allTypeNames,
  attributesOfType,
  canonicalTypeName,
  contentInfoOfType,
  elementTypeName,
  isAssetType,
  isAssignableTo,
  typeChain,
  typeInfo,
} from "../model/schemaModel";
import type { AssetDef, LocalOverlay } from "./types";

export interface ReferenceTarget {
  def: AssetDef;
  score: number;
}

/**
 * The subset of `ModIndex` that reference resolution needs. Kept narrow so
 * the reverse reference index can resolve records against the indexer's live
 * maps without constructing a full index snapshot.
 */
export interface ReferenceLookup {
  /** type -> id -> definitions. */
  assets: Map<string, Map<string, AssetDef[]>>;
  /** id -> definitions across all types. */
  assetsById: Map<string, AssetDef[]>;
  /** Optional document-local overlay (consulted first). */
  local?: LocalOverlay;
}

/**
 * True when an attribute is a "pipeline-local" reference that the global
 * asset index cannot judge:
 *
 * - `id` attributes declare the element's own identity. When the attribute
 *   has no refType (plain Poid / pipeline ids) or its refType is compatible
 *   with the element's own type (e.g. ModuleData@id -> ModuleData), the
 *   element itself is the definition site, so no global definition is
 *   required. An `id` whose refType points at a *different* asset type
 *   (e.g. RoadObject@id -> Road) is a real cross-asset reference and keeps
 *   its reference semantics.
 * - Poid-typed attributes (ModuleId, AutoResolveBody, SoundRef, ...) are
 *   "pipeline object id" references that are resolved within the same
 *   asset/subtree (modules, sub-objects, pivots, shader materials...),
 *   never against the global asset index.
 */
export function isLocalReferenceAttribute(
  typeName: string | null,
  attrName: string,
): boolean {
  const attr = attributesOfType(typeName).find((a) => a.name === attrName);
  if (!attr) return false;
  const isId = attrName.toLowerCase() === "id";
  if (isId) {
    if (!attr.refType) return true;
    if (typeName && isAssignableTo(typeName, attr.refType)) return true;
    return false;
  }
  return attr.type === "Poid";
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
  if (attrName.toLowerCase() === "inheritfrom") return isAssetType(typeName);
  const attr = attributesOfType(typeName).find((a) => a.name === attrName);
  if (attr == null || !(attr.refType != null || attr.isRef)) return false;
  // Definitions (id) and pipeline-local references (Poid) are not references
  // to global assets, so they never need a definition in the global index.
  if (isLocalReferenceAttribute(typeName, attrName)) return false;
  return true;
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
  idx: ReferenceLookup,
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
  idx: ReferenceLookup,
  typeName: string | null,
  attrName: string,
  id: string,
): ReferenceTarget[] {
  const defs = mergeLocalAndGlobalDefs(
    idx.local?.assetsById.get(id.toLowerCase()),
    idx.assetsById.get(id.toLowerCase()),
  );
  if (!defs.length) return [];

  const nameLower = attrName.toLowerCase();
  let refType: string | null = null;
  let selfType: string | null = null;

  if (nameLower === "inheritfrom") {
    if (!isAssetType(typeName)) return [];
    selfType = typeName;
  } else {
    const attr = attributesOfType(typeName).find((a) => a.name === attrName);
    if (!attr || (!attr.refType && !attr.isRef)) return [];
    // id definitions and Poid pipeline-local references are never resolved
    // against the global asset index.
    if (isLocalReferenceAttribute(typeName, attrName)) return [];
    refType = attr.refType;
  }

  return filterAndScoreDefs(defs, refType, selfType);
}

/**
 * True when an element's text content is a typed reference to a global
 * asset: the element's resolved XSD type is a simple type carrying an
 * `xas:refType`, or a simpleContent complex type carrying `xas:refType`
 * (e.g. `<CreateObject>` with `GameObjectWeakRef`, `<Sound>` with
 * `AudioFileRefWithWeight`).
 *
 * Only *typed* refs are treated as content references. Generic untyped
 * `AssetReference` content is used by real data for shader constants,
 * mesh sub-object names and other values that are not global asset ids
 * (`FXShaderConstantTexture@Value`, `RenderSubObjectReference@Mesh`), so
 * resolving those globally would produce false hover/navigation/diagnostics.
 * Poid pipeline-local ids are excluded for the same reason.
 */
export function isReferenceContentType(typeName: string | null): boolean {
  if (!typeName) return false;
  const info = contentInfoOfType(typeName);
  if (!info) return false;
  if (typeChain(typeName).includes("Poid")) return false;
  return info.refType != null;
}

/**
 * Resolves the definitions an element's text content should point to,
 * filtered by the element type's `xas:refType`
 * (e.g. `GameObjectWeakRef` -> `GameObject`).
 */
export function resolveContentReferenceTargets(
  idx: ReferenceLookup,
  typeName: string | null,
  id: string,
): ReferenceTarget[] {
  if (!isReferenceContentType(typeName)) return [];
  if (!typeName) return [];
  const defs = mergeLocalAndGlobalDefs(
    idx.local?.assetsById.get(id.toLowerCase()),
    idx.assetsById.get(id.toLowerCase()),
  );
  if (!defs.length) return [];
  const info = contentInfoOfType(typeName);
  const refType = info?.refType ?? null;
  return filterAndScoreDefs(defs, refType, null);
}

export function filterAndScoreDefs(
  defs: readonly AssetDef[],
  refType: string | null,
  selfType: string | null,
): ReferenceTarget[] {
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

/**
 * Merges document-local definitions with the global index, keeping local
 * entries first and de-duplicating definitions that exist in both.
 */
export function mergeLocalAndGlobalDefs(
  local: readonly AssetDef[] | undefined,
  global: readonly AssetDef[] | undefined,
): AssetDef[] {
  const seen = new Set<string>();
  const out: AssetDef[] = [];
  for (const list of [local, global]) {
    if (!list) continue;
    for (const def of list) {
      const key = `${def.type}\u0000${def.id.toLowerCase()}\u0000${def.file}\u0000${def.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(def);
    }
  }
  return out;
}

let referenceTargetTypeSet: Set<string> | null = null;

/**
 * True when the XSD itself declares `inheritFrom` for the type. This is the
 * narrower "designed reference target" signal used by CodeLens / unreferenced
 * reports; the universal BAB `inheritFrom` attribute must not widen it to
 * every BaseAssetType descendant.
 */
function xsdDeclaresInheritFrom(typeName: string): boolean {
  const info = typeInfo(typeName);
  return (
    info?.kind === "complex" &&
    info.attributes.some((a) => a.name.toLowerCase() === "inheritfrom")
  );
}

/**
 * The set of XSD types that are "reference targets by design": at least one
 * typed reference attribute / simple-content reference points at them, or
 * the XSD explicitly declares them inheritable (`inheritFrom`). The universal
 * BAB `inheritFrom` attribute on every BaseAssetType descendant is a separate
 * legality concern and intentionally does NOT widen this set. Types outside
 * this set are auto-registered / structural (settings, map metadata, w3x
 * sub-assets...), so a zero reference count is their normal state and counts
 * would only be noise.
 */
export function referenceTargetTypes(): ReadonlySet<string> {
  if (referenceTargetTypeSet) return referenceTargetTypeSet;
  const set = new Set<string>();
  const add = (t: string | null) => {
    if (!t) return;
    set.add(canonicalTypeName(t) ?? t);
  };
  for (const typeName of allTypeNames()) {
    const info = typeInfo(typeName);
    if (!info) continue;
    if (info.kind === "complex") {
      for (const attr of info.attributes) {
        if (isLocalReferenceAttribute(typeName, attr.name)) continue;
        if (attr.refType) add(attr.refType);
      }
      if (info.content?.refType) add(info.content.refType);
      if (xsdDeclaresInheritFrom(typeName)) {
        add(typeName);
      }
    } else if (
      info.kind === "simple" &&
      info.refType &&
      !typeChain(typeName).includes("Poid")
    ) {
      add(info.refType);
    }
  }
  referenceTargetTypeSet = set;
  return set;
}

/** True when the type is a designed reference target (see above). */
export function isReferenceTargetType(typeName: string | null): boolean {
  if (!typeName) return false;
  return referenceTargetTypes().has(canonicalTypeName(typeName) ?? typeName);
}
