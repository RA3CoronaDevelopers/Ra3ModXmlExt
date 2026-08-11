import * as vscode from "vscode";
import { dirname } from "node:path";
import {
  LineMap,
  type XmlElement,
  type XmlParseError,
} from "../language/xmlParser";
import { resolveElementType } from "../language/typeContext";
import { resolveSource, buildSearchPaths } from "../indexer/includeResolver";
import { validateSdkPath } from "../sdk";
import * as model from "../model/schemaModel";
import type { ModWorkspace } from "../workspace";
import type { ModIndex } from "../indexer/types";
import {
  isReferenceContentType,
  isReferenceAttributeOfType,
  mergeLocalAndGlobalDefs,
  resolveContentReferenceTargets,
  resolveReferenceTargetsForType,
} from "../indexer/refs";
import type { LogicalElement } from "../indexer/logicalTree";
import { scopePathKey } from "../indexer/localScope";
import { t } from "../localize";

export class Ra3Diagnostics {
  private collection: vscode.DiagnosticCollection;
  private sdkCache: { path: string; unusable: boolean } | null = null;

  constructor(private ws: ModWorkspace) {
    this.collection = vscode.languages.createDiagnosticCollection("ra3modxml");
  }

  /** True when the SDK is missing or not an SDK root (project-only mode). */
  private sdkUnusable(): boolean {
    const path = this.ws.settings.sdkPath;
    if (this.sdkCache?.path === path) return this.sdkCache.unusable;
    const status = validateSdkPath(path).status;
    const unusable = status === "missing" || status === "not-sdk";
    this.sdkCache = { path, unusable };
    return unusable;
  }

  async update(document: vscode.TextDocument): Promise<void> {
    if (!this.ws.isRa3Workspace()) {
      this.collection.set(document.uri, []);
      return;
    }
    const scope = await this.ws.getScope(document);
    const idx = scope.merged;
    const text = document.getText();
    const lineMap = new LineMap(text);
    const doc = scope.parse;
    const diags: vscode.Diagnostic[] = [];
    // Reference/duplicate checks are provisional while the index is
    // incomplete or stale: "not found" may be a false positive.
    const provisional = idx ? !idx.complete || idx.stale === true : false;

    for (const err of doc.errors) {
      diags.push(
        this.diag(
          new vscode.Range(
            new vscode.Position(err.line, err.character),
            new vscode.Position(err.line, err.character + 1),
          ),
          this.parseErrorMessage(err),
          vscode.DiagnosticSeverity.Error,
          "xml-syntax",
        ),
      );
    }

    if (doc.root) {
      this.checkElements(
        scope.expanded.root,
        scope.expanded,
        lineMap,
        idx,
        document,
        diags,
        provisional,
      );
    }

    this.collection.set(document.uri, diags);
  }

  private parseErrorMessage(err: XmlParseError): string {
    switch (err.code) {
      case "content-before-root":
        return t("Content is not allowed before the root element");
      case "unterminated-comment":
        return t("Unterminated comment");
      case "unterminated-cdata":
        return t("Unterminated CDATA section");
      case "unterminated-doctype":
        return t("Unterminated DOCTYPE");
      case "unterminated-processing-instruction":
        return t("Unterminated processing instruction");
      case "unterminated-closing-tag":
        return t("Unterminated closing tag");
      case "unterminated-start-tag":
        return t("Unterminated start tag");
      case "malformed-markup":
        return t("Malformed markup");
      case "unexpected-closing-tag":
        return t(
          "Unexpected closing tag </{0}>",
          err.params?.name ?? "",
        );
      case "mismatched-closing-tag":
        return t(
          "Mismatched closing tag: expected </{0}>, found </{1}>",
          err.params?.expected ?? "",
          err.params?.found ?? "",
        );
      case "element-never-closed":
        return t("Element <{0}> is never closed", err.params?.name ?? "");
      default:
        return err.message;
    }
  }

  clear(uri: vscode.Uri): void {
    this.collection.delete(uri);
  }

