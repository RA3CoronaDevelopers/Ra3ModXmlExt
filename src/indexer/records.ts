/**
 * Compact per-file index records.
 *
 * A rebuild only needs each file's top-level assets, defines, includes and
 * xi:include targets — not the DOM. Extracting these records at parse time
 * and caching them across rebuilds lets Corona-scale rebuilds skip both the
 * DOM and the file I/O for unchanged files, while keeping the DOM cache small
 * for on-demand features (hover / navigation / outline).
 *
 * Pure TypeScript: no vscode dependency.
 */

import type { LineMap, XmlDocument } from "../language/xmlParser";
import type { ShallowDocument } from "./shallowScan";
import { attributesOfType, typeInfo } from "../model/schemaModel";
import { resolveElementType } from "../language/typeContext";
import {
  isReferenceAttributeOfType,
  isReferenceContentType,
} from "./refs";

export interface IndexRecordAsset {
  /** Top-level element name, e.g. "W3DContainer". */
  type: string;
  id: string;
  /** 1-based line of the id attribute value. */
  line: number;
}

export interface IndexRecordDefine {
  name: string;
  value: string;
  /** 1-based line of the <Define> element. */
  line: number;
}

export interface IndexRecordInclude {
  type: "all" | "instance" | "reference" | null;
  source: string;
  /** 1-based line of the <Include> element. */
  line: number;
}

export interface IndexRecordXi {
  href: string;
  xpointer: string | null;
  /** 1-based line of the <xi:include> element. */
  line: number;
}

export interface IndexRecordReference {
  /** "attr" for attribute values, "content" for simple-content text. */
  kind: "attr" | "content";
  /**
   * XSD reference target type (from `xas:refType`), or null for untyped
   * `isRef` references and `inheritFrom` (which filters by the element's own
   * type via `selfType`).
   */
  refType: string | null;
  /** Element type used by `inheritFrom` filtering; null otherwise. */
  selfType: string | null;
  /** The referenced id text (whole attribute value / trimmed content). */
  value: string;
  /** 1-based line of the value. */
  line: number;
  /** Character offset of the value start (relative to the file text). */
  start: number;
  /** Character offset one past the value end. */
  end: number;
}

export interface IndexRecords {
  assets: IndexRecordAsset[];
  defines: IndexRecordDefine[];
  includes: IndexRecordInclude[];
  /** <xi:include> elements that are direct children of the root. */
  rootXiIncludes: IndexRecordXi[];
  /** <xi:include> elements nested anywhere else in the document. */
  nestedXiIncludes: IndexRecordXi[];
  /** Typed global-asset references (attribute values + simple content). */
  references: IndexRecordReference[];
}

const INCLUDE_TYPES = new Set(["all", "instance", "reference"]);

function lineOf(lineMap: LineMap, offset: number): number {
  return lineMap.positionAt(offset).line + 1;
}

function localName(tag: string): string {
  const idx = tag.lastIndexOf(":");
  return idx >= 0 ? tag.slice(idx + 1) : tag;
}

/**
 * Extracts the index records of a fully parsed document. Mirrors the walk
 * semantics of the indexer exactly: top-level assets (excluding
 * Tags/Includes/Defines), $DEFINE constants, the top-level <Includes> block
 * and root/nested <xi:include> elements.
 */
