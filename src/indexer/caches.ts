/**
 * Caches shared by the indexer.
 *
 * The workspace owns one instance of each cache and passes them into every
 * ModIndexer, so a rebuild (which creates a fresh indexer) does not re-read
 * files whose stat (mtime/size) is unchanged. This is what makes indexing
 * large art-asset corpora (Corona: ~3800 .w3x files, 2.6 GB) practical:
 * after the first build, save-triggered rebuilds only re-scan files that
 * actually changed.
 */

import { resolve } from "node:path";
import type { IndexedFile, ParsedFile } from "./types";
import type { IndexRecords } from "./records";
import type { ResolveResult } from "./includeResolver";

/** Case-insensitive absolute path key. */
export function normKey(path: string): string {
  return resolve(path).toLowerCase();
}

/**
 * LRU cache for fully parsed XML documents.
 *
 * Parse trees of huge mods can be memory-heavy (~17x the source text), so
 * retention is bounded twice: by entry count (least-recently-used eviction)
 * and by a total element budget (largest trees are evicted first). Evicted
 * entries are re-read from disk on demand.
 */
export class DocumentCache {
  private map = new Map<string, ParsedFile>();
  private totalElements = 0;

  constructor(
    private capacity = 64,
    private elementBudget = 2_000_000,
  ) {}

  get(path: string): ParsedFile | undefined {
    const key = normKey(path);
    const hit = this.map.get(key);
    if (!hit) return undefined;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  /** Number of cached documents (for diagnostics). */
  get size(): number {
    return this.map.size;
  }

  /** Total elements held by cached parse trees (for diagnostics). */
  get elements(): number {
    return this.totalElements;
  }

  set(parsed: ParsedFile): void {
    const key = normKey(parsed.file.path);
    const prev = this.map.get(key);
    if (prev) this.totalElements -= elementCount(prev);
    this.map.delete(key);
    this.map.set(key, parsed);
    this.totalElements += elementCount(parsed);
    this.evict();
  }

  invalidate(path: string): void {
    const key = normKey(path);
    const prev = this.map.get(key);
    if (prev) this.totalElements -= elementCount(prev);
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
    this.totalElements = 0;
  }

  private evict(): void {
    while (this.map.size > this.capacity || this.totalElements > this.elementBudget) {
      if (this.map.size === 0) break;
      if (this.map.size > this.capacity) {
        // Over capacity: drop the least recently used entry.
        const oldest = this.map.keys().next().value;
        if (oldest === undefined) break;
        this.remove(oldest);
      } else {
        // Over the element budget: drop the largest tree, which frees the
        // most memory per eviction.
        let largestKey: string | undefined;
        let largest = -1;
        for (const [key, value] of this.map) {
          const n = elementCount(value);
          if (n > largest) {
            largest = n;
            largestKey = key;
          }
        }
        if (largestKey === undefined || largest <= 0) break;
        this.remove(largestKey);
      }
    }
  }

  private remove(key: string): void {
    const prev = this.map.get(key);
    if (prev) this.totalElements -= elementCount(prev);
    this.map.delete(key);
  }
}

function elementCount(parsed: ParsedFile): number {
  return parsed.parse?.elements.length ?? 0;
}

export interface IndexRecordsCacheEntry {
  stat: IndexedFile["stat"];
  records: IndexRecords;
  /** "shallow" for art-asset scans (.w3x), "full" for parsed XML. */
  kind: "shallow" | "full";
}

/**
 * Cache for per-file index records (top-level assets, defines, includes,
 * xi:include targets). Records are tiny compared to DOM trees or line maps of
 * multi-megabyte model files, so the capacity comfortably covers a whole mod
 * (Corona: ~9k files) and rebuilds never re-read unchanged files.
 */
export class IndexRecordsCache {
  private map = new Map<string, IndexRecordsCacheEntry>();

  constructor(private capacity = 16384) {}

  get(path: string): IndexRecordsCacheEntry | undefined {
    const key = normKey(path);
    const hit = this.map.get(key);
    if (!hit) return undefined;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  /** Number of cached record sets (for diagnostics). */
  get size(): number {
    return this.map.size;
  }

  set(path: string, entry: IndexRecordsCacheEntry): void {
    const key = normKey(path);
    this.map.delete(key);
    this.map.set(key, entry);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  invalidate(path: string): void {
    this.map.delete(normKey(path));
  }

  clear(): void {
    this.map.clear();
  }
}

/**
 * Cache for Include/@source (and xi:include/@href) resolution results.
 *
 * Resolving a source performs synchronous statSync existence checks against
 * every search base; a Corona build issues ~110k of them (tens of seconds on
 * a mechanical drive). Content edits never change *existence*, so this cache
 * survives content rebuilds and is only cleared when files are created or
 * deleted (or on a forced reindex).
 */
export class IncludeResolveCache {
  private map = new Map<string, ResolveResult>();
  private manifestMap = new Map<string, string | null>();

  constructor(private capacity = 262144) {}

  get(key: string): ResolveResult | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  set(key: string, result: ResolveResult): void {
    this.map.delete(key);
    this.map.set(key, result);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  getManifest(key: string): string | null | undefined {
    const hit = this.manifestMap.get(key);
    if (hit === undefined) return undefined;
    this.manifestMap.delete(key);
    this.manifestMap.set(key, hit);
    return hit;
  }

  setManifest(key: string, path: string | null): void {
    this.manifestMap.delete(key);
    this.manifestMap.set(key, path);
    if (this.manifestMap.size > this.capacity) {
      const oldest = this.manifestMap.keys().next().value;
      if (oldest !== undefined) this.manifestMap.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
    this.manifestMap.clear();
  }

  /** Number of cached resolutions (for diagnostics). */
  get size(): number {
    return this.map.size;
  }
}
