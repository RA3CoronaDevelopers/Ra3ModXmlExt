import * as vscode from "vscode";
import { dirname } from "node:path";
import { findElementAt, parseXml, textContentTokenAt } from "../language/xmlParser";
import { resolveElementType } from "../language/typeContext";
import {
  buildSearchPaths,
  resolveSource,
  type SearchPaths,
} from "../indexer/includeResolver";
import {
  isLocalReferenceAttribute,
  isReferenceContentType,
  resolveContentReferenceTargets,
  resolveReferenceTargetsForType,
  type ReferenceTarget,
} from "../indexer/refs";
import { findReferenceLocations } from "./references";
import {
  findContainingGameObject,
  findLocalId,
  type LogicalElement,
} from "../indexer/logicalTree";
import { scopePathKey, type DocumentScope } from "../indexer/localScope";
import type { ModWorkspace } from "../workspace";
import type { AssetDef, ModIndex } from "../indexer/types";

function searchPathsFor(idx: ModIndex): SearchPaths {
  return buildSearchPaths(idx.sdkDir, idx.projectDir);
}

// ── Go to definition ────────────────────────────────────────────────

export class Ra3DefinitionProvider implements vscode.DefinitionProvider {
  constructor(private ws: ModWorkspace) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): Promise<vscode.Location | vscode.Location[] | null> {
    if (!this.ws.isRa3Workspace()) return null;
    const scope = await this.ws.getScope(document);
    const idx = scope.merged;
    const offset = document.offsetAt(position);
    const doc = scope.expanded;
    const el = findElementAt(doc, offset);
    if (!el) return null;
    const elType = resolveElementType(el);

    const attr = el.attrs.find(
      (a) => a.hasValue && offset >= a.valueStart && offset <= a.valueEnd,
    );
    if (!attr) {
      // Element text content (e.g. <CreateObject>CrateDebris_01</CreateObject>).
      if (idx && isReferenceContentType(elType)) {
        const token = textContentTokenAt(document.getText(), el, offset);
        if (token && !token.value.startsWith("$")) {
          const targets = resolveContentReferenceTargets(idx, elType, token.value);
          if (targets.length) {
            return this.referenceLocations(scope, idx, targets, document);
          }
        }
      }
      return null;
    }
    const value = attr.value;
    const nameLower = attr.name.toLowerCase();

    // Include source / xi:include href -> open the file.
    if (
      (el.name === "Include" && nameLower === "source") ||
      (el.name === "include" && nameLower === "href")
    ) {
      const searchPaths = idx ? searchPathsFor(idx) : this.ws.searchPaths();
      const resolved = searchPaths
        ? resolveSource(value, dirname(document.uri.fsPath), searchPaths).path
        : null;
      const fallback = idx?.sourceCandidates.find((c) => c.source === value)?.path;
      const target = resolved ?? fallback ?? null;
      return target
        ? new vscode.Location(vscode.Uri.file(target), new vscode.Position(0, 0))
        : null;
    }

    // Asset reference / inheritFrom (filtered by the attribute's ref type).
    if (!idx) return null;
    if (value && !value.startsWith("$")) {
      if (
        isLocalReferenceAttribute(elType, attr.name) &&
        nameLower !== "id"
      ) {
        const local = this.localIdLocation(
          scope,
          el as LogicalElement,
          value,
        );
        if (local) return local;
      }
      const targets = resolveReferenceTargetsForType(idx, elType, attr.name, value);
      if (!targets.length) return null;
      return this.referenceLocations(scope, idx, targets, document);
    }
    return null;
  }

  private async referenceLocations(
    scope: DocumentScope,
    idx: ModIndex,
    targets: ReferenceTarget[],
    document: vscode.TextDocument,
  ): Promise<vscode.Location[] | null> {
    let filtered = targets;
    if (
      this.ws.settings.definitionMode === "project-only" &&
      targets.some((t) => t.def.origin === "project")
    ) {
      filtered = targets.filter((t) => t.def.origin === "project");
    }
    const locations: vscode.Location[] = [];
    for (const { def } of filtered.slice(0, 8)) {
      const loc = await assetDefLocation(this.ws, def, idx, scope, document);
      if (loc) locations.push(loc);
    }
    return locations.length ? locations : null;
  }

  private localIdLocation(
    scope: DocumentScope,
    el: LogicalElement,
    value: string,
  ): vscode.Location | null {
    const root = findContainingGameObject(el);
    if (!root) return null;
    const target = findLocalId(root, value);
    if (!target) return null;
    const idAttr = target.attrs.find((a) => a.name === "id");
    if (!idAttr?.hasValue) return null;
    const lineMap = scope.lineMaps.get(scopePathKey(target.sourceFile));
    if (!lineMap) {
      return new vscode.Location(
        vscode.Uri.file(target.sourceFile),
        new vscode.Position(0, 0),
      );
    }
    return new vscode.Location(
      vscode.Uri.file(target.sourceFile),
      new vscode.Range(
        toVscodePosition(lineMap.positionAt(idAttr.valueStart)),
        toVscodePosition(lineMap.positionAt(idAttr.valueEnd)),
      ),
    );
  }
}

