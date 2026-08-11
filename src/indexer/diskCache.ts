/**
 * On-disk persistence for per-file index records.
 *
 * The records cache (top-level assets / defines / includes / xi:include with
 * line numbers) is tiny compared to the source corpus (Corona: ~9k files,
 * ~10 MB in memory), but rebuilding it from scratch means reading ~2.6 GB of
 * art assets again. Persisting it makes a cold start cost a stat validation
 * pass (~seconds on SSD, a few to tens of seconds on a mechanical drive)
 * instead of a full rebuild.
 *
 * Correctness model (layered):
 * - every cached record stores a multi-signal stamp
 *   `{ size, mtimeMs, birthtimeMs, ctimeMs }`;
 * - a cold start seeds the in-memory cache immediately (`load`) and runs the
 *   stat pass in the background (`validate`, no content reads); mismatches
 *   and missing files are invalidated and re-read by a follow-up rebuild
 *   (the workspace's stale/dirty mechanism converges);
 * - during a session the file watcher invalidates entries precisely;
 * - `ra3modxml.reindex` / `ra3modxml.clearCache` remain the final authority.
 *
 * The file is gzip-compressed JSON written atomically (temp + rename), keyed
 * by project identity + settings so stale caches are ignored automatically.
 *
 * Pure TypeScript: no vscode dependency.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import type { IndexRecordsCacheEntry } from "./caches";
import type { IndexRecords } from "./records";
import type { IndexedFile } from "./types";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * v2: per-file records now carry typed reference records (`references`),
 * so caches produced by v1 (assets/defines/includes only) are stale.
 * v3: full XML records carry `contentHash`, and snapshots publish per-file
 * `recordsHashes` for the desync self-heal; caches without hashes cannot be
 * verified, so v2 files are regenerated once.
 */
export const DISK_CACHE_VERSION = 3;
/** How many stat validations run concurrently on load. */
const VALIDATE_CONCURRENCY = 32;

/** Settings that change what the index contains; a mismatch ignores the cache. */
export interface DiskCacheIdentity {
  projectDir: string;
  sdkDir: string;
  indexSageXml: boolean;
  additionalDataSearchPaths: string[];
  builtmodsDirs: string[];
}

export interface DiskCacheRecord {
  /** Normalized cache key (see `normKey`). */
  key: string;
  stat: NonNullable<IndexedFile["stat"]>;
  records: IndexRecords;
  kind: "full" | "shallow";
  /** Content hash for full XML parses (see `IndexRecordsCacheEntry`). */
  contentHash?: string;
}

interface DiskCacheFile {
  version: number;
  key: string;
  savedAt: string;
  records: DiskCacheRecord[];
}

export interface DiskCacheLoadStats {
  fileExists: boolean;
  keyMatched: boolean;
  /** Records stored in the file. */
  loaded: number;
  /** Records whose stat still matches (kept). */
  validated: number;
  /** Records dropped because the file changed, moved or was deleted. */
  dropped: number;
  /** Milliseconds spent reading / decompressing / parsing the cache file. */
  loadMs: number;
  /** Milliseconds spent stat-validating cached entries. */
  validateMs: number;
}

function emptyLoadStats(): DiskCacheLoadStats {
  return {
    fileExists: false,
    keyMatched: false,
    loaded: 0,
    validated: 0,
    dropped: 0,
    loadMs: 0,
    validateMs: 0,
  };
}

export function diskCacheKey(identity: DiskCacheIdentity): string {
  return createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")
    .slice(0, 16);
}

export class DiskRecordsCache {
  constructor(
    private readonly filePath: string,
    private readonly identity: DiskCacheIdentity,
  ) {}

  get path(): string {
    return this.filePath;
  }

