import * as vscode from "vscode";
import { LineMap, parseXml } from "../language/xmlParser";
import { resolveElementType } from "../language/typeContext";
import { isReferenceTargetType } from "../indexer/refs";
import {
  referenceSitesForDefinition,
  scheduleRebuildIfRecordsDesync,
} from "../indexer/referenceIndex";
import type { ShowReferencesArgs } from "./references";
import type { ModWorkspace } from "../workspace";

/** Never build a DOM for huge files just to show counts (w3x safety). */
const MAX_CODELENS_TEXT = 4 * 1024 * 1024;

/**
 * CodeLens reference counts on top-level assets.
 *
 * Only types that are reference targets by design get a lens (settings, map
 * metadata, w3x sub-assets etc. would otherwise show a permanent, misleading
 * "0 references"). Zero is still shown for the meaningful types: that is the
 * signal users can click to inspect an unused asset.
 */
export class Ra3CodeLensProvider implements vscode.CodeLensProvider {
  constructor(private ws: ModWorkspace) {}

  provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): vscode.CodeLens[] {
    if (!this.ws.isRa3Workspace()) return [];
    const idx = this.ws.index;
    if (!idx) return [];
    const text = document.getText();
    if (text.length > MAX_CODELENS_TEXT) return [];
    scheduleRebuildIfRecordsDesync(this.ws, document);
    const doc = parseXml(text);
    const root = doc.root;
    if (!root) return [];
    const lineMap = new LineMap(text);
    const lenses: vscode.CodeLens[] = [];

    for (const child of root.children) {
      const local = localName(child.name);
      if (local === "Tags" || local === "Includes" || local === "Defines") continue;
      const idAttr = child.attrs.find((a) => a.name === "id");
      if (!idAttr?.hasValue) continue;
      const elType = resolveElementType(child);
      if (!isReferenceTargetType(elType)) continue;

      const id = idAttr.value;
      const line = lineMap.positionAt(idAttr.valueStart).line + 1;
      const count = referenceSitesForDefinition(idx, {
        type: local,
        id,
        file: document.uri.fsPath,
        line,
      }).length;
      const range = new vscode.Range(
        document.positionAt(child.start),
        document.positionAt(child.startTagEnd),
      );
      const args: ShowReferencesArgs = {
        uri: document.uri,
        position: document.positionAt(idAttr.valueStart),
        id,
        type: local,
        file: document.uri.fsPath,
        line,
      };
      lenses.push(
        new vscode.CodeLens(range, {
          title:
            count === 0
              ? "0 references"
              : count === 1
                ? "1 reference"
                : `${count} references`,
          command: "ra3modxml.showReferences",
          arguments: [args],
        }),
      );
    }
    return lenses;
  }
}

function localName(tag: string): string {
  const idx = tag.lastIndexOf(":");
  return idx >= 0 ? tag.slice(idx + 1) : tag;
}
