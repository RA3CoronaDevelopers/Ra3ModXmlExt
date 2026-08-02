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
  type XmlDocument,
  type XmlElement,
} from "../language/xmlParser";
import {
  buildSearchPaths,
  manifestPathForReference,
  resolveSource,
  type ResolveResult,
  type SearchPaths,
} from "./includeResolver";
import {
  deriveAssetId,
  deriveAssetType,
  parseManifest,
  type ManifestInfo,
} from "./manifestParser";
import { canonicalTypeName } from "../model/schemaModel";
import { collectSourceCandidates } from "./fileScanner";
import { DocumentCache, IncludeResolveCache, IndexRecordsCache, normKey } from "./caches";
import type { IndexRecordsCacheEntry } from "./caches";
import { scanXmlShallow } from "./shallowScan";
import {
  extractIndexRecords,
  recordsFromShallow,
  type IndexRecordXi,
} from "./records";
import type {
  AssetDef,
  DefineDef,
  IndexOptions,
  IndexedFile,
  ModIndex,
  ParsedFile,
  SourceCandidate,
  StreamInfo,
} from "./types";

const MAX_DEPTH = 300;
/** Files above this size are never parsed (safety against binary blobs). */
const MAX_PARSE_BYTES = 4 * 1024 * 1024;
/**
 * Fully parsed XML documents. `.xml` / `.manifestxml` files are small enough
 * that a full DOM is affordable.
 */