  dispose(): void {
    this.collection.dispose();
  }

  private checkElements(
    root: LogicalElement | null,
    doc: { elements: LogicalElement[] },
    lineMap: LineMap,
    idx: ModIndex | null,
    document: vscode.TextDocument,
    diags: vscode.Diagnostic[],
    provisional: boolean,
  ): void {
    const settings = this.ws.settings;
    const fileDuplicates = new Map<string, { line: number }>();
    // A file whose root is not AssetDeclaration is an xi:include fragment
    // (e.g. Data/Includes/GenericCelestialBuildingSuicide.xml). It is not a
    // standalone RA3 document: top-level id / duplicate checks do not apply,
    // and references/defines can only be resolved in the includer's context.
    // When the fragment root itself is a known XSD element (e.g.
    // CreateObjectDie), the root supplies the type context for its whole
    // subtree, so element/attribute validation is still reliable.
    const rootName = root ? localName(root.name) : "";
    const isFragment = rootName !== "AssetDeclaration";
    const validateTree =
      !isFragment || (root !== null && model.elementTypeName(rootName) !== null);

    for (const el of doc.elements) {
      // Only report diagnostics for nodes that belong to the document being
      // edited. Nodes spliced in through xi:include keep their own source
      // file and are diagnosed when that file is opened.
      if (scopePathKey(el.sourceFile) !== scopePathKey(document.uri.fsPath)) {
        continue;
      }
      const local = localName(el.name);
      const isTopLevel =
        root !== null &&
        el.parent === root &&
        !["Tags", "Includes", "Defines"].includes(local);
      const range = tagRange(document, el);

      // Top-level assets must have an id.
      if (!isFragment && isTopLevel) {
        const idAttr = el.attrs.find((a) => a.name === "id");
        if (!idAttr || !idAttr.value) {
          diags.push(
            this.diag(
              range,
              t("Top-level asset <{0}> requires an id attribute", local),
              vscode.DiagnosticSeverity.Error,
              "missing-id",
            ),
          );
        } else {
          const key = `${local.toLowerCase()}:${idAttr.value.toLowerCase()}`;
          const prev = fileDuplicates.get(key);
          if (prev) {
            const where = new vscode.Range(
              document.positionAt(idAttr.valueStart),
              document.positionAt(idAttr.valueEnd),
            );
            diags.push(
              this.diag(
                where,
                t(
                  'Duplicate id "{0}" for <{1}> (also defined on line {2})',
                  idAttr.value,
                  local,
                  prev.line,
                ),
                vscode.DiagnosticSeverity.Error,
                "duplicate-id",
              ),
            );
          } else {
            fileDuplicates.set(key, { line: lineMap.positionAt(el.start).line + 1 });
          }
          this.checkCrossFileDuplicate(
            local,
            idAttr.value,
            document,
            idx,
            diags,
            provisional,
          );
        }
      }

      // Elements outside the EA asset namespace (e.g. XInclude <xi:include>)
      // are not part of the RA3 XSD model; skip their validation entirely.
      const isXsdElement = model.isXsdElementName(el.name);

      // Unknown element.
      if (settings.diagnoseUnknownElements && isXsdElement && validateTree) {
        const knownType = model.elementTypeName(local);
        if (!knownType) {
          diags.push(
            this.diag(
              range,
              t("Unknown element <{0}> (not in the RA3 XSD model)", local),
              vscode.DiagnosticSeverity.Warning,
              "unknown-element",
            ),
          );
        }
      }

      // Attributes.
      if (isXsdElement && validateTree) {
        const elType = resolveElementType(el);
        const knownAttrs = model.attributesOfType(elType);
        const knownNames = new Set(knownAttrs.map((a) => a.name));
        for (const attr of el.attrs) {
          const aName = attr.name;
          // Namespace declarations and prefixed attributes (xai:, xi:,
          // xlink:, xml:, xsi:, xmlns:*) are not defined by the EA XSD.
          if (aName.startsWith("xmlns") || !model.isXsdAttributeName(aName)) {
            continue;
          }
          if (settings.diagnoseUnknownElements && !knownNames.has(aName)) {
              diags.push(
                this.diag(
                  new vscode.Range(
                    document.positionAt(attr.nameStart),
                    document.positionAt(attr.nameEnd),
                  ),
                  t('Unknown attribute "{0}" for <{1}>', aName, local),
                  vscode.DiagnosticSeverity.Warning,
                  "unknown-attribute",
                ),
            );
          }

          if (!attr.hasValue) continue;
          // References and $DEFINE constants inside fragments depend on the
          // includer's context; don't report them until P1 resolves the real
          // include sites.
          if (!isFragment) {
            this.checkValueReferences(
              elType,
              attr.name,
              attr.value,
              attr,
              document,
              idx,
              diags,
              provisional,
            );
          }
        }
        if (!isFragment) {
          this.checkContentReferences(el, elType, document, idx, diags, provisional);
        }
      }

      // Include-specific checks.
      if (local === "Include") {
        this.checkInclude(el, document, idx, diags);
      } else if (local === "include" && el.name.toLowerCase().startsWith("xi:")) {
        this.checkXiInclude(el, document, idx, diags);
      }
    }
  }

