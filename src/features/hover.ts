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
import { t } from "../localize";

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
        t(
          "XInclude element (W3C XInclude namespace) — not part of the RA3 XSD model.",
        ),
      );
      return new vscode.Hover(md);
    }
    const type = model.elementTypeName(name);
    const info = type ? model.typeInfo(type) : undefined;
    const md = new vscode.MarkdownString();
    md.appendCodeblock(`<${name}>`, "xml");
    if (model.isTopLevelElement(name)) {
      md.appendMarkdown(`${t("**Top-level asset element**")}  \n`);
    }
    if (info?.kind === "complex") {
      if (info.doc) md.appendMarkdown(`${info.doc}  \n`);
      md.appendMarkdown(
        `${t(
          "Attributes: {0} · Children: {1}",
          info.attributes.length,
          info.children.length,
        )}  \n`,
      );
      if (info.base) md.appendMarkdown(t("Extends: `{0}`", info.base));
    } else if (info?.kind === "simple") {
      md.appendMarkdown(t("Simple type: `{0}`", type ?? ""));
    } else if (type) {
      md.appendMarkdown(t("Type: `{0}`", type));
    } else {
      md.appendMarkdown(t("Not found in the bundled XSD model."));
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
        md.appendMarkdown(t("Namespace/instance attribute."));
        return new vscode.Hover(md);
      }
      if (!model.isXsdElementName(el.name)) {
        md.appendMarkdown(
          t(
            "XInclude attribute (W3C XInclude namespace) — not part of the RA3 XSD model.",
          ),
        );
        return new vscode.Hover(md);
      }
      md.appendMarkdown(t("Unknown attribute for this element."));
      return new vscode.Hover(md);
    }
    if (attr.doc) md.appendMarkdown(`${attr.doc}  \n`);
    if (attr.required) md.appendMarkdown(`${t("**Required**")}  \n`);
    if (attr.refType) {
      md.appendMarkdown(
        `${t("References assets of type `{0}`", attr.refType)}  \n`,
      );
    }
    if (attr.enumValues.length)
      md.appendMarkdown(
        `${t("Values: `{0}`", attr.enumValues.join("`, `"))}  \n`,
      );
    if (attr.default != null) {
      md.appendMarkdown(`${t("Default: `{0}`", attr.default)}  \n`);
    }
    if (attr.allowsDefine) {
      md.appendMarkdown(`${t("May use `$DEFINE` constants")}  \n`);
    }
    md.appendMarkdown(t("Type: `{0}`", attr.type ?? "string"));
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
        md.appendMarkdown(`${t("**Include source**")}  \n`);
        md.appendCodeblock(resolved);
        return new vscode.Hover(md);
      }
      const cand = idx?.sourceCandidates.find((c) => c.source === value);
      if (cand) {
        md.appendMarkdown(`${t("**Include source**")}  \n`);
        md.appendCodeblock(cand.path);
        return new vscode.Hover(md);
      }
      md.appendMarkdown(
        t("Include source: `{0}` (not in candidate index)", value),
      );
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
          t("Index is still building — references cannot be resolved yet."),
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
      return this.noDefinitionHover(
        attrRef?.refType
          ? "typed"
          : attrRef?.isRef
            ? "untyped"
            : "generic",
        attrRef?.refType ?? undefined,
      );
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
      md.appendMarkdown(
        t("Index is still building — references cannot be resolved yet."),
      );
      return new vscode.Hover(md);
    }
    const targets = resolveContentReferenceTargets(idx, elType, value);
    if (targets.length) return this.definitionsHover(targets, document);
    const info = elType ? model.typeInfo(elType) : undefined;
    const refType = info?.kind === "simple" ? info.refType : null;
    return this.noDefinitionHover(refType ? "typed" : "untyped", refType ?? undefined);
  }

  private defineHover(
    defs: { name: string; value: string; file: string; line: number }[] | undefined,
    document: vscode.TextDocument,
  ): vscode.Hover | null {
    if (!defs?.length) return null;
    const d = defs[0];
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`${t("**Define** `{0}`", `$${d.name}`)}  \n`);
    md.appendCodeblock(d.value);
    const rel = relativePath(document, d.file);
    md.appendMarkdown(t("Defined in `{0}:{1}`", rel, d.line));
    return new vscode.Hover(md);
  }

  private definitionsHover(
    targets: ReferenceTarget[],
    document: vscode.TextDocument,
  ): vscode.Hover {
    const md2 = new vscode.MarkdownString();
    md2.appendMarkdown(
      `${targets.length === 1 ? t("**1 definition**") : t("**{0} definitions**", targets.length)}  \n`,
    );
    for (const { def: d } of targets.slice(0, 8)) {
      const loc =
        d.origin === "manifest"
          ? t("manifest `{0}`", d.manifestSource ?? d.file)
          : t("`{0}:{1}`", relativePath(document, d.file), d.line);
      md2.appendMarkdown(`${t("- `{0}` · {1}", d.type, loc)}  \n`);
    }
    return new vscode.Hover(md2);
  }

  private noDefinitionHover(
    kind: "typed" | "untyped" | "generic",
    refType?: string,
  ): vscode.Hover {
    const md = new vscode.MarkdownString();
    if (kind === "typed" && refType) {
      md.appendMarkdown(
        t(
          "No matching definition of type `{0}` in the current index (may exist in a compiled manifest or vanilla data).",
          refType,
        ),
      );
    } else if (kind === "untyped") {
      md.appendMarkdown(
        t(
          "No matching definition of the expected declared type in the current index (may exist in a compiled manifest or vanilla data).",
        ),
      );
    } else {
      md.appendMarkdown(
        t(
          "No matching definition in the current index (may exist in a compiled manifest or vanilla data).",
        ),
      );
    }
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
    md.appendMarkdown(`${t("**Local pipeline id** `{0}`", value)}  \n`);
    md.appendCodeblock(`<${target.name}>`);
    const rel = relativePath(document, target.sourceFile);
    md.appendMarkdown(t("Defined in `{0}:{1}`", rel, line));
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
