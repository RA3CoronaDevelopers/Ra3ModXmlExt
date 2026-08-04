/**
 * Lazy file-existence snapshot for include resolution.
 *
 * `resolveSource` performs synchronous `statSync` existence checks against
 * every search base; a cold Corona build does ~110k of them (tens of seconds
 * on a mechanical drive). Instead, existence is answered by reading the
 * candidate's **parent directory** once (`readdir`, no per-file stat) and
 * caching the entry set for the rest of the build. Only directories that are
 * actually queried are ever listed, so a cold build pays a handful of
 * readdir calls instead of an upfront recursive enumeration of every search
 * root (which measurably slowed the XML phase).
 *
 * Correctness: the workspace clears `IncludeResolveCache` on file
 * create/delete; each rebuild creates a fresh snapshot, and the debounced
 * rebuild triggered by the watcher converges if anything changed mid-build.
 *
 * Pure TypeScript: no vscode dependency.
 */

import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, parse, resolve, sep } from "node:path";
import { normKey } from "./caches";
import type { SearchPaths } from "./includeResolver";

/**
 * Answers file-existence questions from lazily read directory listings.
 * `has()` is authoritative for paths inside the roots and returns null for
 * paths the snapshot does not cover (the caller falls back to `statSync`).
 */
export class ExistenceSnapshot {
  private roots: string[] = [];
  /** parent dir (normalized) -> lowercased file names, or null (no dir). */
  private dirCache = new Map<string, Set<string> | null>();
  /** Existence answers served from cached directory listings. */
  hits = 0;
  /** Paths outside the snapshot that required a statSync fallback. */
  fallbacks = 0;

  constructor(roots: string[]) {
    // Roots and lookups must use the same normalization (case-insensitive on
    // Windows), otherwise `startsWith` misses due to case differences.
    this.roots = roots.map((r) => {
      const n = normKey(r);
      return n.endsWith(sep) ? n : n + sep;
    });
  }

  /** true/false when covered by the snapshot, null when not covered. */
  has(absPath: string): boolean | null {
    const parentKey = normKey(dirname(absPath));
    if (!this.isCovered(parentKey)) {
      this.fallbacks++;
      return null;
    }
    let entries = this.dirCache.get(parentKey);
    if (entries === undefined) {
      entries = listDirEntries(parentKey);
      this.dirCache.set(parentKey, entries);
    }
    this.hits++;
    return entries ? entries.has(basename(absPath).toLowerCase()) : false;
  }

  private isCovered(dirKey: string): boolean {
    const key = dirKey.endsWith(sep) ? dirKey : dirKey + sep;
    for (const root of this.roots) {
      if (key.startsWith(root)) return true;
    }
    return false;
  }
}

function listDirEntries(dir: string): Set<string> | null {
  try {
    const out = new Set<string>();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile()) out.add(entry.name.toLowerCase());
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * True when `dir` is a filesystem root (e.g. "C:\" or "/"). Such roots are
 * never treated as search bases (they may contain the whole disk).
 */
export function isDriveRoot(dir: string): boolean {
  const resolved = resolve(dir);
  return parse(resolved).root === resolved;
}

/**
 * Builds the snapshot root list from the search bases: drive roots and
 * missing directories are skipped, and a root covered by a broader root is
 * dropped (e.g. `sdkDir` covers `sdkDir/SageXml`). No directory is listed
 * here; listings happen lazily per queried parent directory.
 */
export function buildExistenceSnapshot(searchPaths: SearchPaths): ExistenceSnapshot {
  const candidates = [
    ...searchPaths.DATA,
    ...searchPaths.ART,
    ...searchPaths.AUDIO,
  ].map((r) => resolve(r));
  candidates.sort((a, b) => a.length - b.length);

  const roots: string[] = [];
  for (const root of candidates) {
    if (isDriveRoot(root)) continue;
    if (!existsSync(root)) continue;
    const normalized = normKey(root);
    if (roots.some((r) => normalized.startsWith(r + sep))) continue;
    roots.push(normalized);
  }
  return new ExistenceSnapshot(roots);
}
