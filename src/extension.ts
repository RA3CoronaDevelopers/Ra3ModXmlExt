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
      new Ra3ReferenceProvider(),
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
      new Ra3DocumentSymbolProvider(),
    ),
  );
  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      XML_SELECTOR,
      new Ra3SemanticTokensProvider(),
      RA3_SEMANTIC_TOKENS_LEGEND,
    ),
  );

  const diagnostics = new Ra3Diagnostics(ws);
  context.subscriptions.push(diagnostics);

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
      ws.scheduleRebuild();
      void diagnostics.update(doc);
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ra3modxml")) ws.scheduleRebuild();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ra3modxml.reindex", () => ws.rebuild()),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("ra3modxml.openIndexReport", () => {
      const idx = ws.index;
      if (!idx) {
        void vscode.window.showInformationMessage(
          "RA3 Mod XML: no index available. Open a workspace that contains Data/Mod.xml.",
        );
        return;
      }
      const s = idx.stats;
      void vscode.window.showInformationMessage(
        `RA3 Mod XML index\n` +
          `Project: ${s.projectDir}\n` +
          `Files: ${s.indexedFiles} (${s.parsedFiles} parsed)\n` +
          `Assets: ${s.assetCount} (${s.manifestAssetCount} from ${s.manifestFiles} manifests)\n` +
          `Defines: ${s.defineCount} · Streams: ${s.streams} · Candidates: ${s.sourceCandidates}\n` +
          `Indexed in ${(s.elapsedMs / 1000).toFixed(1)}s`,
        { modal: false },
      );
    }),
  );

  void ws.initialize();
}

export function deactivate(): void {
  // All subscriptions are disposed by VS Code.
}
