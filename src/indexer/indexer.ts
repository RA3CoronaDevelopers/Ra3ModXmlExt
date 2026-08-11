/**
 * Workspace indexer for RA3 Mod XML.
 *
 * Walks the include graph from Data/Mod.xml (static stream) and
 * Data/additionalmaps/mapmetadata_*.xml (global streams), collects asset
 * definitions, `$DEFINE` constants, resolved `reference` includes (parsed
 * from compiled .manifest files) and a file-name index used for
 * Include/@source completion.
 *
 * Pure TypeScript (no vscode dependency) so the indexing core can be reused
 * outside the extension.
 */

import { open, readFile, readdir, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
  LineMap,
  parseXml,
  stripBom,
  type XmlElement,
} from "../language/xmlParser";
import {
  buildSearchPaths,
  manifestPathForReference,
  resolveSource,
  type ResolveResult,
  type SearchPaths,
} from "./includeResolver";
import { validateSdkPath } from "../sdk";
import {
  buildExistenceSnapshot,
  type ExistenceSnapshot,
} from "./existence";
import { findXPointerContainer, localName } from "./xpointer";
import {
  deriveAssetId,
  deriveAssetType,
  parseManifest,
  type ManifestInfo,
} from "./manifestParser";
import { canonicalTypeName } from "../model/schemaModel";
import { collectSourceCandidates } from "./fileScanner";
import {
  contentHash,
  DocumentCache,
  IncludeResolveCache,
  IndexRecordsCache,
  normKey,
  recordsHash,
} from "./caches";
import type { IndexRecordsCacheEntry } from "./caches";
import { scanXmlShallow } from "./shallowScan";
import {
  extractIndexRecords,
  recordsFromShallow,
  type IndexRecords,
  type IndexRecordXi,
} from "./records";
import {
  buildReferenceIndex,
  type ReferenceRecordSource,
} from "./referenceIndex";
import type {
  AssetDef,
  DefineDef,
  IndexOptions,
  IndexedFile,
  ModIndex,
  ParsedFile,
  ReferenceSite,
  SourceCandidate,
  StreamInfo,
} from "./types";

const MAX_DEPTH = 300;
/** Files above this size are never parsed (safety against binary blobs). */
const MAX_PARSE_BYTES = 4 * 1024 * 1024;
/**
 * Fully parsed XML documents. `.xml` files are small enough that a full DOM
 * is affordable. (Compiled manifests are binary `*.manifest` files parsed by
 * `manifestParser`; there is no `.manifestxml` source format.)
 */
const FULL_XML_EXTENSIONS = new Set([".xml"]);
/**
 * XML documents whose top-level structure is all the index needs (art-asset
 * files exported by modeling tools, e.g. .w3x). They are shallow-scanned so
 * multi-megabyte vertex/triangle payloads never become a DOM.
 */
const SHALLOW_XML_EXTENSIONS = new Set([".w3x"]);
/** Bytes peeked when deciding whether an unknown extension is XML text. */
const SNIFF_BYTES = 512;

type XmlMode = "full" | "shallow" | "binary";

export class ModIndexer {
  private searchPaths: SearchPaths;
  private docs: DocumentCache;
  private recordsCache: IndexRecordsCache;
  private resolveCache: IncludeResolveCache;
  /** Directory-based file existence snapshot (avoids cold statSync storms). */
  private existence: ExistenceSnapshot | null = null;
  private scanCounters = {
    shallowScannedFiles: 0,
    shallowCacheHits: 0,
    recordsCacheHits: 0,
    resolveCacheHits: 0,
    resolveCalls: 0,
  };
  private timings = { candidatesMs: 0, walkMs: 0, artScanMs: 0 };
  /**
   * Phase A ("xml") registers art-asset XML files (`.w3x` and sniffed XML)
   * without reading their content; the queue is drained by phase B ("art"),
   * which shallow-scans them and walks any includes they contain.
   */
  private deferArtScan = false;
  private artQueue: {
    path: string;
    stream: StreamInfo;
    depth: number;
    viaInstance: boolean;
  }[] = [];
  private assets = new Map<string, Map<string, AssetDef[]>>();
  private assetsById = new Map<string, AssetDef[]>();
  private defines = new Map<string, DefineDef[]>();
  private files = new Map<string, IndexedFile>();
  /**
   * Records exactly as the current build's walk saw them (path -> records +
   * content hash). The reverse reference index is built from this map, never
   * from the shared records cache, so a watcher invalidation or a feature
   * re-read (readDom) mid-build cannot desync references from assets.
   */
  private buildRecords = new Map<
    string,
    { file: string; records: IndexRecords; recordsHash: string }
  >();
  private streams: StreamInfo[] = [];
  private manifests = new Map<string, ManifestInfo>();
  private sourceCandidates: SourceCandidate[] = [];
  private diagnostics: ModIndex["diagnostics"] = [];
  private visitedAll = new Set<string>();
  private visitedInstance = new Set<string>();
  private manifestAssetKeys = new Set<string>();
  /** True when the SDK is missing/not an SDK: SDK-only includes are suppressed. */
  private sdkUnusable: boolean;
  private suppressedSdkIncludeCount = 0;