  /**
   * Loads the cache file without validating entries. This is fast (read +
   * gunzip + JSON parse) so a cold start can seed the in-memory records
   * cache immediately and let stat validation run in the background.
   * Missing/corrupt/key-mismatched caches yield an empty result instead of
   * an error.
   */
  async load(): Promise<{
    records: DiskCacheRecord[];
    stats: DiskCacheLoadStats;
  }> {
    const start = Date.now();
    const stats = emptyLoadStats();
    let raw: DiskCacheFile | null = null;
    try {
      const buf = await readFile(this.filePath);
      stats.fileExists = true;
      const text = (await gunzipAsync(buf)).toString("utf8");
      const parsed = JSON.parse(text);
      if (
        parsed &&
        parsed.version === DISK_CACHE_VERSION &&
        parsed.key === diskCacheKey(this.identity) &&
        Array.isArray(parsed.records)
      ) {
        raw = parsed as DiskCacheFile;
      }
    } catch {
      // Missing or corrupt cache: fall through with an empty result.
    }
    stats.loadMs = Date.now() - start;
    if (!raw) return { records: [], stats };

    stats.keyMatched = true;
    stats.loaded = raw.records.length;
    return { records: raw.records, stats };
  }

  /**
   * Stat-validates cached records. Returns the entries that still match
   * plus the keys that must be re-read (missing / changed / moved).
   */
  async validate(
    records: DiskCacheRecord[],
    onProgress?: (validatedCount: number, total: number) => void,
  ): Promise<{
    stats: DiskCacheLoadStats;
    kept: DiskCacheRecord[];
    invalidKeys: string[];
  }> {
    const start = Date.now();
    const stats = emptyLoadStats();
    stats.fileExists = true;
    stats.keyMatched = true;
    stats.loaded = records.length;
    const kept: DiskCacheRecord[] = [];
    const invalidKeys: string[] = [];
    for (let i = 0; i < records.length; i += VALIDATE_CONCURRENCY) {
      const chunk = records.slice(i, i + VALIDATE_CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (rec, index): Promise<{ rec: DiskCacheRecord | null; index: number }> => {
          try {
            const s = await stat(rec.key);
            if (
              s.isFile() &&
              s.size === rec.stat.size &&
              s.mtimeMs === rec.stat.mtimeMs &&
              s.birthtimeMs === rec.stat.birthtimeMs &&
              s.ctimeMs === rec.stat.ctimeMs
            ) {
              return { rec, index };
            }
          } catch {
            // File missing or inaccessible.
          }
          return { rec: null, index };
        }),
      );
      for (const { rec, index } of results) {
        if (rec) {
          kept.push(rec);
          stats.validated++;
        } else {
          stats.dropped++;
          invalidKeys.push(chunk[index].key);
        }
      }
      onProgress?.(stats.validated, records.length);
    }
    stats.validateMs = Date.now() - start;
    return { stats, kept, invalidKeys };
  }

  /**
   * Loads and stat-validates the cache (blocking validation). Used by
   * tests and kept as a convenience; the workspace normally prefers
   * `load()` + background `validate()`.
   */
  async loadValidated(): Promise<{
    records: DiskCacheRecord[];
    stats: DiskCacheLoadStats;
  }> {
    const { records, stats } = await this.load();
    if (!records.length) return { records, stats };
    const validation = await this.validate(records);
    return {
      records: validation.kept,
      stats: {
        ...stats,
        validated: validation.stats.validated,
        dropped: validation.stats.dropped,
        validateMs: validation.stats.validateMs,
      },
    };
  }

  /** Writes the current records cache atomically (temp file + rename). */
  async save(
    entries: Iterable<[string, IndexRecordsCacheEntry]>,
  ): Promise<void> {
    const records: DiskCacheRecord[] = [];
    for (const [key, entry] of entries) {
      if (!entry.stat) continue;
      records.push({
        key,
        stat: entry.stat,
        records: entry.records,
        kind: entry.kind,
        contentHash: entry.contentHash,
      });
    }
    const payload: DiskCacheFile = {
      version: DISK_CACHE_VERSION,
      key: diskCacheKey(this.identity),
      savedAt: new Date().toISOString(),
      records,
    };
    const buf = await gzipAsync(Buffer.from(JSON.stringify(payload), "utf8"));
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, buf);
    await rename(tmp, this.filePath);
  }

  /** Deletes the cache file (used by the clear-cache command). */
  async clear(): Promise<void> {
    try {
      await rm(this.filePath, { force: true });
    } catch {
      // Best effort.
    }
  }

  async status(): Promise<{ exists: boolean; sizeBytes: number }> {
    try {
      const s = await stat(this.filePath);
      return { exists: s.isFile(), sizeBytes: s.size };
    } catch {
      return { exists: false, sizeBytes: 0 };
    }
  }
}
