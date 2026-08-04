import { dirname, resolve } from "node:path";
import { LineMap, parseXml, type XmlDocument } from "../language/xmlParser";
import { extractIndexRecords } from "./records";
import { resolveSource, type SearchPaths } from "./includeResolver";
import { expandDocument, type LogicalDocument } from "./logicalTree";
import type {
  AssetDef,
  DefineDef,
  LocalOverlay,
  ModIndex,
  ParsedFile,
} from "./types";

export interface LocalScopeContext {
  projectDir: string;
  sdkDir: string;
  searchPaths: SearchPaths;
  /** Reads a file's compact index records (full parse or shallow scan). */
  readRecords(path: string): Promise<ParsedFile | null>;
  /** Reads a file and guarantees a DOM parse tree. */
  readDom(path: string): Promise<ParsedFile | null>;
}

/**
 * Everything the features need for the currently open document: the original
 * parse, the expanded logical tree, per-source line maps, the local overlay
 * and the overlay-aware index for lookups.
 */
export interface DocumentScope {
  uri: string;
  version: number;
  parse: XmlDocument;
  lineMap: LineMap;
  expanded: LogicalDocument;
  /** scopePathKey(file) -> line map (current file + expanded include targets). */
  lineMaps: Map<string, LineMap>;
  /** Local assets/defines from the document itself and its include chain. */
  overlay: LocalOverlay;
  /** Global index with `local` attached (or a minimal standalone index). */
  merged: ModIndex | null;
}

/** Normalized key used for source-file identity / line-map lookup. */
export function scopePathKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/**
 * Builds the document scope for the current (possibly unsaved) text:
 *  - a local overlay of assets/defines reachable from this file;
 *  - a logical tree with supported xi:include targets spliced in place.
 */
export async function buildDocumentScope(
  uri: string,
  text: string,
  version: number,
  ctx: LocalScopeContext,
): Promise<DocumentScope> {
  const lineMap = new LineMap(text);
  const parse = parseXml(text);
  const builder = new OverlayBuilder(ctx);
  await builder.addEntry(uri, parse, lineMap);

  const expanded = await expandDocument(uri, parse, {
    resolve: (source, currentDir) =>
      resolveSource(source, currentDir, ctx.searchPaths).path,
    readDom: async (path) => {
      const parsed = await ctx.readDom(path);
      return parsed?.parse && parsed.lineMap
        ? { parse: parsed.parse, lineMap: parsed.lineMap }
        : null;
    },
  });

  const lineMaps = new Map<string, LineMap>();
  lineMaps.set(scopePathKey(uri), lineMap);
  for (const [path, lm] of builder.lineMaps) {
    if (!lineMaps.has(path)) lineMaps.set(path, lm);
  }

  return {
    uri,
    version,
    parse,
    lineMap,
    expanded,
    lineMaps,
    overlay: builder.overlay,
    merged: null,
  };
}

/**
 * Attaches a document-local overlay to a global index without copying the
 * global maps. When there is no global index yet, returns a minimal standalone
 * index so the local chain alone can serve completions / references.
 */
export function withLocalOverlay(
  global: ModIndex | null,
  overlay: LocalOverlay,
  projectDir: string,
  sdkDir: string,
): ModIndex {
  if (!global) {
    return {
      projectDir,
      sdkDir,
      complete: false,
      phase: "xml",
      assets: new Map(),
      assetsById: new Map(),
      defines: new Map(),
      files: new Map(),
      streams: [],
      manifests: new Map(),
      sourceCandidates: [],
      diagnostics: [],
      stats: {
        projectDir,
        sdkDir,
        phase: "xml",
        complete: false,
        indexedFiles: 0,
        parsedFiles: 0,
        shallowScannedFiles: 0,
        deferredArtFiles: 0,
        shallowCacheHits: 0,
        recordsCacheHits: 0,
        resolveCacheHits: 0,
        resolveCalls: 0,
        snapshotHits: 0,
        snapshotFallbacks: 0,
        candidatesMs: 0,
        walkMs: 0,
        artScanMs: 0,
        assetCount: 0,
        defineCount: 0,
        manifestFiles: 0,
        manifestAssetCount: 0,
        streams: 0,
        sourceCandidates: 0,
        elapsedMs: 0,
      },
      local: overlay,
    };
  }
  return { ...global, local: overlay };
}