  constructor(private opts: IndexOptions) {
    this.searchPaths = buildSearchPaths(opts.sdkDir, opts.projectDir, {
      DATA: opts.additionalDataSearchPaths,
    });
    const sdkStatus = validateSdkPath(opts.sdkDir);
    this.sdkUnusable =
      sdkStatus.status === "missing" || sdkStatus.status === "not-sdk";
    // Caches may be owned by the workspace so they survive rebuilds.
    this.docs = opts.documentCache ?? new DocumentCache();
    this.recordsCache = opts.recordsCache ?? new IndexRecordsCache();
    this.resolveCache = opts.resolveCache ?? new IncludeResolveCache();
  }

  /**
   * Returns a document for indexing/navigation:
   * - `.xml` files are fully parsed (bounded by MAX_PARSE_BYTES);
   * - `.w3x` (and unknown-extension files whose content looks like XML) are
   *   shallow-scanned, so huge model files never become a DOM;
   * - everything else is registered as a file but never parsed.
   *
   * Cached entries are reused when the file stat is unchanged, which lets a
   * workspace-owned cache survive rebuilds.
   */
  async readDocument(
    path: string,
    opts?: { deferArt?: boolean },
  ): Promise<ParsedFile | null> {
    const key = normKey(path);
    const trust =
      this.opts.trustUnchanged === true && !this.opts.changedFiles?.has(key);

    // Trusted fast path: a file that the watcher has not reported as changed
    // is reused without any stat / content sniff / read at all. This is what
    // makes save-triggered rebuilds cheap on huge corpora (Corona: ~9k files,
    // ~2.6 GB of art assets on a mechanical drive).
    if (trust) {
      const rec = this.recordsCache.get(key);
      if (rec) {
        if (rec.validated === false) {
          // Seeded from disk but not stat-validated yet. During phase A an
          // art file only needs registration (no content), so reuse the
          // cached stamp; its records are consumed only after validation.
          if (opts?.deferArt && rec.kind === "shallow" && rec.stat) {
            const file: IndexedFile = { path: resolve(path), stat: rec.stat };
            this.files.set(key, file);
            return {
              file,
              parse: null,
              records: null,
              lineMap: null,
              deferredArt: true,
            };
          }
          // Fall through: the stat-verifying path below checks this entry.
        } else {
          return this.recordsParsed(path, rec);
        }
      }
      const cached = this.docs.get(key);
      if (cached) {
        this.files.set(key, cached.file);
        return cached;
      }
    }

    // Untrusted / cache miss: verify the stat against caches, then read.
    try {
      const st = await stat(path);
      const rec = this.recordsCache.get(key);
      if (
        rec?.stat &&
        rec.stat.mtimeMs === st.mtimeMs &&
        rec.stat.size === st.size &&
        rec.stat.birthtimeMs === st.birthtimeMs &&
        rec.stat.ctimeMs === st.ctimeMs
      ) {
        rec.validated = true;
        // Force rebuilds (Re-index workspace) verify full-XML content even
        // when every stat signal matches: external drives (FAT32/exFAT) can
        // rewrite a file with the same size and coarse timestamps.
        if (
          this.opts.trustUnchanged === false &&
          rec.kind === "full" &&
          rec.contentHash
        ) {
          const text = stripBom(await readFile(path, "utf8"));
          if (contentHash(text) === rec.contentHash) {
            return this.recordsParsed(path, rec);
          }
          return this.parseFullXml(path, st, text);
        }
        return this.recordsParsed(path, rec);
      }
      const hit = this.docs.get(key);
      if (
        hit?.file.stat &&
        hit.file.stat.mtimeMs === st.mtimeMs &&
        hit.file.stat.size === st.size &&
        hit.file.stat.birthtimeMs === st.birthtimeMs &&
        hit.file.stat.ctimeMs === st.ctimeMs
      ) {
        this.files.set(key, hit.file);
        return hit;
      }
      const mode = await this.detectXmlMode(path);
      if (mode === "shallow") {
        // Phase A: register the art file, defer the shallow scan to phase B.
        if (opts?.deferArt) {
          const file: IndexedFile = {
            path: resolve(path),
            stat: {
              mtimeMs: st.mtimeMs,
              size: st.size,
              birthtimeMs: st.birthtimeMs,
              ctimeMs: st.ctimeMs,
            },
          };
          // Deliberately NOT stored in the DocumentCache: a deferred entry
          // has no records, and a later phase-B read must re-scan it.
          this.files.set(key, file);
          return { file, parse: null, records: null, lineMap: null, deferredArt: true };
        }
        return this.scanShallow(path, st);
      }
      if (mode === "binary") {
        const file: IndexedFile = {
          path: resolve(path),
          stat: {
            mtimeMs: st.mtimeMs,
            size: st.size,
            birthtimeMs: st.birthtimeMs,
            ctimeMs: st.ctimeMs,
          },
        };
        const parsed: ParsedFile = { file, parse: null, records: null, lineMap: null };
        this.docs.set(parsed);
        this.files.set(key, file);
        return parsed;
      }
      if (st.size > MAX_PARSE_BYTES) {
        const file: IndexedFile = {
          path: resolve(path),
          stat: {
            mtimeMs: st.mtimeMs,
            size: st.size,
            birthtimeMs: st.birthtimeMs,
            ctimeMs: st.ctimeMs,
          },
        };
        const parsed: ParsedFile = { file, parse: null, records: null, lineMap: null };
        this.docs.set(parsed);
        this.files.set(key, file);
        return parsed;
      }
      const text = stripBom(await readFile(path, "utf8"));
      return this.parseFullXml(path, st, text);
    } catch {
      const parsed: ParsedFile = {
        file: { path: resolve(path), stat: null },
        parse: null,
        records: null,
        lineMap: null,
      };
      this.docs.set(parsed);
      this.files.set(key, parsed.file);
      return parsed;
    }
  }

