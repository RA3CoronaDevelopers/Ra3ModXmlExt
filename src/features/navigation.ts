import * as vscode from "vscode";
import { dirname } from "node:path";
import { findElementAt, parseXml } from "../language/xmlParser";
import { resolveElementType } from "../language/typeContext";
import {
  buildSearchPaths,
  resolveSource,
  type SearchPaths,
} from "../indexer/includeResolver";
import { resolveReferenceTargetsForType } from "../indexer/refs";
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
    const idx = this.ws.index;
    if (!idx) return null;
    const text = document.getText();
    const offset = document.offsetAt(position);
    const doc = parseXml(text);
    const el = findElementAt(doc, offset);
    if (!el) return null;
    const elType = resolveElementType(el);

    const attr = el.attrs.find(
      (a) => a.hasValue && offset >= a.valueStart && offset <= a.valueEnd,
    );
    if (!attr) return null;
    const value = attr.value;
    const nameLower = attr.name.toLowerCase();

    // Include source / xi:include href -> open the file.
    if (
      (el.name === "Include" && nameLower === "source") ||
      (el.name === "include" && nameLower === "href")
    ) {
      const resolved =
        resolveSource(value, dirname(document.uri.fsPath), searchPathsFor(idx)).path ??
        idx.sourceCandidates.find((c) => c.source === value)?.path ??
        null;
      return resolved
        ? new vscode.Location(vscode.Uri.file(resolved), new vscode.Position(0, 0))
        : null;
    }

    // Asset reference / inheritFrom (filtered by the attribute's ref type).
    if (value && !value.startsWith("$")) {
      let targets = resolveReferenceTargetsForType(idx, elType, attr.name, value);
      if (!targets.length) return null;
      if (
        this.ws.settings.definitionMode === "project-only" &&
        targets.some((t) => t.def.origin === "project")
      ) {
        targets = targets.filter((t) => t.def.origin === "project");
      }
      const locations: vscode.Location[] = [];
      for (const { def } of targets.slice(0, 8)) {
        const loc = await assetDefLocation(this.ws, def, idx);
        if (loc) locations.push(loc);
      }
      return locations.length ? locations : null;
    }
    return null;
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
): Promise<vscode.Location | null> {
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

  return (
    (await locationInDocument(ws, def.file, def.id)) ??
    new vscode.Location(
      vscode.Uri.file(def.file),
      new vscode.Position(Math.max(0, def.line - 1), 0),
    )
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
  const parsed = await ws.indexer?.readDocument(file);
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
  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.ReferenceContext,
    _token: vscode.CancellationToken,
  ): Promise<vscode.Location[] | null> {
    const text = document.getText();
    const offset = document.offsetAt(position);
    const doc = parseXml(text);
    const el = findElementAt(doc, offset);
    if (!el) return null;
    const attr = el.attrs.find(
      (a) =>
        (a.hasValue && offset >= a.valueStart && offset <= a.valueEnd) ||
        (offset >= a.nameStart && offset <= a.nameEnd),
    );
    if (!attr?.hasValue) return null;
    const id = attr.value;
    if (!id || id.startsWith("$")) return null;

    const locations: vscode.Location[] = [];
    const pattern = `["']${escapeRegExp(id)}["']`;
    await findTextInWorkspace(
      { pattern, isRegExp: true },
      { include: "**/*.xml", maxResults: 2000 },
      (result: { uri: vscode.Uri; matches: { range: vscode.Range }[] }) => {
        if (!result.uri) return;
        for (const m of result.matches) {
          locations.push(new vscode.Location(result.uri, m.range));
        }
      },
    );
    return locations.length ? locations : null;
  }
}

// ── Document links (ctrl+click on includes) ─────────────────────────

export class Ra3DocumentLinkProvider implements vscode.DocumentLinkProvider {
  constructor(private ws: ModWorkspace) {}

  async provideDocumentLinks(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): Promise<vscode.DocumentLink[]> {
    const idx = this.ws.index;
    if (!idx) return [];
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
          searchPathsFor(idx),
        ).path ??
        idx.sourceCandidates.find((c) => c.source === srcAttr.value)?.path ??
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
  async provideDocumentSymbols(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): Promise<vscode.DocumentSymbol[]> {
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `workspace.findTextInFiles` is a stable VS Code API (since 1.66) but is
 * missing from the published typings, so we declare the subset we need and
 * call it via a safe cast.
 */
interface TextSearchQuery {
  pattern: string;
  isRegExp?: boolean;
  isCaseSensitive?: boolean;
  isWordMatch?: boolean;
}

interface TextSearchOptions {
  include?: string;
  exclude?: string;
  maxResults?: number;
}

function findTextInWorkspace(
  query: TextSearchQuery,
  options: TextSearchOptions,
  callback: (result: { uri: vscode.Uri; matches: { range: vscode.Range }[] }) => void,
): Promise<void> {
  const api = vscode.workspace as unknown as {
    findTextInFiles(
      query: TextSearchQuery,
      options: TextSearchOptions,
      callback: (result: { uri: vscode.Uri; matches: { range: vscode.Range }[] }) => void,
    ): Promise<unknown>;
  };
  return api.findTextInFiles(query, options, callback).then(() => undefined);
}
