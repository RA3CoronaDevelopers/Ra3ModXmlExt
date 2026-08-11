import { dirname } from "node:path";
import type {
  LineMap,
  XmlDocument,
  XmlElement,
  XmlParseError,
} from "../language/xmlParser";
import { resolveElementType } from "../language/typeContext";
import { isAssignableTo } from "../model/schemaModel";
import { findXPointerContainer, localName } from "./xpointer";

/**
 * A logical document is the parsed tree of the currently open file with
 * supported `xi:include` targets spliced in place. Every node keeps its
 * original source file and offsets so diagnostics / hover / navigation can
 * map back to the real file.
 */
export interface LogicalElement extends Omit<XmlElement, "parent" | "children"> {
  parent: LogicalElement | null;
  children: LogicalElement[];
  sourceFile: string;
}

export interface LogicalDocument {
  root: LogicalElement | null;
  elements: LogicalElement[];
  /** Mirrors XmlDocument so existing helpers (findElementAt etc.) work. */
  errors: XmlParseError[];
  declarationEnd: number;
}

export interface ExpandContext {
  /** Resolves an xi:include href (BAB search order). */
  resolve(source: string, currentDir: string): string | null;
  /** Reads a target and guarantees a DOM parse tree. */
  readDom(path: string): Promise<{ parse: XmlDocument; lineMap: LineMap } | null>;
  /** Include-depth guard. Defaults to 64. */
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 64;

/**
 * Builds the logical document for `entryPath` by replacing supported
 * `xi:include` elements with their selected target children.
 *
 * The original xi:include node stays in `elements` (so hover keeps working)
 * but is removed from the logical child list; its selected content is spliced
 * in as siblings. Nodes are shallow-cloned shells with a rebuilt parent/child
 * chain, so cached parse trees in the indexer are never mutated.
 */
export async function expandDocument(
  entryPath: string,
  parse: XmlDocument,
  ctx: ExpandContext,
): Promise<LogicalDocument> {
  const elements: LogicalElement[] = [];
  const map = new Map<XmlElement, LogicalElement>();
  // Pre-create a logical shell for every original element (including orphan
  // nodes produced by the parser's unterminated-quote recovery). Parent
  // pointers follow the original tree so type context is preserved.
  for (const orig of parse.elements) {
    const parent = orig.parent ? map.get(orig.parent) ?? null : null;
    const clone = cloneNode(orig, parent, entryPath);
    map.set(orig, clone);
    elements.push(clone);
  }
  // Cycle guard is a recursion stack, not a global visited set: the same
  // fragment may legitimately be included under several parents.
  const stack = new Set<string>();
  const root = parse.root ? map.get(parse.root) ?? null : null;

  // Traverse from the real root plus any parser-recovery orphans (elements
  // whose parent is null but are not the root).
  const roots = new Set<XmlElement>();
  if (parse.root) roots.add(parse.root);
  for (const orig of parse.elements) {
    if (orig !== parse.root && orig.parent === null) roots.add(orig);
  }
  for (const origRoot of roots) {
    const logicalRoot = map.get(origRoot)!;
    await expandChildren(
      origRoot,
      logicalRoot,
      entryPath,
      0,
      ctx,
      elements,
      stack,
      map,
    );
  }
  return { root, elements, errors: parse.errors, declarationEnd: parse.declarationEnd };
}

function cloneNode(
  el: XmlElement,
  parent: LogicalElement | null,
  sourceFile: string,
): LogicalElement {
  return { ...el, parent, children: [], sourceFile };
}

async function expandChildren(
  origParent: XmlElement,
  logicalParent: LogicalElement,
  file: string,
  depth: number,
  ctx: ExpandContext,
  elements: LogicalElement[],
  stack: Set<string>,
  map?: Map<XmlElement, LogicalElement>,
): Promise<void> {
  for (const child of origParent.children) {
    await handleChild(child, logicalParent, file, depth, ctx, elements, stack, map);
  }
}

async function handleChild(
  orig: XmlElement,
  logicalParent: LogicalElement,
  file: string,
  depth: number,
  ctx: ExpandContext,
  elements: LogicalElement[],
  stack: Set<string>,
  map?: Map<XmlElement, LogicalElement>,
): Promise<void> {
  const isXi = orig.name.toLowerCase().startsWith("xi:") &&
    localName(orig.name).toLowerCase() === "include";
  if (isXi) {
    // Keep the xi:include itself discoverable (hover), but let its selected
    // content replace it in the logical child list.
    if (!map?.has(orig)) elements.push(cloneNode(orig, logicalParent, file));
    await expandXi(orig, logicalParent, file, depth, ctx, elements, stack);
    return;
  }

  let clone = map?.get(orig);
  if (!clone) {
    clone = cloneNode(orig, logicalParent, file);
    elements.push(clone);
  }
  logicalParent.children.push(clone);
  await expandChildren(orig, clone, file, depth + 1, ctx, elements, stack, map);
}

async function expandXi(
  xi: XmlElement,
  logicalParent: LogicalElement,
  parentFile: string,
  depth: number,
  ctx: ExpandContext,
  elements: LogicalElement[],
  stack: Set<string>,
): Promise<void> {
  const href = xi.attrs.find((a) => a.name === "href")?.value;
  if (!href) return;
  const resolved = ctx.resolve(href, dirname(parentFile));
  if (!resolved) return;

  const key = normPath(resolved);
  if (stack.has(key)) return; // include cycle
  if (depth > (ctx.maxDepth ?? DEFAULT_MAX_DEPTH)) return;
  stack.add(key);

  try {
    const target = await ctx.readDom(resolved);
    if (!target?.parse?.root) return;

    const xpointer = xi.attrs.find((a) => a.name === "xpointer")?.value ?? "";
    if (xpointer) {
      const container = findXPointerContainer(target.parse, xpointer);
      if (!container) return;
      for (const sel of container.children) {
        await handleChild(sel, logicalParent, resolved, depth + 1, ctx, elements, stack);
      }
    } else {
      // XInclude semantics: without an xpointer the whole target document is
      // included, i.e. its root element replaces the <xi:include> node.
      // RA3 fragments such as GenericCelestialBuildingSuicide.xml rely on this
      // to splice the module element itself (CreateObjectDie) into the parent.
      await handleChild(
        target.parse.root,
        logicalParent,
        resolved,
        depth + 1,
        ctx,
        elements,
        stack,
      );
    }
  } finally {
    stack.delete(key);
  }
}

/** True when a logical element's resolved XSD type is a GameObject. */
export function isGameObjectElement(el: LogicalElement): boolean {
  const type = resolveElementType(el);
  return type != null && isAssignableTo(type, "GameObject");
}

/** Nearest ancestor whose resolved type is a GameObject (or subclass). */
export function findContainingGameObject(
  el: LogicalElement,
): LogicalElement | null {
  let cur = el.parent;
  while (cur) {
    if (isGameObjectElement(cur)) return cur;
    cur = cur.parent;
  }
  return null;
}

export interface LocalIdInfo {
  id: string;
  el: LogicalElement;
}

/**
 * Collects every `id` defined inside a GameObject subtree (including modules
 * spliced in through xi:include). These are the candidates for Poid-typed
 * pipeline-local references such as AttachModuleId / ModuleId.
 */
export function collectLocalIds(root: LogicalElement): LocalIdInfo[] {
  const out: LocalIdInfo[] = [];
  const seen = new Set<string>();
  const stack: LogicalElement[] = [root];
  while (stack.length) {
    const el = stack.pop()!;
    const idAttr = el.attrs.find((a) => a.name === "id");
    if (idAttr?.hasValue) {
      const key = idAttr.value.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ id: idAttr.value, el });
      }
    }
    for (const child of el.children) stack.push(child);
  }
  return out;
}

/** Finds an id inside a GameObject subtree (case-insensitive). */
export function findLocalId(
  root: LogicalElement,
  id: string,
): LogicalElement | null {
  const wanted = id.toLowerCase();
  const stack: LogicalElement[] = [root];
  while (stack.length) {
    const el = stack.pop()!;
    const idAttr = el.attrs.find((a) => a.name === "id");
    if (idAttr?.hasValue && idAttr.value.toLowerCase() === wanted) return el;
    for (const child of el.children) stack.push(child);
  }
  return null;
}

function normPath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}