/**
 * Builds a location for an asset definition. For XML sources the location is
 * the precise range of the id attribute value (or the element start tag when
 * the id value cannot be located), falling back to the recorded line.
 */
async function assetDefLocation(
  ws: ModWorkspace,
  def: AssetDef,
  idx: ModIndex,
  scope: DocumentScope,
  currentDocument: vscode.TextDocument,
): Promise<vscode.Location | null> {
  // While a rebuild is running, avoid readDom() mutating the live indexer's
  // caches mid-build; a line-based location is a fine temporary fallback.
  if (ws.isBuilding) {
    const line = Math.max(0, def.line - 1);
    return new vscode.Location(
      vscode.Uri.file(def.file),
      new vscode.Range(
        new vscode.Position(line, 0),
        new vscode.Position(line, 1),
      ),
    );
  }
  if (def.origin === "manifest") {
    const src = def.manifestSource;
    if (src?.toUpperCase().startsWith("DATA:")) {
      const resolved = resolveSource(src, null, searchPathsFor(idx)).path;
      if (resolved) {
        // The recorded source file is XML (e.g. SageXml) when available:
        // jump to the precise definition inside it, not just the file.
        const precise = await locationInDocument(ws, resolved, def.id);
        return precise ?? new vscode.Location(vscode.Uri.file(resolved), new vscode.Position(0, 0));
      }
    }
    return null;
  }

  if (scopePathKey(def.file) === scopePathKey(currentDocument.uri.fsPath)) {
    const precise = locationInCurrentDocument(scope, def.id, currentDocument);
    if (precise) return precise;
  }

  return (
    (await locationInDocument(ws, def.file, def.id)) ??
    new vscode.Location(
      vscode.Uri.file(def.file),
      new vscode.Position(Math.max(0, def.line - 1), 0),
    )
  );
}

function locationInCurrentDocument(
  scope: DocumentScope,
  id: string,
  document: vscode.TextDocument,
): vscode.Location | null {
  const el = scope.parse.elements.find((e) =>
    e.attrs.some(
      (a) => a.name === "id" && a.value.toLowerCase() === id.toLowerCase(),
    ),
  );
  if (!el) return null;
  const idAttr = el.attrs.find((a) => a.name === "id");
  if (idAttr?.hasValue) {
    return new vscode.Location(
      document.uri,
      new vscode.Range(
        document.positionAt(idAttr.valueStart),
        document.positionAt(idAttr.valueEnd),
      ),
    );
  }
  return new vscode.Location(
    document.uri,
    new vscode.Range(
      document.positionAt(el.start),
      document.positionAt(el.startTagEnd),
    ),
  );
}

/**
 * Finds the precise range of an asset definition inside an XML file: the id
 * attribute value when present, otherwise the element start tag.
 */
async function locationInDocument(
  ws: ModWorkspace,
  file: string,
  id: string,
): Promise<vscode.Location | null> {
  // readDom (not readDocument) guarantees a DOM even when the compact
  // records cache already has an entry for the file.
  const parsed = await ws.indexer?.readDom(file);
  if (parsed?.parse && parsed.lineMap) {
    const el = parsed.parse.elements.find(
      (e) =>
        e.attrs.some(
          (a) => a.name === "id" && a.value.toLowerCase() === id.toLowerCase(),
        ),
    );
    if (el) {
      const idAttr = el.attrs.find((a) => a.name === "id");
      if (idAttr?.hasValue) {
        return new vscode.Location(
          vscode.Uri.file(file),
          new vscode.Range(
            toVscodePosition(parsed.lineMap.positionAt(idAttr.valueStart)),
            toVscodePosition(parsed.lineMap.positionAt(idAttr.valueEnd)),
          ),
        );
      }
      return new vscode.Location(
        vscode.Uri.file(file),
        new vscode.Range(
          toVscodePosition(parsed.lineMap.positionAt(el.start)),
          toVscodePosition(parsed.lineMap.positionAt(el.startTagEnd)),
        ),
      );
    }
  }
  return null;
}

