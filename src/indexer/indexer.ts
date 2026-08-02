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
import { DocumentCache, ShallowScanCache, normKey } from "./caches";
import { scanXmlShallow } from "./shallowScan";
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
  private shallowDocs: ShallowScanCache;
  private scanCounters = { shallowScannedFiles: 0, shallowCacheHits: 0 };
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
    this.shallowDocs = opts.shallowCache ?? new ShallowScanCache();
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
    const mode = await this.detectXmlMode(path);
    if (mode === "shallow") return this.scanShallow(path);
    if (mode === "binary") {
      try {
        const st = await stat(path);
        const file: IndexedFile = { path: resolve(path), stat: { mtimeMs: st.mtimeMs, size: st.size } };
        this.files.set(key, file);
        return { file, parse: null, shallow: null, lineMap: null };
      } catch {
        const file: IndexedFile = { path: resolve(path), stat: null };
        this.files.set(key, file);
        return { file, parse: null, shallow: null, lineMap: null };
      }
    }
    try {
      const st = await stat(path);
      const hit = this.docs.get(key);
      if (
        hit?.file.stat &&
        hit.file.stat.mtimeMs === st.mtimeMs &&
        hit.file.stat.size === st.size
      ) {
        this.files.set(key, hit.file);
        return hit;
      }
      if (st.size > MAX_PARSE_BYTES) {
        const file: IndexedFile = { path: resolve(path), stat: { mtimeMs: st.mtimeMs, size: st.size } };
        const parsed: ParsedFile = { file, parse: null, shallow: null, lineMap: null };
        this.docs.set(parsed);
        this.files.set(key, file);
        return parsed;
      }
      const text = stripBom(await readFile(path, "utf8"));
      const parse = parseXml(text);
      const parsed: ParsedFile = {
        file: { path: resolve(path), stat: { mtimeMs: st.mtimeMs, size: st.size } },
        parse,
        shallow: null,
        lineMap: new LineMap(text),
      };
      this.docs.set(parsed);
      this.files.set(key, parsed.file);
      return parsed;
    } catch {
      const parsed: ParsedFile = {
        file: { path: resolve(path), stat: null },
        parse: null,
        shallow: null,
        lineMap: null,
      };
      this.docs.set(parsed);
      this.files.set(key, parsed.file);
      return parsed;
    }
  }

  /**
   * Shallow-scans a large art-asset XML document (no DOM built) and caches
   * the top-level records. Cache hits are counted separately so tests and
   * the index report can verify that rebuilds skip unchanged files.
   */
  private async scanShallow(path: string): Promise<ParsedFile | null> {
    const key = normKey(path);
    try {
      const st = await stat(path);
      const hit = this.shallowDocs.get(key);
      if (
        hit?.file.stat &&
        hit.file.stat.mtimeMs === st.mtimeMs &&
        hit.file.stat.size === st.size
      ) {
        this.scanCounters.shallowCacheHits++;
        this.files.set(key, hit.file);
        return hit;
      }
      const text = stripBom(await readFile(path, "utf8"));
      const shallow = scanXmlShallow(text);
      const parsed: ParsedFile = {
        file: { path: resolve(path), stat: { mtimeMs: st.mtimeMs, size: st.size } },
        parse: null,
        shallow,
        lineMap: new LineMap(text),
      };
      this.shallowDocs.set(parsed);
      this.files.set(key, parsed.file);
      this.scanCounters.shallowScannedFiles++;
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

    // ── Source completion candidates ──
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

    // readDocument handles every mode: full XML parse, shallow scan for
    // art-asset XML (.w3x / content-sniffed), or binary registration only.
    const parsed = await this.readDocument(path);
    if (!parsed) return;
    if (parsed.shallow) {
      await this.walkShallow(parsed, stream, depth, mode === "instance");
      return;
    }
    if (!parsed.parse?.root) return;
    const root = parsed.parse.root;

    for (const child of root.children) {
      const local = localName(child.name);
      if (local === "Tags" || local === "Includes" || local === "Defines") continue;
      if (local === "include") {
        await this.handleXiInclude(child, parsed, stream, depth);
        continue;
      }
      const idAttr = child.attrs.find((a) => a.name === "id");
      if (idAttr) {
        this.addAsset({
          type: local,
          id: idAttr.value,
          file: parsed.file.path,
          line: lineOf(parsed, idAttr.valueStart),
          origin: this.originOf(parsed.file.path),
          stream: stream.name,
          viaInstance: mode === "instance",
        });
      }
    }

    for (const child of root.children) {
      if (localName(child.name) !== "Defines") continue;
      for (const define of child.children) {
        if (localName(define.name) !== "Define") continue;
        const name = define.attrs.find((a) => a.name === "name")?.value;
        const value = define.attrs.find((a) => a.name === "value")?.value;
        if (!name) continue;
        const entry: DefineDef = {
          name,
          value: value ?? "",
          file: parsed.file.path,
          line: lineOf(parsed, define.start),
          origin: this.originOf(parsed.file.path),
        };
        const arr = this.defines.get(name.toLowerCase());
        if (arr) arr.push(entry);
        else this.defines.set(name.toLowerCase(), [entry]);
      }
    }

    const includesElem = root.children.find((c) => localName(c.name) === "Includes");
    if (includesElem) {
      for (const inc of includesElem.children) {
        if (localName(inc.name) !== "Include") continue;
        const type = inc.attrs.find((a) => a.name === "type")?.value;
        const source = inc.attrs.find((a) => a.name === "source")?.value;
        if (!source) continue;
        const resolved = resolveSource(source, dirname(parsed.file.path), this.searchPaths);
        if (!resolved.path) {
          this.diagnostics.push({
            file: parsed.file.path,
            line: lineOf(parsed, inc.start),
            message: `Include target not found: ${source}`,
            severity: "warning",
            code: "include-not-found",
          });
          continue;
        }
        if (type === "all" || type === "instance") {
          await this.walk(resolved.path, type === "all" ? "all" : "instance", stream, depth + 1);
        } else if (type === "reference") {
          const manifestPath = manifestPathForReference(source, this.opts.builtmodsDirs);
          if (manifestPath) {
            const loaded = await this.loadManifest(manifestPath, stream.name);
            if (!loaded) {
              // The manifest could not be parsed (missing/invalid): fall back
              // to the placeholder target so its content is still available.
              await this.walk(resolved.path, "instance", stream, depth + 1);
            }
          } else {
            // reference to a real XML file: treat its assets as available
            await this.walk(resolved.path, "instance", stream, depth + 1);
          }
        }
      }
    }

    // Nested <xi:include> anywhere in the tree (not just under the root):
    // the target content is inlined into the parent element. We make the
    // target file available and surface missing targets instead of ignoring
    // them silently.
    for (const el of parsed.parse.elements) {
      if (localName(el.name) !== "include") continue;
      if (el.parent === root) continue; // already handled in the loop above
      const href = el.attrs.find((a) => a.name === "href")?.value;
      if (!href) continue;
      const resolved = resolveSource(href, dirname(parsed.file.path), this.searchPaths);
      if (!resolved.path) {
        this.diagnostics.push({
          file: parsed.file.path,
          line: lineOf(parsed, el.start),
          message: `xi:include target not found: ${href}`,
          severity: "warning",
          code: "include-not-found",
        });
        continue;
      }
      stream.files.add(normKey(resolved.path));
      if ((await this.detectXmlMode(resolved.path)) !== "binary") {
        await this.walk(resolved.path, "all", stream, depth + 1);
      }
    }
  }

  /**
   * Consumes a shallow-scanned art-asset document: top-level assets,
   * top-level <Includes>, <Defines> and nested <xi:include> targets.
   */
  private async walkShallow(
    parsed: ParsedFile,
    stream: StreamInfo,
    depth: number,
    viaInstance: boolean,
  ): Promise<void> {
    const scan = parsed.shallow;
    if (!scan) return;
    const file = parsed.file.path;

    for (const asset of scan.assets) {
      this.addAsset({
        type: asset.name,
        id: asset.id,
        file,
        line: lineOf(parsed, asset.idValueStart),
        origin: this.originOf(file),
        stream: stream.name,
        viaInstance,
      });
    }

    for (const define of scan.defines) {
      const entry: DefineDef = {
        name: define.name,
        value: define.value,
        file,
        line: lineOf(parsed, define.start),
        origin: this.originOf(file),
      };
      const arr = this.defines.get(define.name.toLowerCase());
      if (arr) arr.push(entry);
      else this.defines.set(define.name.toLowerCase(), [entry]);
    }

    for (const inc of scan.includes) {
      const resolved = resolveSource(inc.source, dirname(file), this.searchPaths);
      if (!resolved.path) {
        this.diagnostics.push({
          file,
          line: lineOf(parsed, inc.start),
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
        const manifestPath = manifestPathForReference(inc.source, this.opts.builtmodsDirs);
        if (manifestPath) {
          const loaded = await this.loadManifest(manifestPath, stream.name);
          if (!loaded) await this.walk(resolved.path, "instance", stream, depth + 1);
        } else {
          await this.walk(resolved.path, "instance", stream, depth + 1);
        }
      }
    }

    for (const xi of scan.xiIncludes) {
      const resolved = resolveSource(xi.href, dirname(file), this.searchPaths);
      if (!resolved.path) {
        this.diagnostics.push({
          file,
          line: lineOf(parsed, xi.start),
          message: `xi:include target not found: ${xi.href}`,
          severity: "warning",
          code: "include-not-found",
        });
        continue;
      }
      stream.files.add(normKey(resolved.path));
      if ((await this.detectXmlMode(resolved.path)) !== "binary") {
        await this.walk(resolved.path, "all", stream, depth + 1);
      }
    }
  }

  private async handleXiInclude(
    xi: XmlElement,
    parent: ParsedFile,
    stream: StreamInfo,
    depth: number,
  ): Promise<void> {
    const href = xi.attrs.find((a) => a.name === "href")?.value;
    if (!href) return;
    const resolved = resolveSource(href, dirname(parent.file.path), this.searchPaths);
    if (!resolved.path) {
      this.diagnostics.push({
        file: parent.file.path,
        line: lineOf(parent, xi.start),
        message: `xi:include target not found: ${href}`,
        severity: "warning",
        code: "include-not-found",
      });
      return;
    }
    if ((await this.detectXmlMode(resolved.path)) === "binary") return;
    const target = await this.readDocument(resolved.path);
    if (!target) return;
    if (target.shallow) {
      // Shallow-scanned targets have no tree to select xpointer children
      // from; index their top-level content as a whole.
      stream.files.add(normKey(target.file.path));
      await this.walk(target.file.path, "all", stream, depth + 1);
      return;
    }
    if (!target.parse?.root) return;

    const xpointer = xi.attrs.find((a) => a.name === "xpointer")?.value ?? "";
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
    stream.files.add(normKey(target.file.path));
    await this.walk(target.file.path, "all", stream, depth + 1);
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
