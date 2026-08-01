import { childTypeOf, elementTypeName } from "../model/schemaModel";
import type { XmlElement } from "./xmlParser";

/**
 * Resolves the XSD type of an element from the parsed document tree by
 * walking up to the root and applying context-aware child lookups at every
 * level. Falls back to the global element->type map when the parent chain
 * does not declare the child.
 */
export function resolveElementType(el: XmlElement): string | null {
  if (!el.parent) {
    return elementTypeName(el.name);
  }
  const parentType = resolveElementType(el.parent);
  return childTypeOf(parentType, el.name) ?? elementTypeName(el.name);
}
