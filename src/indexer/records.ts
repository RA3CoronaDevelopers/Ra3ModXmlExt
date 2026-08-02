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

export interface IndexRecords {
  assets: IndexRecordAsset[];
  defines: IndexRecordDefine[];
  includes: IndexRecordInclude[];
  /** <xi:include> elements that are direct children of the root. */
  rootXiIncludes: IndexRecordXi[];
  /** <xi:include> elements nested anywhere else in the document. */
  nestedXiIncludes: IndexRecordXi[];
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
export function extractIndexRecords(parse: XmlDocument, lineMap: LineMap): IndexRecords {
  const assets: IndexRecordAsset[] = [];
  const defines: IndexRecordDefine[] = [];
  const includes: IndexRecordInclude[] = [];
  const rootXiIncludes: IndexRecordXi[] = [];
  const nestedXiIncludes: IndexRecordXi[] = [];
  const root = parse.root;
  if (!root) return { assets, defines, includes, rootXiIncludes, nestedXiIncludes };

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

  return { assets, defines, includes, rootXiIncludes, nestedXiIncludes };
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
  };
}