  private checkXiInclude(
    el: XmlElement,
    document: vscode.TextDocument,
    idx: ModIndex | null,
    diags: vscode.Diagnostic[],
  ): void {
    const hrefAttr = el.attrs.find((a) => a.name === "href");
    if (!hrefAttr?.hasValue) return;
    const searchPaths = idx
      ? buildSearchPaths(idx.sdkDir, idx.projectDir)
      : this.ws.searchPaths(document);
    if (!searchPaths) return;
    const resolved = resolveSource(
      hrefAttr.value,
      dirname(document.uri.fsPath),
      searchPaths,
    );
    if (resolved.path) return;
    if (/^(DATA|ART|AUDIO):/i.test(hrefAttr.value.trim())) {
      if (this.sdkUnusable()) return;
    }
    diags.push(
      this.diag(
        new vscode.Range(
          document.positionAt(hrefAttr.valueStart),
          document.positionAt(hrefAttr.valueEnd),
        ),
        t("xi:include target not found: {0}", hrefAttr.value),
        vscode.DiagnosticSeverity.Warning,
        "include-not-found",
      ),
    );
  }

  private checkCrossFileDuplicate(
    type: string,
    id: string,
    document: vscode.TextDocument,
    idx: ModIndex | null,
    diags: vscode.Diagnostic[],
    provisional: boolean,
  ): void {
    if (!idx) return;
    const byType = idx.assets.get(type);
    const defs = mergeLocalAndGlobalDefs(
      idx.local?.assets.get(type)?.get(id.toLowerCase()),
      byType?.get(id.toLowerCase()),
    );
    if (defs.length < 2) return;
    const self = defs.filter(
      (d) =>
        d.origin === "project" &&
        !d.viaInstance &&
        d.file.toLowerCase() === document.uri.fsPath.toLowerCase(),
    );
    if (!self.length) return;
    const others = defs.filter(
      (d) =>
        d.origin === "project" &&
        !d.viaInstance &&
        d.file.toLowerCase() !== document.uri.fsPath.toLowerCase() &&
        d.stream === self[0].stream,
    );
    for (const other of others) {
      const range = self[0].line > 0
        ? new vscode.Range(new vscode.Position(self[0].line - 1, 0), new vscode.Position(self[0].line - 1, 1))
        : new vscode.Range(0, 0, 0, 1);
      diags.push(
        this.diag(
          range,
          t(
            'Duplicate id "{0}" for <{1}> (also defined in {2})',
            id,
            type,
            other.file,
          ) + (provisional ? t(" (based on a partial index)") : ""),
          vscode.DiagnosticSeverity.Error,
          "duplicate-id",
        ),
      );
    }
  }

