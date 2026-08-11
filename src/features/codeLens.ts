import * as vscode from "vscode";
import { LineMap, parseXml } from "../language/xmlParser";
import { resolveElementType } from "../language/typeContext";
import { isReferenceTargetType } from "../indexer/refs";
import { scheduleRebuildIfRecordsDesync } from "../indexer/referenceIndex";
import type { ModIndex } from "../indexer/types";
import {
  collectReferenceSites,
  definitionsForReference,
  type ShowReferencesArgs,
} from "./references";
import type { ModWorkspace } from "../workspace";
import { t } from "../localize";

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
  private changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changeEmitter.event;
  /** URIs for which "no global snapshot yet" has already been logged. */
  private suppressedLogged = new Set<string>();

  constructor(private ws: ModWorkspace) {}

  /** Tells VS Code to re-query lenses (used after index snapshots). */
  refresh(): void {
    this.changeEmitter.fire();
  }

  /** Called when a new snapshot is published; allows re-logging suppression. */
  resetSuppressionLog(): void {
    this.suppressedLogged.clear();
  }

  async provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens[]> {
    if (!this.ws.isRa3Workspace()) return [];
    const startedAt = Date.now();
    const uri = document.uri.toString();
    let idx: ModIndex | null = null;
    try {
      idx = (await this.ws.getCodeLensScope(document)).merged;
    } catch (err) {
      this.ws.log(
        `[codelens] scope error for ${uri}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
    if (!idx) return [];
    // Before the first global snapshot exists the merged index is a
    // local-only index (stats.indexedFiles === 0) with no real references.
    // Rendering "0 references" then would be misleading, so wait until a
    // snapshot is published. Once a snapshot exists, "0" is meaningful and
    // must still be displayed for reference-target types.
    if (!idx.complete && idx.stats.indexedFiles === 0) {
      if (!this.suppressedLogged.has(uri)) {
        this.suppressedLogged.add(uri);
        this.ws.log(
          `[codelens] suppressed for ${uri} (no global snapshot yet)`,
        );
      }
      return [];
    }
    const text = document.getText();
    if (text.length > MAX_CODELENS_TEXT) {
      this.ws.log(
        `[codelens] skipped for ${uri} (${text.length} bytes > ${MAX_CODELENS_TEXT})`,
      );
      return [];
    }
    scheduleRebuildIfRecordsDesync(
      this.ws.recordsSyncSurfaceFor(document),
      document,
    );
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
      // Same definition union as Find All References: document-local
      // overlay + every same-id definition in the global index. This keeps
      // the lens count and the references peek consistent even when the
      // file itself is not part of the global include graph.
      const defs = definitionsForReference(idx, {
        id,
        refType: null,
        selfType: null,
      });
      const count = collectReferenceSites(idx, defs).length;
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
              ? t("0 references")
              : count === 1
                ? t("1 reference")
                : t("{0} references", count),
          command: "ra3modxml.showReferences",
          arguments: [args],
        }),
      );
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed > 250) {
      this.ws.log(
        `[codelens] slow provider for ${uri}: ${lenses.length} lenses in ${elapsed}ms`,
      );
    }
    return lenses;
  }
}

function localName(tag: string): string {
  const idx = tag.lastIndexOf(":");
  return idx >= 0 ? tag.slice(idx + 1) : tag;
}
