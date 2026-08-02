import type { XmlDocument } from "../language/xmlParser";
import type { ManifestInfo } from "./manifestParser";
import type { LineMap } from "../language/xmlParser";
import type { IndexRecords } from "./records";
import type { DocumentCache, IncludeResolveCache, IndexRecordsCache } from "./caches";

export type AssetOrigin = "project" | "sdk" | "manifest";

export interface AssetDef {
  type: string;
  id: string;
  /** Absolute path of the defining file (for manifests: the manifest path). */
  file: string;
  /** 1-based line of the id attribute (or 0 when unknown, e.g. manifests). */
  line: number;
  origin: AssetOrigin;
  /** "static" or "global:<name>" when the asset comes from a stream. */
  stream?: string;
  /** Set for assets that are only reachable through `instance` includes. */
  viaInstance?: boolean;
  /** Manifest path for origin === "manifest". */
  manifest?: string;
  /** Source file recorded inside a manifest (e.g. "DATA:globaldata/armor.xml"). */
  manifestSource?: string;
}

export interface DefineDef {
  name: string;
  value: string;
  file: string;
  line: number;
  origin: AssetOrigin;
}

export interface IndexedFile {
  path: string;
  stat: { mtimeMs: number; size: number } | null;
}

export interface StreamInfo {
  name: string;
  entry: string;
  files: Set<string>;
}

export interface SourceCandidate {
  /** Suggested value for Include/@source. */
  source: string;
  /** Absolute path the candidate resolves to. */
  path: string;
  /** "DATA" | "ART" | "AUDIO" | null (relative). */
  prefix: "DATA" | "ART" | "AUDIO" | null;
  /** Directory that acts as the root of the relative path. */
  baseDir: string;
}

export interface IndexerDiagnostic {
  file: string;
  line: number;
  message: string;
  severity: "warning" | "error" | "information";
  code: string;
}

export interface IndexStats {
  projectDir: string;
  sdkDir: string;
  indexedFiles: number;
  parsedFiles: number;
  /** Art-asset documents indexed via shallow scan (no DOM tree). */
  shallowScannedFiles: number;
  /** Shallow scans served from the persistent cache (unchanged files). */
  shallowCacheHits: number;
  /** Parsed XML files served from the persistent records cache. */
  recordsCacheHits: number;
  /** Include/xi:include resolutions served from the resolve cache. */
  resolveCacheHits: number;
  /** Include/xi:include resolutions performed during this build. */
  resolveCalls: number;
  /** Time spent enumerating Include source candidates (ms). */
  candidatesMs: number;
  /** Time spent walking the include graph (ms). */
  walkMs: number;
  assetCount: number;
  defineCount: number;
  manifestFiles: number;
  manifestAssetCount: number;
  streams: number;
  sourceCandidates: number;
  elapsedMs: number;
}

export interface ModIndex {
  projectDir: string;
  sdkDir: string;
  /** type -> id -> definitions (project + sdk + manifest, deduplicated). */
  assets: Map<string, Map<string, AssetDef[]>>;
  /** id -> definitions across all types. */
  assetsById: Map<string, AssetDef[]>;
  /** `$NAME` -> definitions. */
  defines: Map<string, DefineDef[]>;
  /** absolute path -> file record (only files touched by the include walk). */
  files: Map<string, IndexedFile>;
  streams: StreamInfo[];
  manifests: Map<string, ManifestInfo>;
  /** Files suggested for Include/@source completion. */
  sourceCandidates: SourceCandidate[];
  /** Problems found while indexing (unresolved includes, cycles, ...). */
  diagnostics: IndexerDiagnostic[];
  stats: IndexStats;
}

export interface IndexOptions {
  projectDir: string;
  sdkDir: string;
  builtmodsDirs: string[];
  indexSageXml: boolean;
  additionalDataSearchPaths: string[];
  /** Directory walker used to enumerate files for source completion. */
  walker: FileWalker;
  /** Optional parse-tree cache shared across rebuilds (owned by the workspace). */
  documentCache?: DocumentCache;
  /** Optional index-records cache shared across rebuilds (owned by the workspace). */
  recordsCache?: IndexRecordsCache;
  /** Optional include-resolution cache shared across rebuilds (owned by the workspace). */
  resolveCache?: IncludeResolveCache;
  /**
   * When true, cached documents whose path is not in `changedFiles` are used
   * without a per-file stat. The workspace enables this while a file watcher
   * invalidates caches for changed paths; a forced reindex passes false.
   */
  trustUnchanged?: boolean;
  /**
   * Normalized paths (see `normKey`) known to have changed since the caches
   * were populated. Only consulted when `trustUnchanged` is true.
   */
  changedFiles?: ReadonlySet<string>;
}

export interface FileWalker {
  /** Recursively lists files under a directory. Cached by the caller. */
  listFiles(dir: string): Promise<string[]>;
}

export interface ParseCache {
  get(path: string): IndexedFile | undefined;
  set(file: IndexedFile): void;
  clear(): void;
  /** Removes the cached entry for a path. */
  invalidate(path: string): void;
}

/** A parsed file plus its line map, produced on demand. */
export interface ParsedFile {
  file: IndexedFile;
  parse: XmlDocument | null;
  /**
   * Compact index records (assets/defines/includes/xi:include with lines).
   * Present for every indexable XML document; null for binary files.
   */
  records: IndexRecords | null;
  lineMap: LineMap | null;
}