  /**
   * Shallow-scans a large art-asset XML document (no DOM built) and caches
   * its compact index records. The transient LineMap used to compute record
   * lines is discarded, so the cache never retains megabytes of line offsets
   * for model files (Corona w3x alone would otherwise keep ~700 MB).
   */
  private async scanShallow(path: string, st: Stats): Promise<ParsedFile | null> {
    const key = normKey(path);
    try {
      const text = stripBom(await readFile(path, "utf8"));
      const lineMap = new LineMap(text);
      const records = recordsFromShallow(scanXmlShallow(text), lineMap);
      const parsed: ParsedFile = {
        file: {
          path: resolve(path),
          stat: {
            mtimeMs: st.mtimeMs,
            size: st.size,
            birthtimeMs: st.birthtimeMs,
            ctimeMs: st.ctimeMs,
          },
        },
        parse: null,
        records,
        lineMap: null,
      };
      this.recordsCache.set(key, { stat: parsed.file.stat, records, kind: "shallow" });
      this.files.set(key, parsed.file);
      this.scanCounters.shallowScannedFiles++;
      return parsed;
    } catch {
      return null;
    }
  }

  /** Builds a lean ParsedFile from cached index records (no DOM / line map). */
  private recordsParsed(path: string, entry: IndexRecordsCacheEntry): ParsedFile {
    if (entry.kind === "shallow") this.scanCounters.shallowCacheHits++;
    else this.scanCounters.recordsCacheHits++;
    const file: IndexedFile = { path: resolve(path), stat: entry.stat };
    this.files.set(normKey(path), file);
    return { file, parse: null, records: entry.records, lineMap: null };
  }

  /**
   * Parses a full XML document from its text, caches records (with a content
   * hash) and the DOM, and registers the file in this build.
   */
  private parseFullXml(path: string, st: Stats, text: string): ParsedFile {
    const key = normKey(path);
    const lineMap = new LineMap(text);
    const parse = parseXml(text);
    const records = extractIndexRecords(parse, lineMap, text);
    const parsed: ParsedFile = {
      file: {
        path: resolve(path),
        stat: {
          mtimeMs: st.mtimeMs,
          size: st.size,
          birthtimeMs: st.birthtimeMs,
          ctimeMs: st.ctimeMs,
        },
      },
      parse,
      records,
      lineMap,
    };
    this.docs.set(parsed);
    this.recordsCache.set(key, {
      stat: parsed.file.stat,
      records,
      kind: "full",
      contentHash: contentHash(text),
    });
    this.files.set(key, parsed.file);
    return parsed;
  }

