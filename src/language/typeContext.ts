import { childTypeOf, elementTypeName, topLevelElementType } from "../model/schemaModel";
import type { XmlElement } from "./xmlParser";

/**
 * Resolves the XSD type of an element from the parsed document tree by
 * walking up to the root and applying context-aware child lookups at every
 * level. Falls back to the global element->type map when the parent chain
 * does not declare the child.
 */
export function resolveElementType(el: XmlElement): string | null {
  if (!el.parent) {
    // A document root (fragment or full AssetDeclaration) has no parent to
    // provide context. When the root is a top-level asset whose name also
    // appears as a nested child type (EvaEvent, UpgradeTemplate, ...),
    // prefer the AssetDeclaration declaration over the global single-map
    // fallback.
    return topLevelElementType(el.name) ?? elementTypeName(el.name);
  }
  const parentType = resolveElementType(el.parent);
  return childTypeOf(parentType, el.name) ?? elementTypeName(el.name);
}
