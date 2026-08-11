import * as vscode from "vscode";
import { basename, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
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
  type DiskCacheRecord,
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
import type { RecordsSyncWorkspace } from "./indexer/referenceIndex";
import type { ModIndex, ParsedFile } from "./indexer/types";
import { readSettings, type ExtensionSettings } from "./settings";
import {
  discoverProjects,
  findProjectRootForFile,
  findProjectRootUpward,
} from "./projectRoot";

const REBUILD_DEBOUNCE_MS = 1500;
/** Log a disk-cache validation progress line every N validated records. */
const CACHE_PROGRESS_LOG_EVERY = 1000;

/** Local time `HH:mm:ss.mmm` prefix for output-channel log lines. */
function logTime(): string {
  const d = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}]`;
}

/**
 * Per-project state. Caches (document / records / include resolution / dir
 * walker) are shared across projects because they are keyed by absolute
 * path; builds are serialized through a global queue so the shared caches
 * are never written concurrently.
 */
interface ProjectState {
  /** Absolute project root (the directory carrying the marker). */
  root: string;
  index: ModIndex | null;
  indexer: ModIndexer | null;
  building: boolean;
  dirty: boolean;
  buildCount: number;
  lastTrigger: string;
  pendingTrigger: string | null;
  rebuildTimer: ReturnType<typeof setTimeout> | null;
  epoch: InvalidationsEpoch;
  diskCache: DiskRecordsCache | null;
  diskCacheStats: DiskCacheLoadStats;
  diskSaved: boolean;
  saving: Promise<void> | null;
}

function emptyDiskCacheStats(): DiskCacheLoadStats {
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

export class ModWorkspace {
  settings: ExtensionSettings;
  /** Called whenever a new index snapshot is published (phase or final). */
  onIndexUpdate?: () => void;
  /** Called whenever a project rebuild starts (used for refresh safety nets). */
  onBuildStart?: () => void;

  private states = new Map<string, ProjectState>();
  /** Caches owned here survive rebuilds and are shared by every project. */
  private walker = new CachedDirectoryWalker();
  private documentCache = new DocumentCache();
  private recordsCache = new IndexRecordsCache();
  private resolveCache = new IncludeResolveCache();
  /** Document-local scopes (parse + expanded tree + overlay), per open doc. */
  private localScopes = new Map<
    string,
    { version: number; indexEpoch: number; scope: DocumentScope }
  >();
  private localScopeBuilds = new Map<string, Promise<DocumentScope>>();
  /** Global epoch: any published snapshot invalidates cached doc scopes. */
  private indexEpochValue = 0;
  /** file (normKey) -> project root (or null). Avoids per-keystroke fs walks. */
  private rootForPathCache = new Map<string, string | null>();
  /** Global serialized build queue (shared caches forbid concurrent builds). */
  private buildChain: Promise<void> = Promise.resolve();
  private output: vscode.OutputChannel;
  /** Called whenever a new index snapshot is published (phase or final). */
  private statusBar: vscode.StatusBarItem;
  private context: vscode.ExtensionContext;
  private storageDir: string | null;
  private watchers: vscode.FileSystemWatcher[] = [];

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.settings = readSettings();
    this.storageDir = (context.storageUri ?? context.globalStorageUri)?.fsPath ?? null;
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

  /** True when at least one project has been discovered. */
  isRa3Workspace(): boolean {
    return this.states.size > 0;
  }

  /** Appends a line to the "RA3 Mod XML" output channel (debug/troubleshooting). */
  log(message: string): void {
    this.output.appendLine(`${logTime()} ${message}`);
  }

  /** True while any project rebuild is running (before its snapshot lands). */
  get isBuilding(): boolean {
    for (const st of this.states.values()) {
      if (st.building) return true;
    }
    return false;
  }

  /** Number of index builds performed for the active project in this session. */
  get buildCount(): number {
    return this.activeState()?.buildCount ?? 0;
  }

  /** Why the active project's last build started. */
  get lastTrigger(): string {
    return this.activeState()?.lastTrigger ?? "";
  }

  /** Active project root (fallback: first discovered project). */
  get projectRoot(): string | null {
    return this.activeState()?.root ?? this.states.values().next().value?.root ?? null;
  }

  /** Active project index (fallback: first discovered project). */
  get index(): ModIndex | null {
    return this.activeIndex();
  }

  /** Active project indexer (fallback: first discovered project). */
  get indexer(): ModIndexer | null {
    return this.activeIndexer();
  }

  /** All discovered project roots (normalized absolute paths). */
  getProjectRoots(): string[] {
    return [...this.states.values()].map((s) => s.root);
  }

  /** Project root for a document, or null when it does not belong to any. */
  getProjectRootFor(document: vscode.TextDocument): string | null {
    return this.stateForDocument(document)?.root ?? null;
  }

  /** Sync index lookup for a document (no lazy build side effects). */
  indexForDocument(document: vscode.TextDocument): ModIndex | null {
    const state = this.stateForDocument(document);
    if (!state) return null;
    this.ensureBuild(state, "feature-request");
    return state.index;
  }

  /** Indexer that owns a file (fallback: active project's indexer). */
  indexerForFile(file: string): ModIndexer | null {
    const key = normKey(file);
    for (const st of this.states.values()) {
      if (st.indexer?.isIndexedFile(file) || st.index?.files.has(key)) {
        return st.indexer;
      }
    }
    return this.activeIndexer();
  }

  /** Index that owns a file (fallback: active project's index). */
  indexForFile(file: string): ModIndex | null {
    const key = normKey(file);
    for (const st of this.states.values()) {
      if (st.indexer?.isIndexedFile(file) || st.index?.files.has(key)) {
        return st.index;
      }
    }
    return this.activeIndex();
  }

  activeIndex(): ModIndex | null {
    return this.activeState()?.index ?? null;
  }

  activeIndexer(): ModIndexer | null {
    return this.activeState()?.indexer ?? null;
  }

  /**
   * Discovers project roots from the current workspace folders and open
   * documents, registers per-project state and starts the initial build(s):
   * a single discovered project is indexed immediately (existing UX), while
   * multiple projects are lazy — only the active editor's project starts.
   */
  async initialize(): Promise<void> {
    this.settings = readSettings();
    this.refreshProjects();
    if (!this.states.size) {
      this.statusBar.hide();
      this.updateContext();
      return;
    }
    const builds: Promise<void>[] = [];
    for (const st of this.states.values()) {
      if (
        !st.index &&
        !st.building &&
        (this.states.size === 1 || this.stateBelongsToActiveEditor(st))
      ) {
        builds.push(this.rebuildFor(st, false, "initial"));
      }
    }
    if (builds.length) {
      await Promise.all(builds);
    } else {
      this.updateStatusBar();
    }
  }

  /** Re-runs discovery after workspace folders changed. */
  onWorkspaceFoldersChanged(): void {
    this.refreshProjects();
    for (const st of this.states.values()) {
      this.maybeBuildInitial(st, "workspace-folders");
    }
  }

  /** Registers the document's project (if any) and starts its lazy build. */
  onDocumentOpened(document: vscode.TextDocument): void {
    if (document.languageId !== "xml") return;
    const root = this.resolveRootForFile(document.uri.fsPath);
    if (root) {
      const state = this.registerRoot(root);
      if (state) this.ensureBuild(state, "doc-open");
    }
  }

  /**
   * Invalidates cached documents for a path (called by the file watcher and
   * on document save), so the next rebuild re-reads it instead of trusting
   * the cached copy. Marks every project's epoch: a shared file may belong
   * to several projects and over-marking is only an extra stale flag.
   */
  invalidate(path: string): void {
    if (!path) return;
    for (const st of this.states.values()) st.epoch.mark();
    this.documentCache.invalidate(path);
    this.recordsCache.invalidate(path);
  }

  /**
   * Called when files are created or deleted: include-resolution results
   * (which encode file existence) and cached root-for-path lookups are no
   * longer trustworthy.
   */
  invalidateExistence(): void {
    for (const st of this.states.values()) st.epoch.mark();
    this.resolveCache.clear();
    this.rootForPathCache.clear();
  }

  /**
   * Watches every project root plus the SDK / extra DATA roots for file
   * changes. Create/delete events invalidate existence and schedule every
   * project; content changes schedule only the projects whose index
   * contains the file.
   */
  private startWatching(): void {
    this.disposeWatchers();
    const roots = new Map<string, string>();
    for (const st of this.states.values()) roots.set(normKey(st.root), st.root);
    if (this.settings.sdkPath) roots.set(normKey(this.settings.sdkPath), this.settings.sdkPath);
    for (const p of this.settings.additionalDataSearchPaths) {
      roots.set(normKey(p), p);
    }
    for (const root of roots.values()) {
      if (!existsSync(root)) continue;
      try {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(root, "**/*"),
        );
        watcher.onDidCreate((uri) => {
          if (isWatcherNoisePath(uri.fsPath)) return;
          this.log(`[watcher-create] ${uri.fsPath}`);
          this.handleWatcherEvent(uri.fsPath, "watcher-create", true);
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
          this.log(`[watcher-change] ${uri.fsPath}`);
          this.handleWatcherEvent(uri.fsPath, "watcher-change", false);
        });
        watcher.onDidDelete((uri) => {
          if (isWatcherNoisePath(uri.fsPath)) return;
          this.log(`[watcher-delete] ${uri.fsPath}`);
          this.handleWatcherEvent(uri.fsPath, "watcher-delete", true);
        });
        this.watchers.push(watcher);
        this.context.subscriptions.push(watcher);
      } catch {
        // The root may be temporarily unavailable (e.g. removable drive);
        // indexing still works, just without watcher-based invalidation.
      }
    }
  }

  private disposeWatchers(): void {
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
  }

  private handleWatcherEvent(
    path: string,
    trigger: string,
    existenceChanged: boolean,
  ): void {
    this.invalidate(path);
    if (existenceChanged) {
      this.invalidateExistence();
      for (const st of this.states.values()) this.scheduleRebuildFor(st, trigger);
      return;
    }
    const key = normKey(path);
    for (const st of this.states.values()) {
      if (st.indexer?.isIndexedFile(path) || st.index?.files.has(key)) {
        this.scheduleRebuildFor(st, trigger);
      }
    }
  }

  /** True when the path is part of any project's index (any build state). */
  private isIndexedPath(fsPath: string): boolean {
    const key = normKey(fsPath);
    for (const st of this.states.values()) {
      if (st.indexer?.isIndexedFile(fsPath)) return true;
      if (st.index?.files.has(key)) return true;
    }
    return false;
  }

  scheduleRebuild(reason = "unknown", document?: vscode.TextDocument): void {
    const state = document ? this.stateForDocument(document) : this.activeState();
    if (!state) return;
    this.scheduleRebuildFor(state, reason);
  }

  /** Schedules a rebuild for every discovered project (settings changes). */
  scheduleRebuildAll(reason = "unknown"): void {
    for (const st of this.states.values()) this.scheduleRebuildFor(st, reason);
  }

  private scheduleRebuildFor(state: ProjectState, reason = "unknown"): void {
    state.pendingTrigger = reason;
    if (state.rebuildTimer) clearTimeout(state.rebuildTimer);
    state.rebuildTimer = setTimeout(() => {
      void this.rebuildFor(state, false, state.pendingTrigger ?? reason);
    }, REBUILD_DEBOUNCE_MS);
  }

  /** Rebuilds a project through the serialized queue (active by default). */
  rebuild(
    force = false,
    trigger = "unknown",
    document?: vscode.TextDocument,
  ): Promise<void> {
    const state = document ? this.stateForDocument(document) : this.activeState();
    if (!state) return Promise.resolve();
    return this.rebuildFor(state, force, trigger);
  }

  private rebuildFor(
    state: ProjectState,
    force: boolean,
    trigger: string,
  ): Promise<void> {
    if (state.building) {
      state.dirty = true;
      return Promise.resolve();
    }
    if (force) this.resolveCache.clear();
    state.building = true;
    state.buildCount++;
    state.lastTrigger = trigger;
    this.onBuildStart?.();
    this.log(
      `[build #${state.buildCount}] project=${state.root} trigger=${trigger} force=${force} start=${new Date().toISOString()}`,
    );
    this.settings = readSettings();
    const epochAtStart = state.epoch.snapshot();
    this.updateStatusBar();
    return this.enqueue(() => this.runBuild(state, force, epochAtStart));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.buildChain.then(task);
    this.buildChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runBuild(
    state: ProjectState,
    force: boolean,
    epochAtStart: number,
  ): Promise<void> {
    const wallStart = Date.now();
    try {
      // Cold start per project: seed the shared records cache from that
      // project's on-disk cache so a fresh session does not re-read
      // unchanged files (Corona: 2.6 GB of art assets). Stat validation is
      // a prerequisite: entries are only trusted after their multi-signal
      // stamp matches the current disk state, otherwise the fast build
      // could publish an index built from stale records.
      const pendingArt = await this.seedRecordsFromDisk(state);
      this.statusBar.text = "$(sync~spin) RA3 XML: indexing…";
      this.statusBar.show();
      const indexer = new ModIndexer({
        projectDir: state.root,
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
      state.indexer = indexer;
      // The XML phase is published as soon as it is ready, so completion /
      // navigation / diagnostics work while the art scan continues.
      const finalIndex = await indexer.build(async (phaseIndex) => {
        this.publishIndex(state, phaseIndex, epochAtStart);
        // Phase A is published and usable; validate the remaining art
        // records before phase B so it can trust the cache instead of
        // re-scanning 2.6 GB of models.
        if (!phaseIndex.complete && pendingArt.length) {
          await this.validateAndSeedCache(state, pendingArt, "art cache");
        }
      });
      this.publishIndex(state, finalIndex, epochAtStart);
      this.log(
        `[build #${state.buildCount}] project=${state.root} done in ${(finalIndex.stats.elapsedMs / 1000).toFixed(1)}s (phase=${finalIndex.phase}, assets=${finalIndex.stats.assetCount}, stale=${finalIndex.stale === true}, walk=${(finalIndex.stats.walkMs / 1000).toFixed(1)}s, candidates=${(finalIndex.stats.candidatesMs / 1000).toFixed(1)}s, art=${(finalIndex.stats.artScanMs / 1000).toFixed(1)}s)`,
      );
      this.saveRecordsToDisk(state);
      this.log(
        `[build #${state.buildCount}] project=${state.root} wall time ${((Date.now() - wallStart) / 1000).toFixed(1)}s (cache load + validation + index build)`,
      );
    } catch (err) {
      if (state.index) {
        // Keep the last good snapshot (marked stale) instead of disabling
        // the extension entirely; a later rebuild can recover.
        state.index.stale = true;
        this.statusBar.text =
          "$(error) RA3 XML: indexing failed (stale index kept)";
        this.statusBar.tooltip = err instanceof Error ? err.message : String(err);
        this.onIndexUpdate?.();
      } else {
        this.statusBar.text = "$(error) RA3 XML: indexing failed";
        this.statusBar.tooltip = err instanceof Error ? err.message : String(err);
      }
    } finally {
      state.building = false;
      // The snapshot was published while `building` was still true, so the
      // status bar still said "indexing". Refresh it now that the build is
      // fully over.
      this.updateStatusBar();
      if (state.dirty) {
        state.dirty = false;
        void this.rebuildFor(state, false, `dirty-followup (${state.lastTrigger})`);
      } else {
        // Build is fully over: refresh diagnostics with full local scopes
        // (the snapshot published while `building` was still true only got
        // cheap parse-only scopes).
        this.onIndexUpdate?.();
      }
    }
  }

  private diskCacheIdentityFor(state: ProjectState): DiskCacheIdentity {
    return {
      projectDir: state.root,
      sdkDir: this.settings.sdkPath,
      indexSageXml: this.settings.indexSageXml,
      additionalDataSearchPaths: this.settings.additionalDataSearchPaths,
      builtmodsDirs: this.settings.builtmodsDirs,
    };
  }

  private diskCachePathFor(identity: DiskCacheIdentity): string | null {
    if (!this.storageDir) return null;
    return join(this.storageDir, `index-records-v3-${diskCacheKey(identity)}.json.gz`);
  }

  /**
   * Loads one project's disk cache. Full-XML records are stat-validated
   * BEFORE the build (phase A depends on them); shallow art records are
   * returned as "pending" and validated in the phase-A callback before
   * phase B starts. Only validated entries are seeded, so the fast build
   * never trusts unverified cache data.
   */
  private async seedRecordsFromDisk(
    state: ProjectState,
  ): Promise<DiskCacheRecord[]> {
    if (state.diskCache) return [];
    const identity = this.diskCacheIdentityFor(state);
    const path = this.diskCachePathFor(identity);
    if (!path) return [];
    const diskCache = new DiskRecordsCache(path, identity);
    state.diskCache = diskCache;
    const { records, stats } = await diskCache.load();
    state.diskCacheStats = stats;
    state.diskSaved = false;
    this.log(
      `[disk-cache] project=${state.root} loaded ${records.length} records in ${(stats.loadMs / 1000).toFixed(1)}s (file=${stats.fileExists}, keyMatched=${stats.keyMatched})`,
    );
    if (!records.length || !stats.keyMatched) return [];

    const full = records.filter((r) => r.kind !== "shallow");
    const shallow = records.filter((r) => r.kind === "shallow");
    if (!full.length) {
      // No XML records to gate phase A on; validate everything up front.
      await this.validateAndSeedCache(state, records, "cache");
      return [];
    }
    await this.validateAndSeedCache(state, full, "cache");
    // Pre-seed shallow records as unvalidated: phase A can register art
    // files without statting 2.6 GB of models, and phase B only consumes
    // them after `validateAndSeedCache` flips them to validated.
    for (const rec of shallow) {
      this.recordsCache.set(rec.key, {
        stat: rec.stat,
        records: rec.records,
        kind: rec.kind,
        contentHash: rec.contentHash,
        validated: false,
      });
    }
    if (shallow.length) {
      this.log(
        `[disk-cache] project=${state.root} pre-seeded ${shallow.length} art records (unvalidated) for deferred registration`,
      );
    }
    return shallow;
  }

  /**
   * Stat-validates a batch of cached records, seeds the matching ones and
   * reports progress through the status bar / output channel. Multiple
   * batches accumulate into `state.diskCacheStats` (e.g. XML first, then
   * art before phase B).
   */
  private async validateAndSeedCache(
    state: ProjectState,
    records: DiskCacheRecord[],
    label: string,
  ): Promise<void> {
    const total = records.length;
    const start = Date.now();
    let lastLogCount = 0;
    const onProgress = (done: number): void => {
      this.statusBar.text = `$(sync~spin) RA3 XML: validating ${label} ${done}/${total}…`;
      this.statusBar.show();
      if (done - lastLogCount >= CACHE_PROGRESS_LOG_EVERY) {
        lastLogCount = done;
        this.log(
          `[disk-cache] project=${state.root} validating ${label} ${done}/${total} in ${((Date.now() - start) / 1000).toFixed(1)}s`,
        );
      }
    };
    try {
      const { stats: validationStats, kept, invalidKeys } =
        await state.diskCache!.validate(records, onProgress);
      state.diskCacheStats = {
        ...state.diskCacheStats,
        validated: state.diskCacheStats.validated + validationStats.validated,
        dropped: state.diskCacheStats.dropped + validationStats.dropped,
        validateMs: state.diskCacheStats.validateMs + validationStats.validateMs,
      };
      for (const rec of kept) {
        this.recordsCache.set(rec.key, {
          stat: rec.stat,
          records: rec.records,
          kind: rec.kind,
          contentHash: rec.contentHash,
          validated: true,
        });
      }
      for (const key of invalidKeys) {
        this.recordsCache.invalidate(key);
      }
      this.log(
        `[disk-cache] project=${state.root} validated ${label} ${validationStats.validated}/${total} records in ${(validationStats.validateMs / 1000).toFixed(1)}s (dropped=${validationStats.dropped})`,
      );
      if (invalidKeys.length) {
        this.log(
          `[disk-cache] project=${state.root} ${invalidKeys.length} ${label} entries out of date; they will be re-read during the build`,
        );
      }
    } catch (err) {
      this.log(
        `[disk-cache] project=${state.root} ${label} validation failed: ${err instanceof Error ? err.message : String(err)}; affected entries will be re-read`,
      );
    }
  }

  /** Persists a project's records after a successful build (best-effort). */
  private saveRecordsToDisk(state: ProjectState): void {
    if (!state.diskCache) return;
    // Snapshot the entries now: the save runs in the background while the
    // next rebuild may already be mutating the live cache.
    const entries = [...this.recordsCache.entries()];
    const prev = state.saving ?? Promise.resolve();
    const start = Date.now();
    state.saving = prev
      .then(async () => {
        await state.diskCache!.save(entries);
        state.diskSaved = true;
        this.log(
          `[disk-cache] project=${state.root} saved ${entries.length} records in ${(Date.now() - start) / 1000}s`,
        );
      })
      .catch(() => {
        // Disk persistence is best-effort; the in-memory cache still works.
      });
  }

  /**
   * Clears every cache (in-memory + disk + directory walker) and starts
   * forced rebuilds for every project (serialized by the build queue).
   */
  clearCaches(): void {
    this.localScopes.clear();
    this.rootForPathCache.clear();
    this.documentCache.clear();
    this.recordsCache.clear();
    this.resolveCache.clear();
    this.walker.clear();
    for (const st of this.states.values()) {
      st.diskCacheStats = emptyDiskCacheStats();
      st.diskSaved = false;
      void st.diskCache?.clear();
      void this.rebuildFor(st, true, "clear-cache");
    }
  }

  /** Human-readable cache status for the `ra3modxml.showCacheReport` command. */
  async cacheReport(): Promise<string> {
    const lines: string[] = ["RA3 Mod XML cache report"];
    lines.push(`Projects: ${this.states.size}`);
    for (const st of this.states.values()) {
      lines.push(`Project: ${st.root}`);
      lines.push(`  builds: #${st.buildCount} (last trigger: ${st.lastTrigger})`);
      lines.push(`  disk cache: ${st.diskCache?.path ?? "not loaded"}`);
      if (st.diskCache) {
        const status = await st.diskCache.status();
        lines.push(
          `    file: ${status?.exists ? `${(status.sizeBytes / 1024).toFixed(1)} KB` : "missing"}`,
        );
        lines.push(
          `    last load: file=${st.diskCacheStats.fileExists} keyMatched=${st.diskCacheStats.keyMatched} loaded=${st.diskCacheStats.loaded} validated=${st.diskCacheStats.validated} dropped=${st.diskCacheStats.dropped} (load ${st.diskCacheStats.loadMs}ms, validate ${st.diskCacheStats.validateMs}ms)`,
        );
        lines.push(`    saved after last build: ${st.diskSaved}`);
      }
      if (st.index) {
        const s = st.index.stats;
        lines.push(
          `    last build: phase=${s.phase} assets=${s.assetCount} snapshotHits=${s.snapshotHits} snapshotFallbacks=${s.snapshotFallbacks} recordsCacheHits=${s.recordsCacheHits} shallowCacheHits=${s.shallowCacheHits}`,
        );
      }
    }
    lines.push(
      `Shared in-memory: ${this.recordsCache.size} record entries · ${this.documentCache.size} documents (${this.documentCache.elements} elements) · ${this.resolveCache.size} include resolutions`,
    );
    return lines.join("\n");
  }

  /**
   * Publishes an index snapshot (intermediate phase or final) for one
   * project. If files changed while the snapshot was built, it is marked
   * stale; the dirty/rebuild mechanism converges shortly after.
   */
  private publishIndex(
    state: ProjectState,
    index: ModIndex,
    epochAtStart: number,
  ): void {
    if (state.epoch.changedSince(epochAtStart)) index.stale = true;
    state.index = index;
    this.indexEpochValue++;
    // The merged index attached to a document scope changes with every
    // published snapshot, so cached scopes are rebuilt lazily on next use.
    this.localScopes.clear();
    this.updateStatusBar();
    this.onIndexUpdate?.();
    if (!index.complete) {
      this.log(
        `[build #${state.buildCount}] project=${state.root} phase A published in ${(index.stats.elapsedMs / 1000).toFixed(1)}s (${index.stats.assetCount} assets, ${index.stats.deferredArtFiles} art files pending)`,
      );
    }
  }

  private updateStatusBar(): void {
    if (!this.states.size) {
      this.statusBar.hide();
      return;
    }
    const building = [...this.states.values()].find((s) => s.building);
    if (building) {
      this.statusBar.text = "$(sync~spin) RA3 XML: indexing…";
      this.statusBar.show();
      return;
    }
    const st = this.activeState();
    const idx = st?.index;
    if (!idx || !st) {
      this.statusBar.text = `$(symbol-misc) RA3 XML: ${this.states.size} project(s) — open a mod XML to index`;
      this.statusBar.tooltip = [...this.states.values()]
        .map((s) => s.root)
        .join("\n");
      this.statusBar.show();
      return;
    }
    const s = idx.stats;
    const stale = idx.stale ? " (stale)" : "";
    this.statusBar.text = `$(symbol-misc) RA3 XML: ${basename(st.root)} · ${formatCount(s.assetCount)} assets${stale}`;
    this.statusBar.tooltip =
      `${st.root}\n` +
      `${s.indexedFiles} files indexed (${s.parsedFiles} parsed, ${s.shallowScannedFiles} art assets shallow-scanned, ${(s.elapsedMs / 1000).toFixed(1)}s)\n` +
      `${s.assetCount} assets (${s.manifestAssetCount} from ${s.manifestFiles} manifests)\n` +
      `${s.referenceCount} reference sites\n` +
      `${s.defineCount} defines, ${s.streams} streams, ${s.sourceCandidates} include candidates\n` +
      `Phase: ${s.phase} · Complete: ${s.complete}${stale}\n` +
      `Disk cache: load ${(st.diskCacheStats.loadMs / 1000).toFixed(1)}s, validate ${(st.diskCacheStats.validateMs / 1000).toFixed(1)}s (${st.diskCacheStats.validated}/${st.diskCacheStats.loaded} ok)`;
    this.statusBar.show();
  }

  /**
   * Search paths derived from the current settings for a document's project
   * (active project when no document is given), usable even before the
   * first index snapshot exists (include links / hover / diagnostics).
   */
  searchPaths(document?: vscode.TextDocument): SearchPaths | null {
    const state = document ? this.stateForDocument(document) : this.activeState();
    if (!state) return null;
    return buildSearchPaths(this.settings.sdkPath, state.root);
  }

  /**
   * Returns the document scope for the current text: original parse,
   * expanded logical tree, local overlay and overlay-aware merged index.
   * Cached by URI + document version + global index epoch. Lazy projects
   * are registered and their build started on first request.
   */
  async getScope(document: vscode.TextDocument): Promise<DocumentScope> {
    const state = this.stateForDocument(document);
    if (!state) throw new Error("RA3 workspace root is not available");
    this.ensureBuild(state, "doc-request");
    const key = document.uri.toString();
    const cached = this.localScopes.get(key);
    if (
      cached &&
      cached.version === document.version &&
      cached.indexEpoch === this.indexEpochValue
    ) {
      return cached.scope;
    }
    // While this project's rebuild is running, avoid competing with the
    // indexer for disk I/O: serve a parse-only scope (current file + XSD
    // context, no include chain / logical expansion). The published
    // snapshot clears this cache, so the next provider call after the build
    // gets the full local scope.
    if (state.building) {
      return this.buildCheapScope(document, state);
    }
    const pending = this.localScopeBuilds.get(key);
    if (pending) return pending;
    const versionAtStart = document.version;
    const promise = this.buildScope(document, state)
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
   * Returns the global index with this document's local overlay attached,
   * or a minimal local-only index while the global index is still building.
   */
  async getIndex(document: vscode.TextDocument): Promise<ModIndex | null> {
    if (!this.isRa3Workspace()) return null;
    return (await this.getScope(document)).merged;
  }

  /**
   * Lightweight scope for CodeLens: parses only the current document and
   * attaches the current global index. Unlike `getScope` it never follows
   * the include chain or expands the logical tree, so refreshing counts
   * after a snapshot is fast. CodeLens only renders top-level assets of the
   * current document, which the cheap overlay already covers.
   */
  async getCodeLensScope(document: vscode.TextDocument): Promise<DocumentScope> {
    const state = this.stateForDocument(document);
    if (!state) throw new Error("RA3 workspace root is not available");
    this.ensureBuild(state, "doc-request");
    return this.buildCheapScope(document, state);
  }

  private async buildScope(
    document: vscode.TextDocument,
    state: ProjectState,
  ): Promise<DocumentScope> {
    const searchPaths =
      this.searchPaths(document) ?? buildSearchPaths(this.settings.sdkPath, state.root);
    const readRecords = async (path: string): Promise<ParsedFile | null> =>
      state.indexer ? state.indexer.readDocument(path) : this.fallbackRead(path);
    const readDom = async (path: string): Promise<ParsedFile | null> =>
      state.indexer ? state.indexer.readDom(path) : this.fallbackRead(path);
    const scope = await buildDocumentScope(
      document.uri.fsPath,
      document.getText(),
      document.version,
      {
        projectDir: state.root,
        sdkDir: this.settings.sdkPath,
        searchPaths,
        readRecords,
        readDom,
      },
    );
    scope.merged = withLocalOverlay(
      state.index,
      scope.overlay,
      state.root,
      this.settings.sdkPath,
    );
    return scope;
  }

  private async buildCheapScope(
    document: vscode.TextDocument,
    state: ProjectState,
  ): Promise<DocumentScope> {
    const searchPaths =
      this.searchPaths(document) ?? buildSearchPaths(this.settings.sdkPath, state.root);
    const scope = await buildDocumentScope(
      document.uri.fsPath,
      document.getText(),
      document.version,
      {
        projectDir: state.root,
        sdkDir: this.settings.sdkPath,
        searchPaths,
        readRecords: async () => null,
        readDom: async () => null,
      },
    );
    scope.merged = withLocalOverlay(
      state.index,
      scope.overlay,
      state.root,
      this.settings.sdkPath,
    );
    return scope;
  }

  /**
   * Fallback used before a project's first ModIndexer exists: parses an XML
   * file directly so the document-local scope can still follow small
   * include chains.
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
        records: extractIndexRecords(parse, lineMap, text),
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

  /**
   * Minimal workspace surface for the records-desync self-heal, routed to
   * the document's own project (not the active one).
   */
  recordsSyncSurfaceFor(document: vscode.TextDocument): RecordsSyncWorkspace {
    const state = this.stateForDocument(document);
    return {
      get index() {
        return state?.index ?? null;
      },
      invalidate: (path: string) => this.invalidate(path),
      scheduleRebuild: (reason: string) => {
        if (state) this.scheduleRebuildFor(state, reason);
      },
    };
  }

  // ── Discovery / project state ─────────────────────────────────────

  /**
   * Recomputes the desired project set from workspace folders + open XML
   * documents, drops states that are no longer reachable, registers new
   * ones and refreshes watchers / context / status bar.
   */
  private refreshProjects(): void {
    const desired = new Map<string, string>();
    const addRoot = (root: string | null | undefined): void => {
      if (root) desired.set(normKey(root), root);
    };
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      addRoot(findProjectRootUpward(folder.uri.fsPath));
      for (const root of discoverProjects(folder.uri.fsPath)) addRoot(root);
    }
    for (const doc of vscode.workspace.textDocuments ?? []) {
      if (doc.languageId === "xml") addRoot(findProjectRootForFile(doc.uri.fsPath));
    }
    const active = vscode.window.activeTextEditor;
    if (active?.document.languageId === "xml") {
      addRoot(findProjectRootForFile(active.document.uri.fsPath));
    }
    for (const [key, st] of [...this.states]) {
      if (!desired.has(key)) this.removeState(st);
    }
    for (const root of desired.values()) this.registerRoot(root);
    this.rootForPathCache.clear();
    this.startWatching();
    this.updateContext();
    this.updateStatusBar();
  }

  private maybeBuildInitial(state: ProjectState, trigger: string): void {
    if (state.index || state.building) return;
    if (this.states.size === 1 || this.stateBelongsToActiveEditor(state)) {
      void this.rebuildFor(state, false, trigger);
    }
  }

  private removeState(state: ProjectState): void {
    if (state.rebuildTimer) clearTimeout(state.rebuildTimer);
    this.states.delete(normKey(state.root));
  }

  private registerRoot(root: string): ProjectState | null {
    const key = normKey(root);
    const existing = this.states.get(key);
    if (existing) return existing;
    const state: ProjectState = {
      root: resolve(root),
      index: null,
      indexer: null,
      building: false,
      dirty: false,
      buildCount: 0,
      lastTrigger: "registered",
      pendingTrigger: null,
      rebuildTimer: null,
      epoch: new InvalidationsEpoch(),
      diskCache: null,
      diskCacheStats: emptyDiskCacheStats(),
      diskSaved: false,
      saving: null,
    };
    this.states.set(key, state);
    this.startWatching();
    this.updateContext();
    this.updateStatusBar();
    return state;
  }

  private ensureBuild(state: ProjectState, trigger: string): void {
    if (state.index || state.building) return;
    void this.rebuildFor(state, false, trigger);
  }

  private stateBelongsToActiveEditor(state: ProjectState): boolean {
    const editor = vscode.window.activeTextEditor;
    return editor ? isPathInside(editor.document.uri.fsPath, state.root) : false;
  }

  /**
   * The project state for a document: its own nearest root when it belongs
   * to a project (registering it on demand), otherwise the first discovered
   * project (best-effort fallback, matching the old single-project behavior).
   */
  private stateForDocument(document: vscode.TextDocument): ProjectState | null {
    const file = document.uri.fsPath;
    if (file && (document.uri.scheme == null || document.uri.scheme === "file")) {
      const root = this.resolveRootForFile(file);
      if (root) {
        const state = this.registerRoot(root);
        if (state) return state;
      }
    }
    return this.states.values().next().value ?? null;
  }

  /** Active editor's project, falling back to the first discovered one. */
  private activeState(): ProjectState | null {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const state = this.stateForDocument(editor.document);
      if (state) return state;
    }
    return this.states.values().next().value ?? null;
  }

  /**
   * Resolves a file's project root: cached containment in registered roots
   * first (no fs), then upward discovery. The cache is cleared when files
   * are created/deleted or workspace folders change.
   */
  private resolveRootForFile(file: string): string | null {
    if (!file) return null;
    const key = normKey(file);
    const cached = this.rootForPathCache.get(key);
    if (cached !== undefined) return cached;
    for (const st of this.states.values()) {
      if (isPathInside(file, st.root)) {
        this.rootForPathCache.set(key, st.root);
        return st.root;
      }
    }
    const root = findProjectRootForFile(file);
    this.rootForPathCache.set(key, root);
    return root;
  }

  private updateContext(): void {
    void vscode.commands.executeCommand(
      "setContext",
      "ra3modxml.active",
      this.states.size > 0,
    );
  }

  dispose(): void {
    for (const st of this.states.values()) {
      if (st.rebuildTimer) clearTimeout(st.rebuildTimer);
    }
    this.disposeWatchers();
    this.statusBar.dispose();
    this.output.dispose();
  }
}

function isPathInside(file: string, root: string): boolean {
  const f = normKey(file);
  const r = normKey(root);
  return f === r || f.startsWith(r + "\\");
}

function formatCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