  /**
   * Reads a document and guarantees a DOM parse tree. Used for root-level
   * <xi:include> xpointer selection (rare) and by the document-local scope
   * (logical include expansion + precise definition locations).
   */
  async readDom(path: string): Promise<ParsedFile | null> {
    const key = normKey(path);
    const cached = this.docs.get(key);
    if (cached?.parse?.root) {
      this.files.set(key, cached.file);
      return cached;
    }
    try {
      const st = await stat(path);
      const hit = this.docs.get(key);
      if (
        hit?.parse?.root &&
        hit.file.stat &&
        hit.file.stat.mtimeMs === st.mtimeMs &&
        hit.file.stat.size === st.size &&
        hit.file.stat.birthtimeMs === st.birthtimeMs &&
        hit.file.stat.ctimeMs === st.ctimeMs
      ) {
        this.files.set(key, hit.file);
        return hit;
      }
      if (st.size > MAX_PARSE_BYTES) return null;
      const text = stripBom(await readFile(path, "utf8"));
      return this.parseFullXml(path, st, text);
    } catch {
      return null;
    }
  }

  /** Decides how a resolved include target should be consumed. */
  private async detectXmlMode(path: string): Promise<XmlMode> {
    const ext = extname(path).toLowerCase();
    if (FULL_XML_EXTENSIONS.has(ext)) return "full";
    if (SHALLOW_XML_EXTENSIONS.has(ext)) return "shallow";
    return (await looksLikeXml(path)) ? "shallow" : "binary";
  }

  /**
   * Resolves an include source through the cross-rebuild cache. Existence
   * does not change on content edits, so trusted rebuilds pay zero statSync
   * for include resolution (Corona does ~110k checks per build otherwise).
   */
  private resolveCached(source: string, currentDir: string | null): ResolveResult {
    const key = `${normKey(currentDir ?? "")}\u0000${source}`;
    const hit = this.resolveCache.get(key);
    if (hit) {
      this.scanCounters.resolveCacheHits++;
      return hit;
    }
    this.scanCounters.resolveCalls++;
    const result = resolveSource(
      source,
      currentDir,
      this.searchPaths,
      this.existence ?? undefined,
    );
    this.resolveCache.set(key, result);
    return result;
  }

  /** Cached manifest lookup for `reference` includes. */
  private manifestPathCached(source: string): string | null {
    const key = source.toLowerCase();
    const hit = this.resolveCache.getManifest(key);
    if (hit !== undefined) {
      this.scanCounters.resolveCacheHits++;
      return hit;
    }
    this.scanCounters.resolveCalls++;
    const path = manifestPathForReference(source, this.opts.builtmodsDirs);
    this.resolveCache.setManifest(key, path);
    return path;
  }

  /** Returns the cached parse if present (does not read from disk). */
  cachedDocument(path: string): ParsedFile | undefined {
    return this.docs.get(path);
  }

  /** True when the file is part of the current build's index. */
  isIndexedFile(path: string): boolean {
    return this.files.has(normKey(path));
  }

