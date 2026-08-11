import * as vscode from "vscode";
import { ModWorkspace } from "./workspace";
import { SdkSetup } from "./sdkSetup";
import { Ra3CompletionProvider } from "./features/completion";
import { Ra3HoverProvider } from "./features/hover";
import {
  Ra3DefinitionProvider,
  Ra3DocumentLinkProvider,
  Ra3DocumentSymbolProvider,
  Ra3ReferenceProvider,
} from "./features/navigation";
import { Ra3CodeLensProvider } from "./features/codeLens";
import { showReferencesForDef } from "./features/references";
import {
  findUnreferencedAssets,
  findUnreferencedAssetsOfType,
} from "./features/unreferenced";
import { Ra3Diagnostics } from "./features/diagnostics";
import {
  Ra3SemanticTokensProvider,
  RA3_SEMANTIC_TOKENS_LEGEND,
} from "./features/semanticTokens";

const XML_SELECTOR: vscode.DocumentSelector = [{ language: "xml" }];
/** Safety-net refresh interval while a rebuild is running. */
const CODELENS_RETRY_INTERVAL_MS = 2000;

export function activate(context: vscode.ExtensionContext): void {
  const ws = new ModWorkspace(context);
  const sdkSetup = new SdkSetup(context, () => ws);
  context.subscriptions.push(ws);

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      XML_SELECTOR,
      new Ra3CompletionProvider(ws),
      "<",
      '"',
      "=",
      ":",
      ".",
      "/",
      " ",
    ),
  );
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(XML_SELECTOR, new Ra3HoverProvider(ws)),
  );
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      XML_SELECTOR,
      new Ra3DefinitionProvider(ws),
    ),
  );
  context.subscriptions.push(
    vscode.languages.registerReferenceProvider(
      XML_SELECTOR,
      new Ra3ReferenceProvider(ws),
    ),
  );
  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider(
      XML_SELECTOR,
      new Ra3DocumentLinkProvider(ws),
    ),
  );
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(
      XML_SELECTOR,
      new Ra3DocumentSymbolProvider(ws),
    ),
  );
  const codeLensProvider = new Ra3CodeLensProvider(ws);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(XML_SELECTOR, codeLensProvider),
  );
  // Safety net: while a rebuild is running, re-fire the CodeLens refresh
  // every 2s. VS Code sometimes coalesces/skips a single refresh event, so
  // the phase-A snapshot may not repaint until the final one; periodic
  // refreshes (bounded by the build duration) make the early counts appear.
  let codeLensRetryTimer: ReturnType<typeof setInterval> | null = null;
  const startCodeLensRetry = (): void => {
    if (codeLensRetryTimer) return;
    codeLensRetryTimer = setInterval(() => {
      if (!ws.isBuilding) {
        if (codeLensRetryTimer) {
          clearInterval(codeLensRetryTimer);
          codeLensRetryTimer = null;
          ws.log("[codelens] retry stopped (build finished)");
        }
        return;
      }
      codeLensProvider.refresh();
    }, CODELENS_RETRY_INTERVAL_MS);
    ws.log("[codelens] retry started");
  };
  ws.onBuildStart = startCodeLensRetry;
  context.subscriptions.push({
    dispose: () => {
      if (codeLensRetryTimer) clearInterval(codeLensRetryTimer);
    },
  });
  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      XML_SELECTOR,
      new Ra3SemanticTokensProvider(ws),
      RA3_SEMANTIC_TOKENS_LEGEND,
    ),
  );

  const diagnostics = new Ra3Diagnostics(ws);
  context.subscriptions.push(diagnostics);
  // Refresh diagnostics for every open XML document whenever a new index
  // snapshot is published (XML phase, art phase, stale/final rebuild).
  ws.onIndexUpdate = () => {
    codeLensProvider.resetSuppressionLog();
    codeLensProvider.refresh();
    void vscode.commands.executeCommand("editor.action.codeLens.refresh");
    const idx = ws.activeIndex();
    if (idx) {
      ws.log(
        `[codelens] refresh (project=${idx.stats.projectDir}, phase=${idx.phase}, assets=${idx.stats.assetCount}, complete=${idx.complete}, stale=${idx.stale === true})`,
      );
    }
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.languageId === "xml") void diagnostics.update(doc);
    }
  };

  const diagnosticTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const scheduleDiagnostics = (doc: vscode.TextDocument) => {
    if (doc.languageId !== "xml") return;
    const key = doc.uri.toString();
    const existing = diagnosticTimers.get(key);
    if (existing) clearTimeout(existing);
    diagnosticTimers.set(
      key,
      setTimeout(() => {
        diagnosticTimers.delete(key);
        void diagnostics.update(doc);
      }, 500),
    );
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      scheduleDiagnostics(e.document);
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.languageId === "xml") {
        ws.onDocumentOpened(doc);
        void sdkSetup.evaluate(ws);
        void diagnostics.update(doc);
      }
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      ws.onWorkspaceFoldersChanged();
      void sdkSetup.evaluate(ws);
    }),
  );
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document.languageId === "xml") void diagnostics.update(editor.document);
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      diagnostics.clear(doc.uri);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId !== "xml") return;
      ws.invalidate(doc.uri.fsPath);
      ws.scheduleRebuild("save", doc);
      void diagnostics.update(doc);
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ra3modxml")) {
        // Search paths / builtmods locations may have changed: cached include
        // resolutions and manifest lookups are no longer valid.
        ws.invalidateExistence();
        ws.scheduleRebuildAll("config");
        void sdkSetup.evaluate(ws);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ra3modxml.reindex",
      () => void ws.rebuild(true, "reindex-command"),
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("ra3modxml.clearCache", () => {
      ws.clearCaches();
      void vscode.window.showInformationMessage(
        "RA3 Mod XML: caches cleared; rebuilding from scratch…",
      );
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("ra3modxml.showCacheReport", async () => {
      void vscode.window.showInformationMessage(await ws.cacheReport(), {
        modal: false,
      });
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("ra3modxml.openIndexReport", () => {
      const idx = ws.activeIndex();
      if (!idx) {
        if (ws.isBuilding) {
          void vscode.window.showInformationMessage(
            "RA3 Mod XML: index is still building — check the status bar. " +
              "Most features become available after the XML phase.",
          );
          return;
        }
        if (ws.getProjectRoots().length) {
          void vscode.window.showInformationMessage(
            "RA3 Mod XML: no index for the active project yet — open a mod XML document to start indexing.",
          );
          return;
        }
        void vscode.window.showInformationMessage(
          "RA3 Mod XML: no index available. Open a workspace that contains Data/Mod.xml, Data/additionalmaps/mapmetadata_*.xml or a mod folder.",
        );
        return;
      }
      const s = idx.stats;
      const stale = idx.stale ? " (stale)" : "";
      void vscode.window.showInformationMessage(
        `RA3 Mod XML index\n` +
          `Project: ${s.projectDir}\n` +
          `Files: ${s.indexedFiles} (${s.parsedFiles} parsed, ${s.shallowScannedFiles} shallow-scanned, ${s.shallowCacheHits + s.recordsCacheHits} cache hits)\n` +
          `Assets: ${s.assetCount} (${s.manifestAssetCount} from ${s.manifestFiles} manifests)\n` +
          `References: ${s.referenceCount}\n` +
          `Defines: ${s.defineCount} · Streams: ${s.streams} · Candidates: ${s.sourceCandidates}\n` +
          `Phase: ${s.phase} · Complete: ${s.complete}${stale}\n` +
          `Build #${ws.buildCount} (trigger: ${ws.lastTrigger})\n` +
          `Indexed in ${(s.elapsedMs / 1000).toFixed(1)}s\n` +
          `XML walk: ${(s.walkMs / 1000).toFixed(1)}s · Candidates: ${(s.candidatesMs / 1000).toFixed(1)}s · Art scan: ${(s.artScanMs / 1000).toFixed(1)}s`,
        { modal: false },
      );
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ra3modxml.showReferences",
      (args: Parameters<typeof showReferencesForDef>[1]) =>
        void showReferencesForDef(ws, args),
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ra3modxml.findUnreferencedAssets",
      () => void findUnreferencedAssets(ws),
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ra3modxml.findUnreferencedAssetsOfType",
      () => void findUnreferencedAssetsOfType(ws),
    ),
  );

  void sdkSetup.evaluate(ws);
  void ws.initialize().then(() => void sdkSetup.evaluate(ws));
}

export function deactivate(): void {
  // All subscriptions are disposed by VS Code.
}
