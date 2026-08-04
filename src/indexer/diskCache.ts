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
 * - on load, each file is stat-validated (no content reads); mismatches and
 *   missing files are dropped and re-read during the build;
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

export const DISK_CACHE_VERSION = 1;
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
   * Loads and stat-validates the cache. Returns the kept records plus load
   * statistics; missing/corrupt/key-mismatched caches yield an empty result
   * instead of an error.
   */
  async loadValidated(): Promise<{
    records: DiskCacheRecord[];
    stats: DiskCacheLoadStats;
  }> {
    const stats: DiskCacheLoadStats = {
      fileExists: false,
      keyMatched: false,
      loaded: 0,
      validated: 0,
      dropped: 0,
    };
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
    if (!raw) return { records: [], stats };

    stats.keyMatched = true;
    stats.loaded = raw.records.length;
    const kept: DiskCacheRecord[] = [];
    for (let i = 0; i < raw.records.length; i += VALIDATE_CONCURRENCY) {
      const chunk = raw.records.slice(i, i + VALIDATE_CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (rec): Promise<DiskCacheRecord | null> => {
          try {
            const s = await stat(rec.key);
            if (
              s.isFile() &&
              s.size === rec.stat.size &&
              s.mtimeMs === rec.stat.mtimeMs &&
              s.birthtimeMs === rec.stat.birthtimeMs &&
              s.ctimeMs === rec.stat.ctimeMs
            ) {
              return rec;
            }
          } catch {
            // File missing or inaccessible.
          }
          return null;
        }),
      );
      for (const r of results) {
        if (r) {
          kept.push(r);
          stats.validated++;
        } else {
          stats.dropped++;
        }
      }
    }
    return { records: kept, stats };
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