  async build(onPhase?: (index: ModIndex) => void | Promise<void>): Promise<ModIndex> {
    const start = Date.now();
    this.buildRecords.clear();
    this.suppressedSdkIncludeCount = 0;
    // Root list only; directories are listed lazily on first query, so the
    // XML phase does not pay an upfront recursive enumeration of the SDK.
    this.existence = buildExistenceSnapshot(this.searchPaths);
    const projectData = await findCaseInsensitiveDir(join(this.opts.projectDir, "Data"));
    const additionalMaps = projectData
      ? await findCaseInsensitiveDir(join(projectData, "additionalmaps"))
      : null;

    // ── Streams ──
    // Phase A: walk the include graph without reading art-asset content.
    // `.w3x` (and sniffed XML) files are registered and queued; their
    // top-level assets and nested includes are processed in phase B.
    this.deferArtScan = true;
    const walkStart = Date.now();
    const staticEntry = projectData ? join(projectData, "Mod.xml") : null;
    if (staticEntry) {
      const stream: StreamInfo = { name: "static", entry: staticEntry, files: new Set() };
      this.streams.push(stream);
      await this.walk(staticEntry, "all", stream, 0);
    }

    if (additionalMaps) {
      let entries: string[] = [];
      try {
        entries = await readdir(additionalMaps);
      } catch {
        entries = [];
      }
      const metadataFiles = entries
        .filter((f) => /^mapmetadata_.*\.xml$/i.test(f))
        .sort();
      for (const f of metadataFiles) {
        const entry = join(additionalMaps, f);
        const stream: StreamInfo = {
          name: `global:${basename(f, ".xml")}`,
          entry,
          files: new Set(),
        };
        this.streams.push(stream);
        await this.walk(entry, "all", stream, 0);
      }
    }
    this.timings.walkMs = Date.now() - walkStart;
    if (this.suppressedSdkIncludeCount > 0) {
      this.diagnostics.push({
        file:
          staticEntry ?? join(this.opts.projectDir, "Data"),
        line: 0,
        message:
          "SDK path is not configured or invalid; DATA:/ART:/AUDIO: includes are not resolved (set ra3modxml.sdkPath).",
        severity: "information",
        code: "sdk-not-configured",
      });
    }

    // ── Source completion candidates ──
    const candidatesStart = Date.now();
    const dataDirs = [
      projectData ?? join(this.opts.projectDir, "Data"),
      join(this.opts.sdkDir, "SageXml"),
      ...this.opts.additionalDataSearchPaths,
    ];
    if (!this.opts.indexSageXml) {
      const sage = join(this.opts.sdkDir, "SageXml");
      const idx = dataDirs.findIndex((d) => normKey(d) === normKey(sage));
      if (idx >= 0) dataDirs.splice(idx, 1);
    }
    const artDirs = [
      join(this.opts.projectDir, "Art1"),
      join(this.opts.projectDir, "Art"),
      join(this.opts.sdkDir, "Art"),
    ];
    const audioDirs = [
      join(this.opts.projectDir, "Audio1"),
      join(this.opts.projectDir, "Audio"),
      join(this.opts.sdkDir, "Audio"),
    ];
    this.sourceCandidates = await collectSourceCandidates(
      this.opts.walker,
      dataDirs,
      artDirs,
      audioDirs,
      projectData ?? join(this.opts.projectDir, "Data"),
    );
    // The SDK root itself is the first DATA: search base (static.xml,
    // global.xml, audio.xml placeholders) but only its shallow XML files are
    // relevant. These candidates take precedence over same-named files found
    // deeper in the search paths (e.g. SageXml/Static.xml).
    let sdkRootXml: string[] = [];
    if (this.opts.sdkDir) {
      try {
        sdkRootXml = (await readdir(this.opts.sdkDir)).filter(
          (f) => f.toLowerCase().endsWith(".xml"),
        );
      } catch {
        // Missing/inaccessible SDK root: run in project-only mode. All other
        // SDK search roots already degrade to empty lists.
      }
    }
    const sdkRootCandidates: SourceCandidate[] = sdkRootXml.map((f) => ({
      source: `DATA:${f}`,
      path: resolve(this.opts.sdkDir, f),
      prefix: "DATA",
      baseDir: resolve(this.opts.sdkDir),
    }));
    this.sourceCandidates = dedupeSourceCandidates([
      ...sdkRootCandidates,
      ...this.sourceCandidates,
    ]);
    this.timings.candidatesMs = Date.now() - candidatesStart;

    // Publish the XML phase as an immutable snapshot: features get usable
    // completions/navigation/diagnostics for XML + manifest data immediately,
    // while the slow art scan continues in the background.
    const xmlPhase = this.snapshotIndex("xml", false, start);
    if (onPhase) await onPhase(xmlPhase);

    // ── Phase B: art assets ──
    this.deferArtScan = false;
    const artStart = Date.now();
    while (this.artQueue.length) {
      const entry = this.artQueue.shift()!;
      const parsed = await this.readDocument(entry.path);
      if (parsed?.records) {
        await this.applyRecords(parsed, entry.stream, entry.depth, entry.viaInstance);
      }
    }
    this.timings.artScanMs = Date.now() - artStart;

    return this.snapshotIndex("art", true, start);
  }

