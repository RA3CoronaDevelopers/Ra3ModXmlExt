/**
 * Shared semantic reference logic used by Find All References, the CodeLens
 * "N references" command and (indirectly) the unreferenced-assets report.
 *
 * Unlike the old text-search implementation, every result here comes from
 * the reverse reference index built during indexing, so the count shown on a
 * top-level asset always matches the references peek opened by clicking it.
 */

import * as vscode from "vscode";
import {
  findElementAt,
  parseXml,
  textContentTokenAt,
} from "../language/xmlParser";
import { resolveElementType } from "../language/typeContext";
import { attributesOfType, contentInfoOfType } from "../model/schemaModel";
import {
  filterAndScoreDefs,
  isReferenceAttributeOfType,
  isReferenceContentType,
  mergeLocalAndGlobalDefs,
} from "../indexer/refs";
import {
  referenceSitesForDef,
  scheduleRebuildIfRecordsDesync,
} from "../indexer/referenceIndex";
import type { AssetDef, ModIndex, ReferenceSite } from "../indexer/types";
import type { ModWorkspace } from "../workspace";

export interface ReferenceContext {
  id: string;
  /** XSD refType when the cursor is on a typed reference; null otherwise. */
  refType: string | null;
  /** Element type for inheritFrom filtering; null otherwise. */
  selfType: string | null;
}

/**
 * Extracts the referenced id and its XSD context from the cursor position.
 * Works on reference attribute values/names, simple-content text and on an
 * asset's own `id` definition (where every same-id definition is a target).
 */
export function referenceContextAt(
  document: vscode.TextDocument,
  offset: number,
): ReferenceContext | null {
  const text = document.getText();
  const doc = parseXml(text);
  const el = findElementAt(doc, offset);
  if (!el) return null;
  const elType = resolveElementType(el);
  const attr = el.attrs.find(
    (a) =>
      (a.hasValue && offset >= a.valueStart && offset <= a.valueEnd) ||
      (offset >= a.nameStart && offset <= a.nameEnd),
  );

  if (attr?.hasValue) {
    const value = attr.value;
    if (!value || value.startsWith("$") || value.startsWith("=")) return null;
    const nameLower = attr.name.toLowerCase();
    if (nameLower === "id") {
      return { id: value, refType: null, selfType: null };
    }
    if (!isReferenceAttributeOfType(elType, attr.name)) return null;
    if (nameLower === "inheritfrom") {
      return { id: value, refType: null, selfType: elType };
    }
    const attrInfo = elType
      ? attributesOfType(elType).find((a) => a.name === attr.name)
      : undefined;
    return { id: value, refType: attrInfo?.refType ?? null, selfType: null };
  }

  if (elType && isReferenceContentType(elType)) {
    const token = textContentTokenAt(text, el, offset);
    if (token && !token.value.startsWith("$") && !token.value.startsWith("=")) {
      const info = contentInfoOfType(elType);
      return {
        id: token.value,
        refType: info?.refType ?? null,
        selfType: null,
      };
    }
  }
  return null;
}

/** Definitions matching a reference context (strict type filtering). */
export function definitionsForReference(
  idx: ModIndex,
  ctx: ReferenceContext,
): AssetDef[] {
  const defs = mergeLocalAndGlobalDefs(
    idx.local?.assetsById.get(ctx.id.toLowerCase()),
    idx.assetsById.get(ctx.id.toLowerCase()),
  );
  return filterAndScoreDefs(defs, ctx.refType, ctx.selfType).map((t) => t.def);
}

/** Union of reference sites for a set of definitions, de-duplicated. */
export function collectReferenceSites(
  idx: ModIndex,
  defs: readonly AssetDef[],
): ReferenceSite[] {
  const sites: ReferenceSite[] = [];
  const seen = new Set<string>();
  for (const def of defs) {
    for (const site of referenceSitesForDef(idx, def)) {
      const key = `${site.file}\u0000${site.start}\u0000${site.end}\u0000${site.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sites.push(site);
    }
  }
  return sites;
}

/** Converts stored offsets to precise editor locations (fallback: line). */
export async function sitesToLocations(
  ws: ModWorkspace,
  sites: readonly ReferenceSite[],
): Promise<vscode.Location[]> {
  const byFile = new Map<string, ReferenceSite[]>();
  for (const site of sites) {
    let list = byFile.get(site.file);
    if (!list) {
      list = [];
      byFile.set(site.file, list);
    }
    list.push(site);
  }

  const locations: vscode.Location[] = [];
  for (const [file, fileSites] of byFile) {
    const parsed = await (ws.indexerForFile(file) ?? ws.activeIndexer())?.readDom(
      file,
    );
    const lineMap = parsed?.lineMap ?? null;
    for (const site of fileSites) {
      if (lineMap) {
        const start = lineMap.positionAt(site.start);
        const end = lineMap.positionAt(site.end);
        locations.push(
          new vscode.Location(
            vscode.Uri.file(file),
            new vscode.Range(
              new vscode.Position(start.line, start.character),
              new vscode.Position(end.line, end.character),
            ),
          ),
        );
      } else {
        const line = Math.max(0, site.line - 1);
        locations.push(
          new vscode.Location(
            vscode.Uri.file(file),
            new vscode.Range(
              new vscode.Position(line, 0),
              new vscode.Position(line, 1),
            ),
          ),
        );
      }
    }
  }
  return locations;
}

/**
 * Semantic Find All References (used by the reference provider).
 *
 * Only real reference sites are returned — the asset's own `id` definition is
 * never included, regardless of VS Code's `includeDeclaration` flag, so the
 * result set matches the CodeLens reference count exactly.
 */
export async function findReferenceLocations(
  ws: ModWorkspace,
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<vscode.Location[] | null> {
  if (!ws.isRa3Workspace()) return null;
  scheduleRebuildIfRecordsDesync(ws.recordsSyncSurfaceFor(document), document);
  const scope = await ws.getScope(document);
  const idx = scope.merged;
  if (!idx) return null;
  const ctx = referenceContextAt(document, document.offsetAt(position));
  if (!ctx) return null;
  const defs = definitionsForReference(idx, ctx);
  if (!defs.length) return null;

  const locations = await sitesToLocations(ws, collectReferenceSites(idx, defs));
  return locations.length ? locations : null;
}

/** Arguments passed from the CodeLens to the showReferences command. */
export interface ShowReferencesArgs {
  uri: vscode.Uri;
  position: vscode.Position;
  id: string;
  type: string;
  file: string;
  line: number;
}

/** Opens the references peek for one specific asset definition. */
export async function showReferencesForDef(
  ws: ModWorkspace,
  args: ShowReferencesArgs,
): Promise<void> {
  const doc = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === args.uri.toString(),
  );
  if (!doc) return;
  let idx: ModIndex | null = null;
  try {
    idx = (await ws.getCodeLensScope(doc)).merged;
  } catch {
    return;
  }
  if (!idx) return;
  // Same definition union as the lens count / Find All References.
  const defs = definitionsForReference(idx, {
    id: args.id,
    refType: null,
    selfType: null,
  });
  const sites = collectReferenceSites(idx, defs);
  const locations = await sitesToLocations(ws, sites);
  await vscode.commands.executeCommand(
    "editor.action.showReferences",
    args.uri,
    args.position,
    locations,
  );
}
