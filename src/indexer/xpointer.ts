import type { XmlDocument, XmlElement } from "../language/xmlParser";

/** Lowercases nothing; returns the part after the last ":" in a tag name. */
export function localName(tag: string): string {
  const idx = tag.lastIndexOf(":");
  return idx >= 0 ? tag.slice(idx + 1) : tag;
}

/**
 * Resolves the xpointer subset used by real RA3 mods:
 *   xmlns(n=uri:ea.com:eala:asset) xpointer(/n:ElementName/child::*)
 *
 * Returns the container element whose children are selected by the xpointer,
 * or null when the form is unsupported / the container is missing.
 */
export function findXPointerContainer(
  doc: XmlDocument,
  xpointer: string,
): XmlElement | null {
  const m = /xpointer\(\/\w+:(\w+)\/child::\*\)/.exec(xpointer);
  if (!m) return null;
  const name = m[1];
  return doc.elements.find((el) => localName(el.name) === name) ?? null;
}