  /**
   * Produces a copy of the current index state. Phase-A snapshots must be
   * immutable: phase B keeps mutating the live maps after the snapshot has
   * been handed to features, so every nested map/array is cloned here.
   */
  private snapshotIndex(
    phase: "xml" | "art",
    complete: boolean,
    startedAt: number,
  ): ModIndex {
    const manifestAssetCount = [...this.manifests.values()].reduce(
      (sum, m) => sum + m.assets.length,
      0,
    );
    const assets = new Map<string, Map<string, AssetDef[]>>();
    for (const [type, byId] of this.assets) {
      const copied = new Map<string, AssetDef[]>();
      for (const [id, defs] of byId) copied.set(id, defs.slice());
      assets.set(type, copied);
    }
    const assetsById = new Map<string, AssetDef[]>();
    for (const [id, defs] of this.assetsById) assetsById.set(id, defs.slice());
    const defines = new Map<string, DefineDef[]>();
    for (const [name, defs] of this.defines) defines.set(name, defs.slice());
    const references = this.buildReferences();
    const referenceCount = [...references.values()].reduce(
      (sum, sites) => sum + sites.length,
      0,
    );
    const recordsHashes = new Map<string, string>();
    for (const [key, entry] of this.buildRecords) {
      recordsHashes.set(key, entry.recordsHash);
    }

    return {
      projectDir: resolve(this.opts.projectDir),
      sdkDir: resolve(this.opts.sdkDir),
      complete,
      phase,
      assets,
      assetsById,
      defines,
      files: new Map(this.files),
      streams: this.streams.map((s) => ({ ...s, files: new Set(s.files) })),
      manifests: new Map(this.manifests),
      sourceCandidates: this.sourceCandidates.slice(),
      diagnostics: this.diagnostics.slice(),
      references,
      recordsHashes,
      stats: {
        projectDir: resolve(this.opts.projectDir),
        sdkDir: resolve(this.opts.sdkDir),
        phase,
        complete,
        indexedFiles: this.files.size,
        parsedFiles: [...this.files.values()].filter(
          (f) => f.stat != null && f.stat.size <= MAX_PARSE_BYTES,
        ).length,
        shallowScannedFiles: this.scanCounters.shallowScannedFiles,
        deferredArtFiles: this.artQueue.length,
        shallowCacheHits: this.scanCounters.shallowCacheHits,
        recordsCacheHits: this.scanCounters.recordsCacheHits,
        resolveCacheHits: this.scanCounters.resolveCacheHits,
        resolveCalls: this.scanCounters.resolveCalls,
        snapshotHits: this.existence?.hits ?? 0,
        snapshotFallbacks: this.existence?.fallbacks ?? 0,
        candidatesMs: this.timings.candidatesMs,
        walkMs: this.timings.walkMs,
        artScanMs: this.timings.artScanMs,
        assetCount: [...this.assets.values()].reduce((sum, byId) => sum + byId.size, 0),
        referenceCount,
        defineCount: this.defines.size,
        manifestFiles: this.manifests.size,
        manifestAssetCount,
        streams: this.streams.length,
        sourceCandidates: this.sourceCandidates.length,
        elapsedMs: Date.now() - startedAt,
      },
    };
  }

  /**
   * Resolves the per-file reference records collected during this build
   * against the current asset maps. Only files touched by this build are
   * included, so stale cache entries for files that left the include graph
   * never leak into the reverse index.
   */
  private buildReferences(): Map<string, ReferenceSite[]> {
    const sources: ReferenceRecordSource[] = [];
    for (const { file, records } of this.buildRecords.values()) {
      sources.push({ file, records });
    }
    return buildReferenceIndex(sources, {
      assets: this.assets,
      assetsById: this.assetsById,
    });
  }

  /**
   * Remembers the records exactly as this build saw them (plus the content
   * hash when the file was fully parsed / cached with one), so snapshots can
   * build references from the same source of truth as the asset maps.
   */
  private noteBuildRecords(parsed: ParsedFile): void {
    if (!parsed.records) return;
    const key = normKey(parsed.file.path);
    this.buildRecords.set(key, {
      file: parsed.file.path,
      records: parsed.records,
      recordsHash: recordsHash(parsed.records),
    });
  }

  // ── Include walk ──────────────────────────────────────────────────

  private async walk(
    path: string,
    mode: "all" | "instance",
    stream: StreamInfo,
    depth: number,
  ): Promise<void> {
    const key = normKey(path);
    if (depth > MAX_DEPTH) {
      this.diagnostics.push({
        file: path,
        line: 0,
        message: "Include depth exceeded - possible include cycle",
        severity: "warning",
        code: "include-cycle",
      });
      return;
    }
    if (mode === "all") {
      if (this.visitedAll.has(key)) return;
      this.visitedAll.add(key);
    } else {
      if (this.visitedInstance.has(key)) return;
      this.visitedInstance.add(key);
      if (this.visitedAll.has(key)) return;
    }

    stream.files.add(key);

    // readDocument returns compact index records for every indexable XML
    // document (full parse or shallow scan), or a bare file registration
    // for binary / unparseable targets. During phase A, art-asset XML files
    // are registered and queued instead of scanned (deferredArt).
    const parsed = await this.readDocument(path, this.deferArtScan ? { deferArt: true } : undefined);
    if (!parsed) return;
    if (parsed.deferredArt) {
      this.artQueue.push({
        path: parsed.file.path,
        stream,
        depth,
        viaInstance: mode === "instance",
      });
      return;
    }
    if (parsed.records) {
      await this.applyRecords(parsed, stream, depth, mode === "instance");
      return;
    }
  }