  private checkValueReferences(
    elType: string | null,
    attrName: string,
    value: string,
    attr: { valueStart: number; valueEnd: number },
    document: vscode.TextDocument,
    idx: ModIndex | null,
    diags: vscode.Diagnostic[],
    provisional: boolean,
  ): void {
    if (!value) return;
    const range = new vscode.Range(
      document.positionAt(attr.valueStart),
      document.positionAt(attr.valueEnd),
    );

    // Undefined $DEFINE references.
    const defineRe = /\$([A-Za-z_][A-Za-z0-9_]*)/g;
    let m: RegExpExecArray | null;
    while ((m = defineRe.exec(value)) !== null) {
      if (
        idx &&
        !(idx.local?.defines.has(m[1].toLowerCase()) ??
          idx.defines.has(m[1].toLowerCase()))
      ) {
        const code = provisional ? "undefined-define-indexing" : "undefined-define";
        diags.push(
          this.diag(
            range,
            t('Undefined define "${0}"', m[1]) +
              (provisional ? t(" (index incomplete — may be a false positive)") : ""),
            vscode.DiagnosticSeverity.Warning,
            code,
          ),
        );
      }
    }

    if (value.startsWith("$") || value.startsWith("=")) return;
    const severity = this.ws.settings.reportUnresolvedReferences;
    if (severity === "none") return;
    if (!idx) return;
    if (!isReferenceAttributeOfType(elType, attrName)) return;
    const targets = resolveReferenceTargetsForType(idx, elType, attrName, value);
    if (targets.length) return;
    const anyDef =
      (idx.local?.assetsById.has(value.toLowerCase()) ?? false) ||
      idx.assetsById.has(value.toLowerCase());
    const attrRef = model
      .attributesOfType(elType)
      .find((a) => a.name === attrName);
    const code = provisional ? "unresolved-reference-indexing" : "unresolved-reference";
    const baseMessage = unresolvedReferenceMessage(
      value,
      anyDef,
      attrRef?.refType ?? null,
      attrRef?.isRef ?? false,
    );
    diags.push(
      this.diag(
        range,
        provisional
          ? baseMessage + t(" (index incomplete — may be a false positive)")
          : baseMessage,
        severity === "warning"
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Information,
        code,
      ),
    );
  }

  private checkContentReferences(
    el: XmlElement,
    elType: string | null,
    document: vscode.TextDocument,
    idx: ModIndex | null,
    diags: vscode.Diagnostic[],
    provisional: boolean,
  ): void {
    // Only simple-content elements carry a text value (simple types and
    // simpleContent complex types); ordinary complex elements' "content" is
    // child markup and must not be scanned for value refs.
    const info = elType ? model.contentInfoOfType(elType) : undefined;
    if (!info) return;
    if (el.selfClosing || el.closeTagStart < 0) return;
    const text = document.getText();
    const raw = text.slice(el.startTagEnd, el.closeTagStart);
    const value = raw.trim();
    if (!value) return;
    const valueStart = el.startTagEnd + raw.indexOf(value);
    const range = new vscode.Range(
      document.positionAt(valueStart),
      document.positionAt(valueStart + value.length),
    );

    // Undefined $DEFINE references.
    const defineRe = /\$([A-Za-z_][A-Za-z0-9_]*)/g;
    let m: RegExpExecArray | null;
    while ((m = defineRe.exec(value)) !== null) {
      if (
        idx &&
        !(
          idx.local?.defines.has(m[1].toLowerCase()) ??
          idx.defines.has(m[1].toLowerCase())
        )
      ) {
        const code = provisional ? "undefined-define-indexing" : "undefined-define";
        diags.push(
          this.diag(
            range,
            t('Undefined define "${0}"', m[1]) +
              (provisional ? t(" (index incomplete — may be a false positive)") : ""),
            vscode.DiagnosticSeverity.Warning,
            code,
          ),
        );
      }
    }

    if (value.startsWith("$") || value.startsWith("=")) return;
    const severity = this.ws.settings.reportUnresolvedReferences;
    if (severity === "none" || !idx) return;
    if (!isReferenceContentType(elType)) return;
    const targets = resolveContentReferenceTargets(idx, elType, value);
    if (targets.length) return;
    const anyDef =
      (idx.local?.assetsById.has(value.toLowerCase()) ?? false) ||
      idx.assetsById.has(value.toLowerCase());
    const refType = info.refType;
    const code = provisional ? "unresolved-reference-indexing" : "unresolved-reference";
    const baseMessage = unresolvedReferenceMessage(
      value,
      anyDef,
      refType ?? null,
      !refType,
    );
    diags.push(
      this.diag(
        range,
        provisional
          ? baseMessage + t(" (index incomplete — may be a false positive)")
          : baseMessage,
        severity === "warning"
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Information,
        code,
      ),
    );
  }

