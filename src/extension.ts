import * as vscode from "vscode";
import { ModWorkspace } from "./workspace";
import { Ra3CompletionProvider } from "./features/completion";
import { Ra3HoverProvider } from "./features/hover";
import {
  Ra3DefinitionProvider,
  Ra3DocumentLinkProvider,
  Ra3DocumentSymbolProvider,
  Ra3ReferenceProvider,
} from "./features/navigation";
import { Ra3Diagnostics } from "./features/diagnostics";
import {
  Ra3SemanticTokensProvider,
  RA3_SEMANTIC_TOKENS_LEGEND,
} from "./features/semanticTokens";

const XML_SELECTOR: vscode.DocumentSelector = [{ language: "xml" }];

export function activate(context: vscode.ExtensionContext): void {
  const ws = new ModWorkspace(context);
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
      if (doc.languageId === "xml") void diagnostics.update(doc);
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
      ws.scheduleRebuild("save");
      void diagnostics.update(doc);
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ra3modxml")) {
        // Search paths / builtmods locations may have changed: cached include
        // resolutions and manifest lookups are no longer valid.
        ws.invalidateExistence();
        ws.scheduleRebuild("config");
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
      const idx = ws.index;
      if (!idx) {
        if (ws.isBuilding) {
          void vscode.window.showInformationMessage(
            "RA3 Mod XML: index is still building — check the status bar. " +
              "Most features become available after the XML phase.",
          );
          return;
        }
        void vscode.window.showInformationMessage(
          "RA3 Mod XML: no index available. Open a workspace that contains Data/Mod.xml.",
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
          `Defines: ${s.defineCount} · Streams: ${s.streams} · Candidates: ${s.sourceCandidates}\n` +
          `Phase: ${s.phase} · Complete: ${s.complete}${stale}\n` +
          `Build #${ws.buildCount} (trigger: ${ws.lastTrigger})\n` +
          `Indexed in ${(s.elapsedMs / 1000).toFixed(1)}s\n` +
          `XML walk: ${(s.walkMs / 1000).toFixed(1)}s · Candidates: ${(s.candidatesMs / 1000).toFixed(1)}s · Art scan: ${(s.artScanMs / 1000).toFixed(1)}s`,
        { modal: false },
      );
    }),
  );

  void ws.initialize();
}

export function deactivate(): void {
  // All subscriptions are disposed by VS Code.
}