  /**
   * Applies a document's compact index records: top-level assets, defines,
   * <Includes>, nested <xi:include> and root-level <xi:include> targets.
   * Works identically for fully parsed XML and shallow-scanned art assets.
   */
  private async applyRecords(
    parsed: ParsedFile,
    stream: StreamInfo,
    depth: number,
    viaInstance: boolean,
  ): Promise<void> {
    const records = parsed.records;
    if (!records) return;
    this.noteBuildRecords(parsed);
    const file = parsed.file.path;
    const origin = this.originOf(file);

    for (const asset of records.assets) {
      this.addAsset({
        type: asset.type,
        id: asset.id,
        file,
        line: asset.line,
        origin,
        stream: stream.name,
        viaInstance,
      });
    }

    for (const define of records.defines) {
      const entry: DefineDef = {
        name: define.name,
        value: define.value,
        file,
        line: define.line,
        origin,
      };
      const arr = this.defines.get(define.name.toLowerCase());
      if (arr) arr.push(entry);
      else this.defines.set(define.name.toLowerCase(), [entry]);
    }

    for (const inc of records.includes) {
      const resolved = this.resolveCached(inc.source, dirname(file));
      if (!resolved.path) {
        if (this.shouldSuppressMissingInclude(inc.source)) {
          this.suppressedSdkIncludeCount++;
          continue;
        }
        this.diagnostics.push({
          file,
          line: inc.line,
          message: `Include target not found: ${inc.source}`,
          severity: "warning",
          code: "include-not-found",
        });
        continue;
      }
      if (inc.type === "all" || inc.type === "instance") {
        await this.walk(
          resolved.path,
          inc.type === "all" ? "all" : "instance",
          stream,
          depth + 1,
        );
      } else if (inc.type === "reference") {
        const manifestPath = this.manifestPathCached(inc.source);
        if (manifestPath) {
          const loaded = await this.loadManifest(manifestPath, stream.name);
          if (!loaded) await this.walk(resolved.path, "instance", stream, depth + 1);
        } else {
          await this.walk(resolved.path, "instance", stream, depth + 1);
        }
      }
    }

    for (const xi of records.nestedXiIncludes) {
      const resolved = this.resolveCached(xi.href, dirname(file));
      if (!resolved.path) {
        if (this.shouldSuppressMissingInclude(xi.href)) {
          this.suppressedSdkIncludeCount++;
          continue;
        }
        this.diagnostics.push({
          file,
          line: xi.line,
          message: `xi:include target not found: ${xi.href}`,
          severity: "warning",
          code: "include-not-found",
        });
        continue;
      }
      stream.files.add(normKey(resolved.path));
      await this.walk(resolved.path, "all", stream, depth + 1);
    }

    for (const xi of records.rootXiIncludes) {
      await this.handleRootXiInclude(xi, file, stream, depth);
    }
  }

  /**
   * Root-level <xi:include> with an xpointer selects a named container's
   * children in the target document, so the target's DOM is needed. These
   * targets are rare, so they are parsed on demand (the tree is also cached).
   */
  private async handleRootXiInclude(
    xi: IndexRecordXi,
    parentFile: string,
    stream: StreamInfo,
    depth: number,
  ): Promise<void> {
    const resolved = this.resolveCached(xi.href, dirname(parentFile));
    if (!resolved.path) {
      if (this.shouldSuppressMissingInclude(xi.href)) {
        this.suppressedSdkIncludeCount++;
        return;
      }
      this.diagnostics.push({
        file: parentFile,
        line: xi.line,
        message: `xi:include target not found: ${xi.href}`,
        severity: "warning",
        code: "include-not-found",
      });
      return;
    }

    const target = await this.readDom(resolved.path);
    if (target?.parse?.root) {
      const xpointer = xi.xpointer ?? "";
      let candidates: XmlElement[];
      if (xpointer) {
        const container = findXPointerContainer(target.parse, xpointer);
        candidates = container ? container.children : [];
      } else {
        candidates = target.parse.root.children;
      }
      for (const el of candidates) {
        const local = localName(el.name);
        if (local === "Tags" || local === "Includes" || local === "Defines") continue;
        const idAttr = el.attrs.find((a) => a.name === "id");
        if (idAttr) {
          this.addAsset({
            type: local,
            id: idAttr.value,
            file: target.file.path,
            line: lineOf(target, idAttr.valueStart),
            origin: this.originOf(target.file.path),
            stream: stream.name,
          });
        }
      }
    }
    stream.files.add(normKey(resolved.path));
    await this.walk(resolved.path, "all", stream, depth + 1);
  }

  // ── Manifest loading ──────────────────────────────────────────────