const MAX_LOCAL_DEPTH = 64;

class OverlayBuilder {
  readonly overlay: LocalOverlay = {
    assets: new Map(),
    assetsById: new Map(),
    defines: new Map(),
  };
  readonly lineMaps = new Map<string, LineMap>();
  private visited = new Set<string>();

  constructor(private ctx: LocalScopeContext) {}

  async addEntry(
    path: string,
    parse: XmlDocument,
    lineMap: LineMap,
  ): Promise<void> {
    this.lineMaps.set(scopePathKey(path), lineMap);
    await this.addParsed({
      file: { path: resolve(path), stat: null },
      parse,
      records: extractIndexRecords(parse, lineMap),
      lineMap,
    }, 0);
  }

  async addFile(path: string, depth: number): Promise<void> {
    if (depth > MAX_LOCAL_DEPTH) return;
    const parsed = await this.ctx.readRecords(path);
    if (parsed) await this.addParsed(parsed, depth);
  }

  private async addParsed(parsed: ParsedFile, depth: number): Promise<void> {
    const path = parsed.file.path;
    const key = scopePathKey(path);
    if (!parsed.records || this.visited.has(key)) return;
    this.visited.add(key);
    if (parsed.lineMap) this.lineMaps.set(key, parsed.lineMap);

    const origin = this.originOf(path);
    for (const asset of parsed.records.assets) {
      this.addAsset({
        type: asset.type,
        id: asset.id,
        file: path,
        line: asset.line,
        origin,
        stream: "local",
      });
    }
    for (const define of parsed.records.defines) {
      const entry: DefineDef = {
        name: define.name,
        value: define.value,
        file: path,
        line: define.line,
        origin,
      };
      const arr = this.overlay.defines.get(define.name.toLowerCase());
      if (arr) arr.push(entry);
      else this.overlay.defines.set(define.name.toLowerCase(), [entry]);
    }

    for (const inc of parsed.records.includes) {
      const resolved = resolveSource(inc.source, dirname(path), this.ctx.searchPaths);
      if (!resolved.path) continue;
      if (inc.type === "all" || inc.type === "instance") {
        await this.addFile(resolved.path, depth + 1);
      }
      // type="reference" points at compiled manifests; their assets are
      // provided by the global index, so the local text overlay skips them.
    }

    for (const xi of [
      ...parsed.records.nestedXiIncludes,
      ...parsed.records.rootXiIncludes,
    ]) {
      const resolved = resolveSource(xi.href, dirname(path), this.ctx.searchPaths);
      if (resolved.path) await this.addFile(resolved.path, depth + 1);
    }
  }

  private addAsset(def: AssetDef): void {
    const typeKey = def.type;
    const idKey = def.id.toLowerCase();
    let byId = this.overlay.assets.get(typeKey);
    if (!byId) {
      byId = new Map();
      this.overlay.assets.set(typeKey, byId);
    }
    const arr = byId.get(idKey);
    if (arr) {
      if (arr.some((a) => a.file === def.file && a.line === def.line)) return;
      arr.push(def);
    } else {
      byId.set(idKey, [def]);
    }
    const all = this.overlay.assetsById.get(idKey);
    if (all) {
      if (all.some((a) => a.file === def.file && a.line === def.line)) return;
      all.push(def);
    } else {
      this.overlay.assetsById.set(idKey, [def]);
    }
  }

  private originOf(path: string): "project" | "sdk" | "manifest" {
    const p = resolve(path).toLowerCase();
    const project = resolve(this.ctx.projectDir).toLowerCase();
    const sdk = resolve(this.ctx.sdkDir).toLowerCase();
    if (p.startsWith(project + "\\")) return "project";
    if (sdk && p.startsWith(sdk + "\\")) return "sdk";
    return "project";
  }
}