const FULL_XML_EXTENSIONS = new Set([".xml", ".manifestxml"]);
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
  private scanCounters = {
    shallowScannedFiles: 0,
    shallowCacheHits: 0,
    recordsCacheHits: 0,
    resolveCacheHits: 0,
    resolveCalls: 0,
  };
  private phase = { candidatesMs: 0, walkMs: 0 };
  private assets = new Map<string, Map<string, AssetDef[]>>();
  private assetsById = new Map<string, AssetDef[]>();
  private defines = new Map<string, DefineDef[]>();
  private files = new Map<string, IndexedFile>();
  private streams: StreamInfo[] = [];
  private manifests = new Map<string, ManifestInfo>();
  private sourceCandidates: SourceCandidate[] = [];
  private diagnostics: ModIndex["diagnostics"] = [];
  private visitedAll = new Set<string>();
  private visitedInstance = new Set<string>();
  private manifestAssetKeys = new Set<string>();

  constructor(private opts: IndexOptions) {
    this.searchPaths = buildSearchPaths(opts.sdkDir, opts.projectDir, {
      DATA: opts.additionalDataSearchPaths,
    });
    // Caches may be owned by the workspace so they survive rebuilds.
    this.docs = opts.documentCache ?? new DocumentCache();
    this.recordsCache = opts.recordsCache ?? new IndexRecordsCache();
    this.resolveCache = opts.resolveCache ?? new IncludeResolveCache();
  }

  /**
   * Returns a document for indexing/navigation:
   * - `.xml` / `.manifestxml` files are fully parsed (bounded by
   *   MAX_PARSE_BYTES);
   * - `.w3x` (and unknown-extension files whose content looks like XML) are
   *   shallow-scanned, so huge model files never become a DOM;
   * - everything else is registered as a file but never parsed.
   *
   * Cached entries are reused when the file stat is unchanged, which lets a
   * workspace-owned cache survive rebuilds.
   */
  async readDocument(path: string): Promise<ParsedFile | null> {
    const key = normKey(path);
    const trust =
      this.opts.trustUnchanged === true && !this.opts.changedFiles?.has(key);

    // Trusted fast path: a file that the watcher has not reported as changed
    // is reused without any stat / content sniff / read at all. This is what
    // makes save-triggered rebuilds cheap on huge corpora (Corona: ~9k files,
    // ~2.6 GB of art assets on a mechanical drive).
    if (trust) {
      const rec = this.recordsCache.get(key);
      if (rec) return this.recordsParsed(path, rec);
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
      if (rec?.stat && rec.stat.mtimeMs === st.mtimeMs && rec.stat.size === st.size) {
        return this.recordsParsed(path, rec);
      }
      const hit = this.docs.get(key);
      if (
        hit?.file.stat &&
        hit.file.stat.mtimeMs === st.mtimeMs &&
        hit.file.stat.size === st.size
      ) {
        this.files.set(key, hit.file);
        return hit;
      }
      const mode = await this.detectXmlMode(path);
      if (mode === "shallow") return this.scanShallow(path, st);
      if (mode === "binary") {
        const file: IndexedFile = { path: resolve(path), stat: { mtimeMs: st.mtimeMs, size: st.size } };
        const parsed: ParsedFile = { file, parse: null, records: null, lineMap: null };
        this.docs.set(parsed);
        this.files.set(key, file);
        return parsed;
      }
      if (st.size > MAX_PARSE_BYTES) {
        const file: IndexedFile = { path: resolve(path), stat: { mtimeMs: st.mtimeMs, size: st.size } };
        const parsed: ParsedFile = { file, parse: null, records: null, lineMap: null };
        this.docs.set(parsed);
        this.files.set(key, file);
        return parsed;
      }
      const text = stripBom(await readFile(path, "utf8"));
      const lineMap = new LineMap(text);
      const parse = parseXml(text);
      const records = extractIndexRecords(parse, lineMap);
      const parsed: ParsedFile = {
        file: { path: resolve(path), stat: { mtimeMs: st.mtimeMs, size: st.size } },
        parse,
        records,
        lineMap,
      };
      this.docs.set(parsed);
      this.recordsCache.set(key, { stat: parsed.file.stat, records, kind: "full" });
      this.files.set(key, parsed.file);
      return parsed;
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
        file: { path: resolve(path), stat: { mtimeMs: st.mtimeMs, size: st.size } },
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
   * Reads a document and guarantees a DOM parse tree. Used only for
   * root-level <xi:include> xpointer selection (rare), where the target's
   * container children are needed.
   */
  private async readDom(path: string): Promise<ParsedFile | null> {
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
        hit.file.stat.size === st.size
      ) {
        this.files.set(key, hit.file);
        return hit;
      }
      if (st.size > MAX_PARSE_BYTES) return null;
      const text = stripBom(await readFile(path, "utf8"));
      const lineMap = new LineMap(text);
      const parse = parseXml(text);
      const records = extractIndexRecords(parse, lineMap);
      const parsed: ParsedFile = {
        file: { path: resolve(path), stat: { mtimeMs: st.mtimeMs, size: st.size } },
        parse,
        records,
        lineMap,
      };
      this.docs.set(parsed);
      this.recordsCache.set(key, { stat: parsed.file.stat, records, kind: "full" });
      this.files.set(key, parsed.file);
      return parsed;
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
    const result = resolveSource(source, currentDir, this.searchPaths);
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

  async build(): Promise<ModIndex> {
    const start = Date.now();
    const projectData = await findCaseInsensitiveDir(join(this.opts.projectDir, "Data"));
    const additionalMaps = projectData
      ? await findCaseInsensitiveDir(join(projectData, "additionalmaps"))
      : null;

    // ── Streams ──
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
    this.phase.walkMs = Date.now() - walkStart;

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
    const sdkRootXml = (await readdir(this.opts.sdkDir)).filter(
      (f) => f.toLowerCase().endsWith(".xml"),
    );
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
    this.phase.candidatesMs = Date.now() - candidatesStart;

    const manifestAssetCount = [...this.manifests.values()].reduce(
      (sum, m) => sum + m.assets.length,
      0,
    );

    return {
      projectDir: resolve(this.opts.projectDir),
      sdkDir: resolve(this.opts.sdkDir),
      assets: this.assets,
      assetsById: this.assetsById,
      defines: this.defines,
      files: this.files,
      streams: this.streams,
      manifests: this.manifests,
      sourceCandidates: this.sourceCandidates,
      diagnostics: this.diagnostics,
      stats: {
        projectDir: resolve(this.opts.projectDir),
        sdkDir: resolve(this.opts.sdkDir),
        indexedFiles: this.files.size,
        parsedFiles: [...this.files.values()].filter(
          (f) => f.stat != null && f.stat.size <= MAX_PARSE_BYTES,
        ).length,
        shallowScannedFiles: this.scanCounters.shallowScannedFiles,
        shallowCacheHits: this.scanCounters.shallowCacheHits,
        recordsCacheHits: this.scanCounters.recordsCacheHits,
        resolveCacheHits: this.scanCounters.resolveCacheHits,
        resolveCalls: this.scanCounters.resolveCalls,
        candidatesMs: this.phase.candidatesMs,
        walkMs: this.phase.walkMs,
        assetCount: [...this.assets.values()].reduce((sum, byId) => sum + byId.size, 0),
        defineCount: this.defines.size,
        manifestFiles: this.manifests.size,
        manifestAssetCount,
        streams: this.streams.length,
        sourceCandidates: this.sourceCandidates.length,
        elapsedMs: Date.now() - start,
      },
    };
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
    // for binary / unparseable targets.
    const parsed = await this.readDocument(path);
    if (!parsed) return;
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
    const sdk = resolve(this.opts.sdkDir).toLowerCase();
    if (p.startsWith(project + "\\")) return "project";
    if (sdk && p.startsWith(sdk + "\\")) return "sdk";
    return "project";
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
      if (arr.some((a) => a.file === def.file && a.line === def.line)) return;
      arr.push(def);
    } else {
      byId.set(idKey, [def]);
    }
    const all = this.assetsById.get(idKey);
    if (all) {
      if (all.some((a) => a.file === def.file && a.line === def.line)) return;
      all.push(def);
    } else {
      this.assetsById.set(idKey, [def]);
    }
  }
}

// ── Module-level helpers ─────────────────────────────────────────────

function localName(tag: string): string {
  const idx = tag.lastIndexOf(":");
  return idx >= 0 ? tag.slice(idx + 1) : tag;
}

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

function findXPointerContainer(doc: XmlDocument, xpointer: string): XmlElement | null {
  // Supports the form used by the mods:
  //   xmlns(n=uri:ea.com:eala:asset) xpointer(/n:ElementName/child::*)
  const m = /xpointer\(\/\w+:(\w+)\/child::\*\)/.exec(xpointer);
  if (!m) return null;
  const name = m[1];
  return doc.elements.find((el) => localName(el.name) === name) ?? null;
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