  /** Returns true when the manifest was parsed successfully. */
  private async loadManifest(path: string, streamName: string): Promise<boolean> {
    const key = normKey(path);
    let info = this.manifests.get(key);
    if (!info) {
      try {
        const data = await readFile(path);
        const buffer = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        info = parseManifest(buffer);
      } catch {
        this.diagnostics.push({
          file: path,
          line: 0,
          message: "Manifest file could not be read",
          severity: "warning",
          code: "manifest-read-error",
        });
        return false;
      }
      this.manifests.set(key, info);
    }
    if (info.error) return false;
    for (const asset of info.assets) {
      if (!asset.name) continue;
      const id = deriveAssetId(asset.name);
      const assetKey = `${asset.typeId}:${id.toLowerCase()}`;
      if (this.manifestAssetKeys.has(assetKey)) continue;
      this.manifestAssetKeys.add(assetKey);
      this.addAsset({
        type:
          canonicalTypeName(deriveAssetType(asset.typeName, asset.name)) ??
          `#${asset.typeId.toString(16)}`,
        id,
        file: path,
        line: 0,
        origin: "manifest",
        stream: streamName,
        manifest: path,
        manifestSource: asset.sourceFileName,
      });
    }
    return true;
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private originOf(path: string): "project" | "sdk" {
    const p = resolve(path).toLowerCase();
    const project = resolve(this.opts.projectDir).toLowerCase();
    const sdk = this.opts.sdkDir
      ? resolve(this.opts.sdkDir).toLowerCase()
      : "";
    if (p.startsWith(project + "\\")) return "project";
    if (sdk && p.startsWith(sdk + "\\")) return "sdk";
    return "project";
  }

  /** DATA:/ART:/AUDIO: misses are expected when no usable SDK is configured. */
  private shouldSuppressMissingInclude(source: string): boolean {
    return this.sdkUnusable && /^(DATA|ART|AUDIO):/i.test(source.trim());
  }

  private addAsset(def: AssetDef): void {
    // Keep the original case: type names are matched against the XSD model.
    const typeKey = def.type;
    const idKey = def.id.toLowerCase();
    let byId = this.assets.get(typeKey);
    if (!byId) {
      byId = new Map();
      this.assets.set(typeKey, byId);
    }
    const arr = byId.get(idKey);
    if (arr) {
      if (
        arr.some(
          (a) =>
            a.type === def.type &&
            a.file === def.file &&
            a.line === def.line,
        )
      ) {
        return;
      }
      arr.push(def);
    } else {
      byId.set(idKey, [def]);
    }
    const all = this.assetsById.get(idKey);
    if (all) {
      if (
        all.some(
          (a) =>
            a.type === def.type &&
            a.file === def.file &&
            a.line === def.line,
        )
      ) {
        return;
      }
      all.push(def);
    } else {
      this.assetsById.set(idKey, [def]);
    }
  }
}

// ── Module-level helpers ─────────────────────────────────────────────

function lineOf(parsed: ParsedFile, offset: number): number {
  if (!parsed.lineMap) return 0;
  return parsed.lineMap.positionAt(offset).line + 1;
}

/**
 * Content sniffing for include targets with unknown extensions (e.g. art
 * formats beyond .w3x): a small header that starts with "<" after an
 * optional UTF-8 BOM / whitespace and contains no NUL bytes is treated as
 * XML text; anything else is a binary asset (registered, never parsed).
 */
async function looksLikeXml(path: string): Promise<boolean> {
  try {
    const fh = await open(path, "r");
    try {
      const buf = Buffer.alloc(SNIFF_BYTES);
      const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
      const head = buf.subarray(0, bytesRead);
      if (head.includes(0)) return false;
      let i = 0;
      if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) i = 3;
      while (i < head.length && (head[i] === 0x20 || head[i] === 0x09 || head[i] === 0x0a || head[i] === 0x0d)) {
        i++;
      }
      return i < head.length && head[i] === 0x3c; // "<"
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

async function findCaseInsensitiveDir(dir: string): Promise<string | null> {
  const parent = dirname(dir);
  const wanted = basename(dir);
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    const hit = entries.find(
      (e) => e.isDirectory() && e.name.toLowerCase() === wanted.toLowerCase(),
    );
    return hit ? join(parent, hit.name) : null;
  } catch {
    return null;
  }
}

/** Keeps the first candidate for each case-insensitive source string. */
function dedupeSourceCandidates(candidates: SourceCandidate[]): SourceCandidate[] {
  const seen = new Set<string>();
  const out: SourceCandidate[] = [];
  for (const c of candidates) {
    const key = c.source.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
