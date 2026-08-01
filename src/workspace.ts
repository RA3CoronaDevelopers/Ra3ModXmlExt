import * as vscode from "vscode";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { CachedDirectoryWalker } from "./indexer/fileScanner";
import { ModIndexer } from "./indexer/indexer";
import type { ModIndex } from "./indexer/types";
import { readSettings, type ExtensionSettings } from "./settings";

const REBUILD_DEBOUNCE_MS = 1500;

export class ModWorkspace {
  index: ModIndex | null = null;
  indexer: ModIndexer | null = null;
  projectRoot: string | null = null;
  settings: ExtensionSettings;

  private walker = new CachedDirectoryWalker();
  private statusBar: vscode.StatusBarItem;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private building = false;
  private dirty = false;

  constructor(context: vscode.ExtensionContext) {
    this.settings = readSettings();
    this.statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.statusBar.name = "RA3 Mod XML";
    this.statusBar.command = "ra3modxml.openIndexReport";
    context.subscriptions.push(this.statusBar);
  }

  isRa3Workspace(): boolean {
    return this.projectRoot != null;
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
    this.statusBar.text = "$(sync~spin) RA3 XML: indexing…";
    this.statusBar.show();
    await this.rebuild();
  }

  scheduleRebuild(): void {
    if (!this.projectRoot) return;
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => {
      void this.rebuild();
    }, REBUILD_DEBOUNCE_MS);
  }

  async rebuild(): Promise<void> {
    if (!this.projectRoot) return;
    if (this.building) {
      this.dirty = true;
      return;
    }
    this.building = true;
    this.settings = readSettings();
    try {
      this.statusBar.text = "$(sync~spin) RA3 XML: indexing…";
      const indexer = new ModIndexer({
        projectDir: this.projectRoot,
        sdkDir: this.settings.sdkPath,
        builtmodsDirs: this.settings.builtmodsDirs,
        indexSageXml: this.settings.indexSageXml,
        additionalDataSearchPaths: this.settings.additionalDataSearchPaths,
        walker: this.walker,
      });
      const started = Date.now();
      this.index = await indexer.build();
      this.indexer = indexer;
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const s = this.index.stats;
      this.statusBar.text = `$(symbol-misc) RA3 XML: ${formatCount(s.assetCount)} assets`;
      this.statusBar.tooltip =
        `${s.projectDir}\n` +
        `${s.indexedFiles} files indexed (${secs}s)\n` +
        `${s.assetCount} assets (${s.manifestAssetCount} from ${s.manifestFiles} manifests)\n` +
        `${s.defineCount} defines, ${s.streams} streams, ${s.sourceCandidates} include candidates`;
    } catch (err) {
      this.index = null;
      this.statusBar.text = "$(error) RA3 XML: indexing failed";
      this.statusBar.tooltip = err instanceof Error ? err.message : String(err);
    } finally {
      this.building = false;
      if (this.dirty) {
        this.dirty = false;
        void this.rebuild();
      }
    }
  }

  /** Parses the (possibly unsaved) in-memory text of the active document. */
  async parseText(path: string, text: string) {
    const { parseXml, LineMap } = await import("./language/xmlParser");
    const parse = parseXml(text);
    return {
      file: { path, stat: null },
      parse,
      lineMap: new LineMap(text),
    };
  }

  dispose(): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.statusBar.dispose();
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
