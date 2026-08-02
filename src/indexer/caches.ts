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
import type { ParsedFile } from "./types";

/** Case-insensitive absolute path key. */
export function normKey(path: string): string {
  return resolve(path).toLowerCase();
}

/**
 * LRU cache for fully parsed XML documents. Parse trees of huge mods can be
 * memory-heavy, so only a bounded number of recent documents is retained;
 * evicted entries are re-read from disk on demand.
 */
export class DocumentCache {
  private map = new Map<string, ParsedFile>();

  constructor(private capacity = 64) {}

  get(path: string): ParsedFile | undefined {
    const key = normKey(path);
    const hit = this.map.get(key);
    if (!hit) return undefined;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  set(parsed: ParsedFile): void {
    const key = normKey(parsed.file.path);
    this.map.delete(key);
    this.map.set(key, parsed);
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
 * Cache for shallow-scanned art-asset documents (.w3x and content-sniffed
 * XML files). The retained records are tiny (top-level assets, includes,
 * defines) compared to a full DOM, so the capacity can be much larger.
 */
export class ShallowScanCache {
  private map = new Map<string, ParsedFile>();

  constructor(private capacity = 8192) {}

  get(path: string): ParsedFile | undefined {
    const key = normKey(path);
    const hit = this.map.get(key);
    if (!hit) return undefined;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  set(parsed: ParsedFile): void {
    const key = normKey(parsed.file.path);
    this.map.delete(key);
    this.map.set(key, parsed);
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
