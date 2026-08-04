import * as vscode from "vscode";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import {
  CachedDirectoryWalker,
  isContentRelevantPath,
  isWatcherNoisePath,
} from "./indexer/fileScanner";
import { ModIndexer } from "./indexer/indexer";
import {
  DocumentCache,
  IncludeResolveCache,
  IndexRecordsCache,
  InvalidationsEpoch,
  normKey,
} from "./indexer/caches";
import {
  DiskRecordsCache,
  diskCacheKey,
  type DiskCacheIdentity,
  type DiskCacheLoadStats,
} from "./indexer/diskCache";
import { buildSearchPaths, type SearchPaths } from "./indexer/includeResolver";
import { extractIndexRecords } from "./indexer/records";
import { LineMap, parseXml, stripBom } from "./language/xmlParser";
import {
  buildDocumentScope,
  withLocalOverlay,
  type DocumentScope,
} from "./indexer/localScope";
import type { ModIndex, ParsedFile } from "./indexer/types";
import { readSettings, type ExtensionSettings } from "./settings";

const REBUILD_DEBOUNCE_MS = 1500;

export class ModWorkspace {
  index: ModIndex | null = null;
  indexer: ModIndexer | null = null;
  projectRoot: string | null = null;
  settings: ExtensionSettings;

  private walker = new CachedDirectoryWalker();
  // Caches owned here survive rebuilds: a fresh ModIndexer reuses them and
  // only re-reads files whose stat changed (crucial for the ~2.6 GB of .w3x
  // art assets in a project like Corona).
  private documentCache = new DocumentCache();
  private recordsCache = new IndexRecordsCache();
  private resolveCache = new IncludeResolveCache();
  /**
   * Monotonic invalidation counter. A build captures the epoch when it
   * starts; snapshots published after any invalidation are marked stale so
   * features can tell users "this index may be slightly out of date" while
   * the follow-up rebuild converges.
   */
  private epoch = new InvalidationsEpoch();
  /** On-disk records cache (cold-start acceleration). */
  private diskCachePath: string | null = null;
  private diskCache: DiskRecordsCache | null = null;
  private diskCacheStats: DiskCacheLoadStats = {
    fileExists: false,
    keyMatched: false,
    loaded: 0,
    validated: 0,
    dropped: 0,
  };
  private diskSaved = false;
  private saving: Promise<void> | null = null;
  /** Document-local scopes (parse + expanded tree + overlay), per open doc. */
  private localScopes = new Map<
    string,
    { version: number; indexEpoch: number; scope: DocumentScope }
  >();
  private localScopeBuilds = new Map<string, Promise<DocumentScope>>();
  private indexEpochValue = 0;
  /** Diagnostics: how many builds ran and what triggered the last one. */
  private buildCountValue = 0;
  private lastBuildTrigger = "initial";
  private pendingTrigger: string | null = null;
  private output: vscode.OutputChannel;
  /** Called whenever a new index snapshot is published (phase or final). */
  onIndexUpdate?: () => void;
  private context: vscode.ExtensionContext;
  private watchers: vscode.FileSystemWatcher[] = [];
  private statusBar: vscode.StatusBarItem;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private building = false;
  private dirty = false;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.settings = readSettings();
    const storageUri = context.storageUri ?? context.globalStorageUri;
    if (storageUri) {
      this.diskCachePath = join(storageUri.fsPath, "index-records-v1.json.gz");
    }
    this.output = vscode.window.createOutputChannel("RA3 Mod XML");
    this.statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.statusBar.name = "RA3 Mod XML";
    this.statusBar.command = "ra3modxml.openIndexReport";
    context.subscriptions.push(this.statusBar);
    context.subscriptions.push(
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.localScopes.delete(document.uri.toString());
      }),
    );
  }

  isRa3Workspace(): boolean {
    return this.projectRoot != null;
  }

  /** Appends a line to the "RA3 Mod XML" output channel (debug/troubleshooting). */
  log(message: string): void {
    this.output.appendLine(message);
  }

  /** True while a rebuild is running (before any snapshot is published). */
  get isBuilding(): boolean {
    return this.building;
  }

  /** Number of index builds performed in this session. */
  get buildCount(): number {
    return this.buildCountValue;
  }

  /** Why the last build started ("initial", "save", "watcher-*", ...). */
  get lastTrigger(): string {
    return this.lastBuildTrigger;
  }

  detectProjectRoot(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return null;
    for (const folder of folders) {
      const found = findProjectRoot(folder.uri.fsPath);
      if (found) return found;
    }
    return null;
  }

  async initialize(): Promise<void> {
    this.projectRoot = this.detectProjectRoot();
    if (!this.projectRoot) {
      this.statusBar.hide();
      return;
    }
    this.startWatching();
    this.statusBar.text = "$(sync~spin) RA3 XML: indexing…";
    this.statusBar.show();
    await this.rebuild(false, "initial");
  }

  /**
   * Invalidates cached documents for a path (called by the file watcher and
   * on document save), so the next rebuild re-reads it instead of trusting
   * the cached copy.
   */
  invalidate(path: string): void {
    if (!path) return;
    this.epoch.mark();
    this.documentCache.invalidate(path);
    this.recordsCache.invalidate(path);
  }

  /**
   * Called when files are created or deleted: include-resolution results
   * (which encode file existence) are no longer trustworthy.
   */
  invalidateExistence(): void {
    this.epoch.mark();
    this.resolveCache.clear();
  }

  /**
   * Watches the project, SDK and extra DATA roots for file changes and
   * invalidates the corresponding cache entries. With caches invalidated
   * precisely, rebuilds can trust every other cached file and skip per-file
   * stats (huge win on mechanical drives; Corona rebuild dropped from ~38s
   * to a few seconds).
   */
  private startWatching(): void {
    if (!this.projectRoot) return;
    const roots = new Set([
      this.projectRoot,
      this.settings.sdkPath,
      ...this.settings.additionalDataSearchPaths,
    ]);
    for (const root of roots) {
      if (!existsSync(root)) continue;
      try {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(root, "**/*"),
        );
        watcher.onDidCreate((uri) => {
          if (isWatcherNoisePath(uri.fsPath)) return;
          this.output.appendLine(`[watcher-create] ${uri.fsPath}`);
          this.invalidate(uri.fsPath);
          this.invalidateExistence();
          this.scheduleRebuild("watcher-create");
        });
        watcher.onDidChange((uri) => {
          if (isWatcherNoisePath(uri.fsPath)) return;
          // Content changes only matter for files that can change index
          // records (XML-ish documents); textures/binary art changes do not.
          if (
            !isContentRelevantPath(uri.fsPath) &&
            !this.isIndexedPath(uri.fsPath)
          ) {
            return;
          }
          this.output.appendLine(`[watcher-change] ${uri.fsPath}`);
          this.invalidate(uri.fsPath);
          this.scheduleRebuild("watcher-change");
        });
        watcher.onDidDelete((uri) => {
          if (isWatcherNoisePath(uri.fsPath)) return;
          this.output.appendLine(`[watcher-delete] ${uri.fsPath}`);
          this.invalidate(uri.fsPath);
          this.invalidateExistence();
          this.scheduleRebuild("watcher-delete");
        });
        this.watchers.push(watcher);
        this.context.subscriptions.push(watcher);
      } catch {
        // The root may be temporarily unavailable (e.g. removable drive);
        // indexing still works, just without watcher-based invalidation.
      }
    }
  }

  /** True when the path is part of the current index (any build state). */
  private isIndexedPath(fsPath: string): boolean {
    if (this.indexer?.isIndexedFile(fsPath)) return true;
    return this.index?.files.has(normKey(fsPath)) ?? false;
  }

  scheduleRebuild(reason = "unknown"): void {
    if (!this.projectRoot) return;
    this.pendingTrigger = reason;
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => {
      void this.rebuild(false, this.pendingTrigger ?? reason);
    }, REBUILD_DEBOUNCE_MS);
  }

  async rebuild(force = false, trigger = "unknown"): Promise<void> {
    if (!this.projectRoot) return;
    if (this.building) {
      this.dirty = true;
      return;
    }
    if (force) this.resolveCache.clear();
    this.building = true;
    this.buildCountValue++;
    this.lastBuildTrigger = trigger;
    this.output.appendLine(
      `[build #${this.buildCountValue}] trigger=${trigger} force=${force} start=${new Date().toISOString()}`,
    );
    this.settings = readSettings();
    const epochAtStart = this.epoch.snapshot();
    try {
      // Cold start: seed the records cache from disk (stat-validated) so a
      // fresh session does not re-read unchanged files (Corona: 2.6 GB of
      // art assets) just because the in-memory caches are empty.
      await this.seedRecordsFromDisk();
      this.statusBar.text = "$(sync~spin) RA3 XML: indexing…";
      const indexer = new ModIndexer({
        projectDir: this.projectRoot,
        sdkDir: this.settings.sdkPath,
        builtmodsDirs: this.settings.builtmodsDirs,
        indexSageXml: this.settings.indexSageXml,
        additionalDataSearchPaths: this.settings.additionalDataSearchPaths,
        walker: this.walker,
        documentCache: this.documentCache,
        recordsCache: this.recordsCache,
        resolveCache: this.resolveCache,
        // Trust cache entries unless the user explicitly asked for a full
        // verification (ra3modxml.reindex).
        trustUnchanged: !force,
      });
      this.indexer = indexer;
      // The XML phase is published as soon as it is ready, so completion /
      // navigation / diagnostics work while the art scan continues.
      const finalIndex = await indexer.build((phaseIndex) => {
        this.publishIndex(phaseIndex, epochAtStart);
      });
      this.publishIndex(finalIndex, epochAtStart);
      this.output.appendLine(
        `[build #${this.buildCountValue}] done in ${(finalIndex.stats.elapsedMs / 1000).toFixed(1)}s (phase=${finalIndex.phase}, assets=${finalIndex.stats.assetCount}, stale=${finalIndex.stale === true}, walk=${(finalIndex.stats.walkMs / 1000).toFixed(1)}s, candidates=${(finalIndex.stats.candidatesMs / 1000).toFixed(1)}s, art=${(finalIndex.stats.artScanMs / 1000).toFixed(1)}s)`,
      );
      this.saveRecordsToDisk();
    } catch (err) {
      if (this.index) {
        // Keep the last good snapshot (marked stale) instead of disabling the
        // extension entirely; a later rebuild can recover.
        this.index.stale = true;
        this.statusBar.text = "$(error) RA3 XML: indexing failed (stale index kept)";
        this.statusBar.tooltip = err instanceof Error ? err.message : String(err);
        this.onIndexUpdate?.();
      } else {
        this.statusBar.text = "$(error) RA3 XML: indexing failed";
        this.statusBar.tooltip = err instanceof Error ? err.message : String(err);
      }
    } finally {
      this.building = false;
      if (this.dirty) {
        this.dirty = false;
        void this.rebuild(false, `dirty-followup (${this.lastBuildTrigger})`);
      } else if (this.index) {
        // Build is fully over: refresh diagnostics with full local scopes
        // (the snapshot published while `building` was still true only got
        // cheap parse-only scopes).
        this.onIndexUpdate?.();
      }
    }
  }

  private diskCacheIdentity(): DiskCacheIdentity | null {
    if (!this.projectRoot) return null;
    return {
      projectDir: this.projectRoot,
      sdkDir: this.settings.sdkPath,
      indexSageXml: this.settings.indexSageXml,
      additionalDataSearchPaths: this.settings.additionalDataSearchPaths,
      builtmodsDirs: this.settings.builtmodsDirs,
    };
  }

  /** Loads + stat-validates the disk cache into the records cache once. */
  private async seedRecordsFromDisk(): Promise<void> {
    if (this.recordsCache.size > 0) return;
    const identity = this.diskCacheIdentity();
    if (!this.diskCachePath || !identity) return;
    this.diskCache = new DiskRecordsCache(this.diskCachePath, identity);
    this.statusBar.text = "$(sync~spin) RA3 XML: validating cache…";
    const { records, stats } = await this.diskCache.loadValidated();
    this.diskCacheStats = stats;
    this.diskSaved = false;
    for (const rec of records) {
      this.recordsCache.set(rec.key, {
        stat: rec.stat,
        records: rec.records,
        kind: rec.kind,
      });
    }
  }

  /** Persists the records cache after a successful build (best-effort). */
  private saveRecordsToDisk(): void {
    if (!this.diskCache) return;
    // Snapshot the entries now: the save runs in the background while the
    // next rebuild may already be mutating the live cache.
    const entries = [...this.recordsCache.entries()];
    const prev = this.saving ?? Promise.resolve();
    this.saving = prev
      .then(async () => {
        await this.diskCache!.save(entries);
        this.diskSaved = true;
      })
      .catch(() => {
        // Disk persistence is best-effort; the in-memory cache still works.
      });
  }

  /**
   * Clears every cache (in-memory + disk + directory walker) and starts a
   * full forced rebuild. Used by the `ra3modxml.clearCache` command.
   */
  clearCaches(): void {
    this.localScopes.clear();
    this.documentCache.clear();
    this.recordsCache.clear();
    this.resolveCache.clear();
    this.walker.clear();
    this.diskCacheStats = {
      fileExists: false,
      keyMatched: false,
      loaded: 0,
      validated: 0,
      dropped: 0,
    };
    this.diskSaved = false;
    void this.diskCache?.clear();
    void this.rebuild(true, "clear-cache");
  }

  /** Human-readable cache status for the `ra3modxml.showCacheReport` command. */
  async cacheReport(): Promise<string> {
    const lines: string[] = ["RA3 Mod XML cache report"];
    lines.push(`Disk cache: ${this.diskCachePath ?? "not available"}`);
    if (this.diskCachePath) {
      const status = await this.diskCache?.status();
      lines.push(
        `  file: ${status?.exists ? `${(status.sizeBytes / 1024).toFixed(1)} KB` : "missing"}`,
      );
      const identity = this.diskCacheIdentity();
      lines.push(`  identity key: ${identity ? diskCacheKey(identity) : "-"}`);
      lines.push(
        `  last load: file=${this.diskCacheStats.fileExists} keyMatched=${this.diskCacheStats.keyMatched} loaded=${this.diskCacheStats.loaded} validated=${this.diskCacheStats.validated} dropped=${this.diskCacheStats.dropped}`,
      );
      lines.push(`  saved after last build: ${this.diskSaved}`);
    }
    lines.push(
      `In-memory: ${this.recordsCache.size} record entries · ${this.documentCache.size} documents (${this.documentCache.elements} elements) · ${this.resolveCache.size} include resolutions`,
    );
    lines.push(`Builds: #${this.buildCount} (last trigger: ${this.lastBuildTrigger})`);
    if (this.index) {
      const s = this.index.stats;
      lines.push(
        `Last build: snapshotHits=${s.snapshotHits} snapshotFallbacks=${s.snapshotFallbacks} recordsCacheHits=${s.recordsCacheHits} shallowCacheHits=${s.shallowCacheHits}`,
      );
    }
    return lines.join("\n");
  }

  /**
   * Publishes an index snapshot (intermediate phase or final). If any file
   * was invalidated while the snapshot was being built, it is marked stale;
   * the dirty/rebuild mechanism converges shortly after.
   */
  private publishIndex(index: ModIndex, epochAtStart: number): void {
    if (this.epoch.changedSince(epochAtStart)) index.stale = true;
    this.index = index;
    this.indexEpochValue++;
    // The merged index attached to a document scope changes with every
    // published snapshot, so cached scopes are rebuilt lazily on next use.
    this.localScopes.clear();
    this.updateStatusBar(index);
    this.onIndexUpdate?.();
    if (!index.complete) {
      this.output.appendLine(
        `[build #${this.buildCountValue}] phase A published in ${(index.stats.elapsedMs / 1000).toFixed(1)}s (${index.stats.assetCount} assets, ${index.stats.deferredArtFiles} art files pending)`,
      );
    }
  }

  private updateStatusBar(idx: ModIndex): void {
    const s = idx.stats;
    const stale = idx.stale ? " (stale)" : "";
    if (!idx.complete) {
      this.statusBar.text = `$(sync~spin) RA3 XML: XML indexed, scanning art…${stale}`;
    } else {
      this.statusBar.text = `$(symbol-misc) RA3 XML: ${formatCount(s.assetCount)} assets${stale}`;
    }
    this.statusBar.tooltip =
      `${s.projectDir}\n` +
      `${s.indexedFiles} files indexed (${s.parsedFiles} parsed, ${s.shallowScannedFiles} art assets shallow-scanned, ${(s.elapsedMs / 1000).toFixed(1)}s)\n` +
      `${s.assetCount} assets (${s.manifestAssetCount} from ${s.manifestFiles} manifests)\n` +
      `${s.defineCount} defines, ${s.streams} streams, ${s.sourceCandidates} include candidates\n` +
      `Phase: ${s.phase} · Complete: ${s.complete}${stale}`;
  }

  /**
   * Search paths derived from the current settings, usable even before the
   * first index snapshot exists (include links / hover / diagnostics).
   */
  searchPaths(): SearchPaths | null {
    if (!this.projectRoot) return null;
    return buildSearchPaths(this.settings.sdkPath, this.projectRoot);
  }

  /**
   * Returns the document scope for the current text: original parse, expanded
   * logical tree, local overlay and overlay-aware merged index. Cached by
   * URI + document version + global index epoch.
   */
  async getScope(document: vscode.TextDocument): Promise<DocumentScope> {
    const key = document.uri.toString();
    const cached = this.localScopes.get(key);
    if (
      cached &&
      cached.version === document.version &&
      cached.indexEpoch === this.indexEpochValue
    ) {
      return cached.scope;
    }
    // While a rebuild is running, avoid competing with the indexer for disk
    // I/O: serve a parse-only scope (current file + XSD context, no include
    // chain / logical expansion). The published snapshot clears this cache,
    // so the next provider call after the build gets the full local scope.
    if (this.building) {
      return this.buildCheapScope(document);
    }
    const pending = this.localScopeBuilds.get(key);
    if (pending) return pending;
    const versionAtStart = document.version;
    const promise = this.buildScope(document)
      .then((scope) => {
        this.localScopes.set(key, {
          version: versionAtStart,
          indexEpoch: this.indexEpochValue,
          scope,
        });
        return scope;
      })
      .finally(() => {
        this.localScopeBuilds.delete(key);
      });
    this.localScopeBuilds.set(key, promise);
    return promise;
  }

  /**
   * Returns the global index with this document's local overlay attached, or
   * a minimal local-only index while the global index is still building.
   */
  async getIndex(document: vscode.TextDocument): Promise<ModIndex | null> {
    if (!this.isRa3Workspace()) return null;
    return (await this.getScope(document)).merged;
  }

  private async buildScope(
    document: vscode.TextDocument,
  ): Promise<DocumentScope> {
    const projectRoot = this.projectRoot;
    if (!projectRoot) throw new Error("RA3 workspace root is not available");
    const searchPaths =
      this.searchPaths() ?? buildSearchPaths(this.settings.sdkPath, projectRoot);
    const readRecords = async (path: string): Promise<ParsedFile | null> =>
      this.indexer ? this.indexer.readDocument(path) : this.fallbackRead(path);
    const readDom = async (path: string): Promise<ParsedFile | null> =>
      this.indexer ? this.indexer.readDom(path) : this.fallbackRead(path);
    const scope = await buildDocumentScope(
      document.uri.fsPath,
      document.getText(),
      document.version,
      {
        projectDir: projectRoot,
        sdkDir: this.settings.sdkPath,
        searchPaths,
        readRecords,
        readDom,
      },
    );
    scope.merged = withLocalOverlay(
      this.index,
      scope.overlay,
      projectRoot,
      this.settings.sdkPath,
    );
    return scope;
  }

  private async buildCheapScope(
    document: vscode.TextDocument,
  ): Promise<DocumentScope> {
    const projectRoot = this.projectRoot;
    if (!projectRoot) throw new Error("RA3 workspace root is not available");
    const searchPaths =
      this.searchPaths() ?? buildSearchPaths(this.settings.sdkPath, projectRoot);
    const scope = await buildDocumentScope(
      document.uri.fsPath,
      document.getText(),
      document.version,
      {
        projectDir: projectRoot,
        sdkDir: this.settings.sdkPath,
        searchPaths,
        readRecords: async () => null,
        readDom: async () => null,
      },
    );
    scope.merged = withLocalOverlay(
      this.index,
      scope.overlay,
      projectRoot,
      this.settings.sdkPath,
    );
    return scope;
  }

  /**
   * Fallback used before the first ModIndexer exists (e.g. during initial
   * activation): parses an XML file directly so the document-local scope can
   * still follow small include chains.
   */
  private async fallbackRead(path: string): Promise<ParsedFile | null> {
    try {
      const st = await stat(path);
      if (st.size > 4 * 1024 * 1024) return null;
      const text = stripBom(await readFile(path, "utf8"));
      const lineMap = new LineMap(text);
      const parse = parseXml(text);
      return {
        file: { path: resolve(path), stat: null },
        parse,
        records: extractIndexRecords(parse, lineMap),
        lineMap,
      };
    } catch {
      return null;
    }
  }

  /** Parses the (possibly unsaved) in-memory text of the active document. */
  async parseText(path: string, text: string) {
    const { parseXml, LineMap } = await import("./language/xmlParser");
    const parse = parseXml(text);
    return {
      file: { path, stat: null },
      parse,
      records: null,
      lineMap: new LineMap(text),
    };
  }

  dispose(): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.statusBar.dispose();
    this.output.dispose();
  }
}

function findProjectRoot(startDir: string): string | null {
  let dir = startDir;
  // Guard against walking above reasonable roots.
  for (let i = 0; i < 12; i++) {
    try {
      if (existsSync(join(dir, "Data", "Mod.xml"))) return dir;
      if (existsSync(join(dir, "mod.babproj"))) return dir;
    } catch {
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function formatCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