function toVscodePosition(p: { line: number; character: number }): vscode.Position {
  return new vscode.Position(p.line, p.character);
}

// ── Find all references ─────────────────────────────────────────────

export class Ra3ReferenceProvider implements vscode.ReferenceProvider {
  constructor(private ws: ModWorkspace) {}

  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.ReferenceContext,
    _token: vscode.CancellationToken,
  ): Promise<vscode.Location[] | null> {
    return findReferenceLocations(this.ws, document, position);
  }
}

// ── Document links (ctrl+click on includes) ─────────────────────────

export class Ra3DocumentLinkProvider implements vscode.DocumentLinkProvider {
  constructor(private ws: ModWorkspace) {}

  async provideDocumentLinks(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): Promise<vscode.DocumentLink[]> {
    if (!this.ws.isRa3Workspace()) return [];
    const idx = this.ws.index;
    const searchPaths = idx ? searchPathsFor(idx) : this.ws.searchPaths();
    if (!searchPaths) return [];
    const text = document.getText();
    const doc = parseXml(text);
    const links: vscode.DocumentLink[] = [];
    for (const el of doc.elements) {
      if (el.name !== "Include" && el.name !== "include") continue;
      const srcAttr = el.attrs.find((a) => a.name === "source" || a.name === "href");
      if (!srcAttr?.hasValue) continue;
      const target =
        resolveSource(
          srcAttr.value,
          dirname(document.uri.fsPath),
          searchPaths,
        ).path ??
        idx?.sourceCandidates.find((c) => c.source === srcAttr.value)?.path ??
        null;
      if (!target) continue;
      links.push(
        new vscode.DocumentLink(
          new vscode.Range(
            document.positionAt(srcAttr.valueStart),
            document.positionAt(srcAttr.valueEnd),
          ),
          vscode.Uri.file(target),
        ),
      );
    }
    return links;
  }
}

// ── Document symbols (outline) ──────────────────────────────────────

export class Ra3DocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  constructor(private ws: ModWorkspace) {}

  async provideDocumentSymbols(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): Promise<vscode.DocumentSymbol[]> {
    if (!this.ws.isRa3Workspace()) return [];
    const text = document.getText();
    const doc = parseXml(text);
    const root = doc.root;
    if (!root) return [];
    const symbols: vscode.DocumentSymbol[] = [];
    for (const child of root.children) {
      const local = localName(child.name);
      if (local === "Tags" || local === "Includes" || local === "Defines") continue;
      const idAttr = child.attrs.find((a) => a.name === "id");
      const label = idAttr ? `${local} ${idAttr.value}` : local;
      const fullRange = new vscode.Range(
        document.positionAt(child.start),
        document.positionAt(child.end),
      );
      const selectionRange = new vscode.Range(
        document.positionAt(child.start),
        document.positionAt(child.startTagEnd),
      );
      symbols.push(
        new vscode.DocumentSymbol(
          label,
          "",
          vscode.SymbolKind.Class,
          fullRange,
          selectionRange,
        ),
      );
    }
    for (const child of root.children) {
      if (localName(child.name) !== "Defines") continue;
      for (const define of child.children) {
        if (localName(define.name) !== "Define") continue;
        const name = define.attrs.find((a) => a.name === "name")?.value;
        if (!name) continue;
        const range = new vscode.Range(
          document.positionAt(define.start),
          document.positionAt(define.end),
        );
        symbols.push(
          new vscode.DocumentSymbol(`$${name}`, "Define", vscode.SymbolKind.Constant, range, range),
        );
      }
    }
    return symbols;
  }
}

function localName(tag: string): string {
  const idx = tag.lastIndexOf(":");
  return idx >= 0 ? tag.slice(idx + 1) : tag;
}