export function extractIndexRecords(
  parse: XmlDocument,
  lineMap: LineMap,
  text: string,
): IndexRecords {
  const assets: IndexRecordAsset[] = [];
  const defines: IndexRecordDefine[] = [];
  const includes: IndexRecordInclude[] = [];
  const rootXiIncludes: IndexRecordXi[] = [];
  const nestedXiIncludes: IndexRecordXi[] = [];
  const references: IndexRecordReference[] = [];
  const root = parse.root;
  if (!root) {
    return { assets, defines, includes, rootXiIncludes, nestedXiIncludes, references };
  }

  for (const child of root.children) {
    const local = localName(child.name);
    if (local === "Tags" || local === "Includes" || local === "Defines") continue;
    if (local === "include") {
      const href = child.attrs.find((a) => a.name === "href")?.value;
      if (href) {
        rootXiIncludes.push({
          href,
          xpointer: child.attrs.find((a) => a.name === "xpointer")?.value ?? null,
          line: lineOf(lineMap, child.start),
        });
      }
      continue;
    }
    const idAttr = child.attrs.find((a) => a.name === "id");
    if (idAttr) {
      assets.push({ type: local, id: idAttr.value, line: lineOf(lineMap, idAttr.valueStart) });
    }
  }

  for (const child of root.children) {
    if (localName(child.name) !== "Defines") continue;
    for (const define of child.children) {
      if (localName(define.name) !== "Define") continue;
      const name = define.attrs.find((a) => a.name === "name")?.value;
      if (!name) continue;
      defines.push({
        name,
        value: define.attrs.find((a) => a.name === "value")?.value ?? "",
        line: lineOf(lineMap, define.start),
      });
    }
  }

  const includesElem = root.children.find((c) => localName(c.name) === "Includes");
  if (includesElem) {
    for (const inc of includesElem.children) {
      if (localName(inc.name) !== "Include") continue;
      const source = inc.attrs.find((a) => a.name === "source")?.value;
      if (!source) continue;
      const type = inc.attrs.find((a) => a.name === "type")?.value;
      includes.push({
        type:
          type && INCLUDE_TYPES.has(type)
            ? (type as "all" | "instance" | "reference")
            : null,
        source,
        line: lineOf(lineMap, inc.start),
      });
    }
  }

  for (const el of parse.elements) {
    if (localName(el.name) !== "include") continue;
    if (el.parent === root) continue; // already handled above
    const href = el.attrs.find((a) => a.name === "href")?.value;
    if (!href) continue;
    nestedXiIncludes.push({
      href,
      xpointer: el.attrs.find((a) => a.name === "xpointer")?.value ?? null,
      line: lineOf(lineMap, el.start),
    });
  }

  collectReferenceRecords(parse, lineMap, text, references);

  return { assets, defines, includes, rootXiIncludes, nestedXiIncludes, references };
}

/**
 * Walks every element of a fully parsed document and records typed
 * global-asset references: reference attributes, `inheritFrom` and
 * simple-content reference text. Local `id` definitions, Poid pipeline-local
 * references and `$DEFINE`/`=` values are intentionally skipped (the same
 * semantics as diagnostics / hover / navigation).
 *
 * The stored `refType` / `selfType` pair is exactly what
 * `resolveReferenceTargetsForType` derives from the element context, so the
 * reverse reference index can resolve these records after the whole index is
 * built without re-walking the document or re-resolving element types.
 */
function collectReferenceRecords(
  parse: XmlDocument,
  lineMap: LineMap,
  text: string,
  out: IndexRecordReference[],
): void {
  for (const el of parse.elements) {
    const elType = resolveElementType(el);

    for (const attr of el.attrs) {
      if (!attr.hasValue) continue;
      if (!isReferenceAttributeOfType(elType, attr.name)) continue;
      const value = attr.value;
      if (!value || value.startsWith("$") || value.startsWith("=")) continue;
      let refType: string | null = null;
      let selfType: string | null = null;
      if (attr.name.toLowerCase() === "inheritfrom") {
        selfType = elType;
      } else if (elType) {
        refType =
          attributesOfType(elType).find((a) => a.name === attr.name)?.refType ??
          null;
      }
      out.push({
        kind: "attr",
        refType,
        selfType,
        value,
        line: lineOf(lineMap, attr.valueStart),
        start: attr.valueStart,
        end: attr.valueEnd,
      });
    }

    if (
      elType &&
      isReferenceContentType(elType) &&
      !el.selfClosing &&
      el.closeTagStart >= 0
    ) {
      const raw = text.slice(el.startTagEnd, el.closeTagStart);
      const value = raw.trim();
      if (
        !value ||
        value.startsWith("$") ||
        value.startsWith("=") ||
        value.includes("<")
      ) {
        continue;
      }
      const start = el.startTagEnd + raw.indexOf(value);
      const info = typeInfo(elType);
      out.push({
        kind: "content",
        refType: info?.kind === "simple" ? info.refType : null,
        selfType: null,
        value,
        line: lineOf(lineMap, start),
        start,
        end: start + value.length,
      });
    }
  }
}

/** Converts a shallow scan (offsets) into index records (1-based lines). */
export function recordsFromShallow(scan: ShallowDocument, lineMap: LineMap): IndexRecords {
  return {
    assets: scan.assets.map((a) => ({
      type: a.name,
      id: a.id,
      line: lineOf(lineMap, a.idValueStart),
    })),
    defines: scan.defines.map((d) => ({
      name: d.name,
      value: d.value,
      line: lineOf(lineMap, d.start),
    })),
    includes: scan.includes.map((i) => ({
      type: i.type,
      source: i.source,
      line: lineOf(lineMap, i.start),
    })),
    rootXiIncludes: scan.rootXiIncludes.map((x) => ({
      href: x.href,
      xpointer: x.xpointer,
      line: lineOf(lineMap, x.start),
    })),
    nestedXiIncludes: scan.nestedXiIncludes.map((x) => ({
      href: x.href,
      xpointer: x.xpointer,
      line: lineOf(lineMap, x.start),
    })),
    references: [],
  };
}
