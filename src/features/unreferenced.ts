import * as vscode from "vscode";
import { relative } from "node:path";
import { findElementAt, parseXml } from "../language/xmlParser";
import { unreferencedByType } from "../indexer/referenceIndex";
import type { ModWorkspace } from "../workspace";

interface TypePickItem extends vscode.QuickPickItem {
  type: string;
}

interface AssetPickItem extends vscode.QuickPickItem {
  file: string;
  line: number;
}

/**
 * Palette command: pick an asset type, then jump to any project asset of
 * that type that has zero incoming references. Only types that are reference
 * targets by design are offered, so auto-registered data (settings, map
 * metadata, w3x sub-assets...) is not reported as "unused".
 */
export async function findUnreferencedAssets(
  ws: ModWorkspace,
  args?: { type?: string },
): Promise<void> {
  if (!ws.isRa3Workspace() || !ws.index) {
    void vscode.window.showInformationMessage(
      "RA3 Mod XML: no index available yet.",
    );
    return;
  }
  const idx = ws.index;
  const byType = unreferencedByType(idx);

  let type = args?.type;
  if (!type) {
    if (!byType.size) {
      void vscode.window.showInformationMessage(
        "RA3 Mod XML: no unreferenced assets found.",
      );
      return;
    }
    const pickedType = await vscode.window.showQuickPick<TypePickItem>(
      [...byType.entries()].map(([t, defs]) => ({
        label: t,
        description: `${defs.length} unreferenced`,
        type: t,
      })),
      {
        placeHolder: "Select an asset type",
        matchOnDescription: true,
      },
    );
    if (!pickedType) return;
    type = pickedType.type;
  }

  const defs = byType.get(type) ?? [];
  if (!defs.length) {
    void vscode.window.showInformationMessage(
      `RA3 Mod XML: no unreferenced ${type} assets found.`,
    );
    return;
  }
  const pickedAsset = await vscode.window.showQuickPick<AssetPickItem>(
    defs.map((d) => ({
      label: d.id,
      description: `${displayPath(idx.projectDir, d.file)}:${d.line}`,
      file: d.file,
      line: d.line,
    })),
    {
      placeHolder: `${type}: ${defs.length} unreferenced`,
      matchOnDescription: true,
    },
  );
  if (!pickedAsset) return;

  const uri = vscode.Uri.file(pickedAsset.file);
  const document = await vscode.workspace.openTextDocument(uri);
  const line = Math.max(0, pickedAsset.line - 1);
  await vscode.window.showTextDocument(document, {
    selection: new vscode.Range(
      new vscode.Position(line, 0),
      new vscode.Position(line, 1),
    ),
    preview: true,
  });
}

/**
 * Editor context-menu entry: pre-selects the asset type under the cursor.
 * Falls back to the type picker when the cursor is not on a top-level asset.
 */
export async function findUnreferencedAssetsOfType(
  ws: ModWorkspace,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor && ws.isRa3Workspace()) {
    const document = editor.document;
    const offset = document.offsetAt(editor.selection.active);
    const doc = parseXml(document.getText());
    const el = findElementAt(doc, offset);
    if (el && el.parent === doc.root) {
      const local = localName(el.name);
      const isStructural = local === "Tags" || local === "Includes" || local === "Defines";
      const hasId = el.attrs.some((a) => a.name === "id" && a.hasValue);
      if (!isStructural && hasId) {
        return findUnreferencedAssets(ws, { type: local });
      }
    }
  }
  return findUnreferencedAssets(ws);
}

function localName(tag: string): string {
  const idx = tag.lastIndexOf(":");
  return idx >= 0 ? tag.slice(idx + 1) : tag;
}

function displayPath(projectDir: string, file: string): string {
  const rel = relative(projectDir, file);
  return rel && !rel.startsWith("..") ? rel : file;
}
