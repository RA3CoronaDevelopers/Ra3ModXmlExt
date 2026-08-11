import * as vscode from "vscode";
import { findElementAt, textContentTokenAt } from "../language/xmlParser";
import { resolveElementType } from "../language/typeContext";
import * as model from "../model/schemaModel";
import type { ModWorkspace } from "../workspace";
import {
  isLocalReferenceAttribute,
  isReferenceAttributeOfType,
  isReferenceContentType,
  resolveContentReferenceTargets,
  resolveReferenceTargetsForType,
  type ReferenceTarget,
} from "../indexer/refs";
import {
  findContainingGameObject,
  findLocalId,
  type LogicalElement,
} from "../indexer/logicalTree";
import { scopePathKey, type DocumentScope } from "../indexer/localScope";
import { dirname } from "node:path";
import { buildSearchPaths, resolveSource } from "../indexer/includeResolver";

export class Ra3HoverProvider implements vscode.HoverProvider {
  constructor(private ws: ModWorkspace) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): Promise<vscode.Hover | null> {
    if (!this.ws.isRa3Workspace()) return null;
    const offset = document.offsetAt(position);
    const text = document.getText();
    const scope = await this.ws.getScope(document);
    const doc = scope.expanded;
    const el = findElementAt(doc, offset);
    if (!el) return null;
    const elType = resolveElementType(el);

    // Attribute name.
    for (const attr of el.attrs) {
      if (offset >= attr.nameStart && offset <= attr.nameEnd) {
        return this.attributeHover(el, elType, attr.name);
      }
    }
    // Attribute value.
    for (const attr of el.attrs) {
      if (attr.hasValue && offset >= attr.valueStart && offset <= attr.valueEnd) {
        return this.valueHover(el, elType, attr.name, attr.value, document, scope);
      }
    }
    // Element text content (e.g. <CreateObject>CrateDebris_01</CreateObject>).
    const contentToken = textContentTokenAt(text, el, offset);
    if (contentToken) {
      const h = this.contentHover(elType, contentToken.value, document, scope);
      if (h) return h;
    }
    // Element name.
    const nameStart = el.start + 1;
    if (offset >= nameStart && offset <= nameStart + el.name.length) {
      return this.elementHover(el.name);
    }
    return null;
  }

  private elementHover(name: string): vscode.Hover | null {
    if (name.startsWith("xi:")) {
      const md = new vscode.MarkdownString();
      md.appendCodeblock(`<${name}>`, "xml");
      md.appendMarkdown(
        "XInclude element (W3C XInclude namespace) — not part of the RA3 XSD model.",
      );
      return new vscode.Hover(md);
    }
    const type = model.elementTypeName(name);
    const info = type ? model.typeInfo(type) : undefined;
    const md = new vscode.MarkdownString();
    md.appendCodeblock(`<${name}>`, "xml");
    if (model.isTopLevelElement(name)) md.appendMarkdown(`**Top-level asset element**  \n`);
    if (info?.kind === "complex") {
      if (info.doc) md.appendMarkdown(`${info.doc}  \n`);
      md.appendMarkdown(
        `Attributes: ${info.attributes.length} · Children: ${info.children.length}  \n`,
      );
      if (info.base) md.appendMarkdown(`Extends: \`${info.base}\``);
    } else if (info?.kind === "simple") {
      md.appendMarkdown(`Simple type: \`${type}\``);
    } else if (type) {
      md.appendMarkdown(`Type: \`${type}\``);
    } else {
      md.appendMarkdown("Not found in the bundled XSD model.");
    }
    return new vscode.Hover(md);
  }

  private attributeHover(
    el: { name: string },
    elementType: string | null,
    attrName: string,
  ): vscode.Hover | null {
    const attrs = model.attributesOfType(elementType);
    const attr = attrs.find((a) => a.name === attrName);
    const md = new vscode.MarkdownString();
    md.appendCodeblock(`${attrName}=""`, "xml");
    if (!attr) {
      if (/^(xmlns|xai:)/.test(attrName)) {
        md.appendMarkdown(`Namespace/instance attribute.`);
        return new vscode.Hover(md);
      }
      if (!model.isXsdElementName(el.name)) {
        md.appendMarkdown(
          `XInclude attribute (W3C XInclude namespace) — not part of the RA3 XSD model.`,
        );
        return new vscode.Hover(md);
      }
      md.appendMarkdown("Unknown attribute for this element.");
      return new vscode.Hover(md);
    }
    if (attr.doc) md.appendMarkdown(`${attr.doc}  \n`);
    if (attr.required) md.appendMarkdown(`**Required**  \n`);
    if (attr.refType) md.appendMarkdown(`References assets of type \`${attr.refType}\`  \n`);
    if (attr.enumValues.length)
      md.appendMarkdown(`Values: \`${attr.enumValues.join("`, `")}\`  \n`);
    if (attr.default != null) md.appendMarkdown(`Default: \`${attr.default}\`  \n`);
    if (attr.allowsDefine) md.appendMarkdown(`May use \`$DEFINE\` constants  \n`);
    md.appendMarkdown(`Type: \`${attr.type ?? "string"}\``);
    return new vscode.Hover(md);
  }

  private valueHover(
    el: { name: string },
    elType: string | null,
    attrName: string,
    value: string,
    document: vscode.TextDocument,
    scope: DocumentScope,
  ): vscode.Hover | null {
    const idx = scope.merged;
    const md = new vscode.MarkdownString();

    // $DEFINE reference.
    const defineMatch = /\$([A-Za-z_][A-Za-z0-9_]*)/.exec(value);
    if (defineMatch && idx) {
      const defs =
        idx.local?.defines.get(defineMatch[1].toLowerCase()) ??
        idx.defines.get(defineMatch[1].toLowerCase());
      const h = this.defineHover(defs, document);
      if (h) return h;
    }

    // Include source.
    if (
      (el.name === "Include" && attrName === "source") ||
      (el.name === "xi:include" && attrName === "href")
    ) {
      const searchPaths = idx
        ? buildSearchPaths(idx.sdkDir, idx.projectDir)
        : this.ws.searchPaths(document);
      const resolved = searchPaths
        ? resolveSource(
            value,
            dirname(document.uri.fsPath),
            searchPaths,
          ).path
        : null;
      if (resolved) {
        md.appendMarkdown(`**Include source**  \n`);
        md.appendCodeblock(resolved);
        return new vscode.Hover(md);
      }
      const cand = idx?.sourceCandidates.find((c) => c.source === value);
      if (cand) {
        md.appendMarkdown(`**Include source**  \n`);
        md.appendCodeblock(cand.path);
        return new vscode.Hover(md);
      }
      md.appendMarkdown(`Include source: \`${value}\` (not in candidate index)`);
      return new vscode.Hover(md);
    }

    // Pipeline-local (Poid) references: resolve inside the enclosing
    // GameObject's logical subtree (including xi:include targets).
    if (
      isLocalReferenceAttribute(elType, attrName) &&
      attrName.toLowerCase() !== "id"
    ) {
      return this.localIdHover(scope, el as LogicalElement, value, document);
    }

    // Asset reference / inheritFrom.
    if (!idx) {
      if (isReferenceAttributeOfType(elType, attrName)) {
        md.appendMarkdown(
          "Index is still building — references cannot be resolved yet.",
        );
        return new vscode.Hover(md);
      }
      return null;
    }
    {
      if (!isReferenceAttributeOfType(elType, attrName)) return null;
      const targets = resolveReferenceTargetsForType(idx, elType, attrName, value);
      if (targets.length) return this.definitionsHover(targets, document);
      const attrRef = model
        .attributesOfType(elType)
        .find((a) => a.name === attrName);
      const expected = attrRef?.refType
        ? ` of type \`${attrRef.refType}\``
        : attrRef?.isRef
          ? " of the expected declared type"
          : "";
      return this.noDefinitionHover(expected);
    }
  }

  /**
   * Hover for text inside a simple-content element whose type is a typed
   * asset reference (e.g. <CreateObject> with GameObjectWeakRef).
   */
  private contentHover(
    elType: string | null,
    value: string,
    document: vscode.TextDocument,
    scope: DocumentScope,
  ): vscode.Hover | null {
    const idx = scope.merged;
    const defineMatch = /\$([A-Za-z_][A-Za-z0-9_]*)/.exec(value);
    if (defineMatch && idx) {
      const defs =
        idx.local?.defines.get(defineMatch[1].toLowerCase()) ??
        idx.defines.get(defineMatch[1].toLowerCase());
      const h = this.defineHover(defs, document);
      if (h) return h;
    }
    if (!isReferenceContentType(elType)) return null;
    if (!idx) {
      const md = new vscode.MarkdownString();
      md.appendMarkdown("Index is still building — references cannot be resolved yet.");
      return new vscode.Hover(md);
    }
    const targets = resolveContentReferenceTargets(idx, elType, value);
    if (targets.length) return this.definitionsHover(targets, document);
    const info = elType ? model.typeInfo(elType) : undefined;
    const refType = info?.kind === "simple" ? info.refType : null;
    return this.noDefinitionHover(
      refType ? ` of type \`${refType}\`` : " of the expected declared type",
    );
  }

  private defineHover(
    defs: { name: string; value: string; file: string; line: number }[] | undefined,
    document: vscode.TextDocument,
  ): vscode.Hover | null {
    if (!defs?.length) return null;
    const d = defs[0];
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**Define** \`$${d.name}\`  \n`);
    md.appendCodeblock(d.value);
    const rel = relativePath(document, d.file);
    md.appendMarkdown(`Defined in \`${rel}:${d.line}\``);
    return new vscode.Hover(md);
  }

  private definitionsHover(
    targets: ReferenceTarget[],
    document: vscode.TextDocument,
  ): vscode.Hover {
    const md2 = new vscode.MarkdownString();
    md2.appendMarkdown(`**${targets.length} definition${targets.length > 1 ? "s" : ""}**  \n`);
    for (const { def: d } of targets.slice(0, 8)) {
      const loc =
        d.origin === "manifest"
          ? `manifest \`${d.manifestSource ?? d.file}\``
          : `\`${relativePath(document, d.file)}:${d.line}\``;
      md2.appendMarkdown(`- \`${d.type}\` · ${loc}  \n`);
    }
    return new vscode.Hover(md2);
  }

  private noDefinitionHover(expected: string): vscode.Hover {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(
      `No matching definition${expected} in the current index` +
        " (may exist in a compiled manifest or vanilla data).",
    );
    return new vscode.Hover(md);
  }

  private localIdHover(
    scope: DocumentScope,
    el: LogicalElement,
    value: string,
    document: vscode.TextDocument,
  ): vscode.Hover | null {
    const root = findContainingGameObject(el);
    if (!root) return null;
    const target = findLocalId(root, value);
    if (!target) return null;
    const idAttr = target.attrs.find((a) => a.name === "id");
    if (!idAttr?.hasValue) return null;
    const lineMap = scope.lineMaps.get(scopePathKey(target.sourceFile));
    const line = lineMap ? lineMap.positionAt(idAttr.valueStart).line + 1 : 0;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**Local pipeline id** \`${value}\`  \n`);
    md.appendCodeblock(`<${target.name}>`);
    const rel = relativePath(document, target.sourceFile);
    md.appendMarkdown(`Defined in \`${rel}:${line}\``);
    return new vscode.Hover(md);
  }
}

function relativePath(document: vscode.TextDocument, abs: string): string {
  const root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
  if (!root) return abs;
  const rel = abs.toLowerCase().startsWith(root.toLowerCase())
    ? abs.slice(root.length + 1)
    : abs;
  return rel;
}
