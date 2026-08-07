/**
 * Reverse reference index built from per-file reference records.
 *
 * The indexer stores compact reference records per file (attribute values,
 * simple-content text and inheritFrom, with XSD `refType`/`selfType` context
 * captured at parse time). After the include walk, this module resolves every
 * record against the final asset maps and produces:
 *
 *   definition key -> reference sites
 *
 * which powers CodeLens reference counts, semantic Find All References and
 * the "unreferenced assets" report. Pure TypeScript: no vscode dependency.
 */

import { extractIndexRecords, type IndexRecords } from "./records";
import {
  filterAndScoreDefs,
  isReferenceTargetType,
  type ReferenceLookup,
} from "./refs";
import { buildSearchPaths, resolveSource } from "./includeResolver";
import { normKey, recordsHash } from "./caches";
import { LineMap, parseXml } from "../language/xmlParser";
import type { AssetDef, ModIndex, ReferenceSite } from "./types";

/** A file whose reference records should be resolved. */
export interface ReferenceRecordSource {
  /** Absolute path of the referencing file. */
  file: string;
  records: IndexRecords;
}

/** Stable key identifying one specific asset definition. */
export function assetDefKey(
  def: Pick<AssetDef, "type" | "id" | "file" | "line">,
): string {
  return `${def.type}\u0000${def.id.toLowerCase()}\u0000${def.file.toLowerCase()}\u0000${def.line}`;
}

/**
 * Resolves per-file reference records against the asset lookup and returns
 * the reverse map. A record resolves to every definition that satisfies its
 * `refType` / `selfType` context (same strict filtering as go-to-definition),
 * so same-name ids of different types never share reference counts.
 */
export function buildReferenceIndex(
  sources: Iterable<ReferenceRecordSource>,
  lookup: ReferenceLookup,
): Map<string, ReferenceSite[]> {
  const map = new Map<string, ReferenceSite[]>();
  for (const { file, records } of sources) {
    for (const ref of records.references) {
      const defs = lookup.assetsById.get(ref.value.toLowerCase());
      if (!defs?.length) continue;
      const targets = filterAndScoreDefs(defs, ref.refType, ref.selfType);
      for (const target of targets) {
        const key = assetDefKey(target.def);
        let sites = map.get(key);
        if (!sites) {
          sites = [];
          map.set(key, sites);
        }
        sites.push({
          file,
          line: ref.line,
          start: ref.start,
          end: ref.end,
          kind: ref.kind,
        });
      }
    }
  }
  return map;
}

/** Reference sites for one definition (empty when the index has none). */
export function referenceSitesForDef(
  idx: Pick<ModIndex, "references"> | null | undefined,
  def: Pick<AssetDef, "type" | "id" | "file" | "line">,
): ReferenceSite[] {
  return idx?.references?.get(assetDefKey(def)) ?? [];
}

function normFileKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/**
 * Reference sites that belong to a definition opened in the editor.
 *
 * Besides the definition's own reverse-index bucket, this unions the sites
 * of manifest definitions that map back to the same XML source file via
 * `manifestSource`. A manifest asset with a resolvable SageXml source is
 * semantically the same asset as that XML definition, so references to it
 * should show up on the source file's CodeLens too (Find All References
 * already sees them because it unions every same-id/type definition).
 */
export function referenceSitesForDefinition(
  idx: ModIndex,
  def: Pick<AssetDef, "type" | "id" | "file" | "line">,
): ReferenceSite[] {
  const sites = referenceSitesForDef(idx, def);
  const byId = idx.assets.get(def.type)?.get(def.id.toLowerCase());
  if (!byId?.length) return sites;

  const defFile = normFileKey(def.file);
  const searchPaths = buildSearchPaths(idx.sdkDir, idx.projectDir);
  const seen = new Set(
    sites.map((s) => `${s.file}\u0000${s.start}\u0000${s.end}\u0000${s.kind}`),
  );
  for (const other of byId) {
    if (other.origin !== "manifest" || !other.manifestSource) continue;
    const resolved = resolveSource(other.manifestSource, null, searchPaths).path;
    if (!resolved || normFileKey(resolved) !== defFile) continue;
    for (const site of referenceSitesForDef(idx, other)) {
      const key = `${site.file}\u0000${site.start}\u0000${site.end}\u0000${site.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sites.push(site);
    }
  }
  return sites;
}

export interface UnreferencedOptions {
  /**
   * When true (default), only report types that are reference targets by
   * design. Auto-registered / structural types (settings, map metadata,
   * w3x sub-assets...) are excluded because zero references is their normal
   * state.
   */
  onlyReferenceTargetTypes?: boolean;
}

/**
 * Project asset definitions with zero incoming references, grouped by type.
 * Manifest / SDK definitions and `instance`-only assets are never reported
 * (they are not part of the compiled stream in the same way).
 */
export function unreferencedByType(
  idx: ModIndex,
  options: UnreferencedOptions = {},
): Map<string, AssetDef[]> {
  const onlyReferenceTargets = options.onlyReferenceTargetTypes ?? true;
  const out = new Map<string, AssetDef[]>();
  for (const [type, byId] of idx.assets) {
    if (onlyReferenceTargets && !isReferenceTargetType(type)) continue;
    const defs: AssetDef[] = [];
    for (const arr of byId.values()) {
      for (const def of arr) {
        if (def.origin !== "project" || def.viaInstance) continue;
        if (referenceSitesForDef(idx, def).length > 0) continue;
        defs.push(def);
      }
    }
    if (defs.length) {
      defs.sort((a, b) => a.id.localeCompare(b.id));
      out.set(type, defs);
    }
  }
  return out;
}

/** Minimal workspace surface needed by the records-desync self-heal. */
export interface RecordsSyncWorkspace {
  index: ModIndex | null;
  invalidate(path: string): void;
  scheduleRebuild(reason: string): void;
}

/** Minimal document surface (vscode.TextDocument subset, no vscode dep). */
export interface RecordsSyncDocument {
  uri: { fsPath: string; scheme?: string };
  isDirty?: boolean;
  getText(): string;
}

/**
 * True when a clean (saved) document's text no longer matches the records the
 * published snapshot was built from. This catches cache entries that slipped
 * through stat validation (e.g. a rewrite with preserved timestamps on an
 * external drive) or watcher events lost during a drive reconnect.
 */
export function documentRecordsDesynced(
  idx: ModIndex,
  fsPath: string,
  text: string,
): boolean {
  const expected = idx.recordsHashes?.get(normKey(fsPath));
  if (expected == null) return false;
  const lineMap = new LineMap(text);
  const records = extractIndexRecords(parseXml(text), lineMap, text);
  return recordsHash(records) !== expected;
}

/**
 * Self-heal: when the open, saved document's content differs from the
 * snapshot's records hash, invalidate exactly that file and schedule a
 * rebuild. Returns true when a rebuild was scheduled. Unsaved (dirty)
 * documents are skipped — the editor text is intentionally ahead of disk.
 */
export function scheduleRebuildIfRecordsDesync(
  ws: RecordsSyncWorkspace,
  document: RecordsSyncDocument,
): boolean {
  if (
    document.isDirty ||
    (document.uri.scheme != null && document.uri.scheme !== "file")
  ) {
    return false;
  }
  const idx = ws.index;
  if (!idx) return false;
  const fsPath = document.uri.fsPath;
  if (!documentRecordsDesynced(idx, fsPath, document.getText())) return false;
  ws.invalidate(fsPath);
  ws.scheduleRebuild("records-desync");
  return true;
}