  private checkInclude(
    el: XmlElement,
    document: vscode.TextDocument,
    idx: ModIndex | null,
    diags: vscode.Diagnostic[],
  ): void {
    const typeAttr = el.attrs.find((a) => a.name === "type");
    const sourceAttr = el.attrs.find((a) => a.name === "source");
    if (typeAttr?.hasValue && !["reference", "instance", "all"].includes(typeAttr.value)) {
      diags.push(
        this.diag(
          new vscode.Range(
            document.positionAt(typeAttr.valueStart),
            document.positionAt(typeAttr.valueEnd),
          ),
          t(
            'Invalid Include type "{0}" (expected reference, instance or all)',
            typeAttr.value,
          ),
          vscode.DiagnosticSeverity.Error,
          "include-type",
        ),
      );
    }
    if (!sourceAttr?.hasValue) return;
    const searchPaths = idx
      ? buildSearchPaths(idx.sdkDir, idx.projectDir)
      : this.ws.searchPaths(document);
    if (!searchPaths) return;
    const resolved = resolveSource(
      sourceAttr.value,
      dirname(document.uri.fsPath),
      searchPaths,
    );
    const candidateHit =
      idx?.sourceCandidates.some((c) => c.source === sourceAttr.value) ?? false;
    if (!resolved.path && !candidateHit) {
      // Without a usable SDK, prefixed includes are expected to be missing;
      // report one project-level hint instead of warning on every line.
      if (this.sdkUnusable() && /^(DATA|ART|AUDIO):/i.test(sourceAttr.value.trim())) {
        return;
      }
      diags.push(
        this.diag(
          new vscode.Range(
            document.positionAt(sourceAttr.valueStart),
            document.positionAt(sourceAttr.valueEnd),
          ),
          t("Include target not found: {0}", sourceAttr.value),
          vscode.DiagnosticSeverity.Warning,
          "include-not-found",
        ),
      );
    }
  }

  private diag(
    range: vscode.Range,
    message: string,
    severity: vscode.DiagnosticSeverity,
    code: string,
  ): vscode.Diagnostic {
    const d = new vscode.Diagnostic(range, message, severity);
    d.code = code;
    d.source = "RA3 Mod XML";
    return d;
  }
}

function localName(tag: string): string {
  const idx = tag.lastIndexOf(":");
  return idx >= 0 ? tag.slice(idx + 1) : tag;
}

function unresolvedReferenceMessage(
  value: string,
  anyDef: boolean,
  refType: string | null,
  isRef: boolean,
): string {
  if (anyDef) {
    if (refType) {
      return t(
        'Reference "{0}" has no definition of type `{1}` (ids with the same name exist for other types)',
        value,
        refType,
      );
    }
    if (isRef) {
      return t(
        'Reference "{0}" has no definition of the expected declared type (ids with the same name exist for other types)',
        value,
      );
    }
    return t(
      'Reference "{0}" has no matching definition (ids with the same name exist for other types)',
      value,
    );
  }
  return t('Unresolved reference "{0}" (not found in the current index)', value);
}

function tagRange(document: vscode.TextDocument, el: XmlElement): vscode.Range {
  return new vscode.Range(
    document.positionAt(el.start),
    document.positionAt(el.startTagEnd),
  );
}
