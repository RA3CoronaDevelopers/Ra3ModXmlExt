import * as vscode from "vscode";
import { dirname } from "node:path";
import { LineMap, type XmlElement } from "../language/xmlParser";
import { resolveElementType } from "../language/typeContext";
import { resolveSource, buildSearchPaths } from "../indexer/includeResolver";
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

export class Ra3Diagnostics {
  private collection: vscode.DiagnosticCollection;

  constructor(private ws: ModWorkspace) {
    this.collection = vscode.languages.createDiagnosticCollection("ra3modxml");
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
          err.message,
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
      if (isTopLevel) {
        const idAttr = el.attrs.find((a) => a.name === "id");
        if (!idAttr || !idAttr.value) {
          diags.push(
            this.diag(
              range,
              `Top-level asset <${local}> requires an id attribute`,
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
                `Duplicate id "${idAttr.value}" for <${local}> (also defined on line ${prev.line})`,
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
      if (settings.diagnoseUnknownElements && isXsdElement) {
        const knownType = model.elementTypeName(local);
        if (!knownType) {
          diags.push(
            this.diag(
              range,
              `Unknown element <${local}> (not in the RA3 XSD model)`,
              vscode.DiagnosticSeverity.Warning,
              "unknown-element",
            ),
          );
        }
      }

      // Attributes.
      if (isXsdElement) {
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
                `Unknown attribute "${aName}" for <${local}>`,
                vscode.DiagnosticSeverity.Warning,
                "unknown-attribute",
              ),
            );
          }

          if (!attr.hasValue) continue;
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
        this.checkContentReferences(el, elType, document, idx, diags, provisional);
      }

      // Include-specific checks.
      if (local === "Include") {
        this.checkInclude(el, document, idx, diags);
      }
    }
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
          `Duplicate id "${id}" for <${type}> (also defined in ${other.file})` +
            (provisional ? " (based on a partial index)" : ""),
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
            `Undefined define "$${m[1]}"` +
              (provisional ? " (index incomplete — may be a false positive)" : ""),
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
    const expected = attrRef?.refType
      ? `of type \`${attrRef.refType}\``
      : attrRef?.isRef
        ? "of the expected declared type"
        : "matching";
    const code = provisional ? "unresolved-reference-indexing" : "unresolved-reference";
    const baseMessage = anyDef
      ? `Reference "${value}" has no definition ${expected} (ids with the same name exist for other types)`
      : `Unresolved reference "${value}" (not found in the current index)`;
    diags.push(
      this.diag(
        range,
        provisional
          ? `${baseMessage} (index incomplete — may be a false positive)`
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
    // Only simple-content elements carry a text value; complex elements'
    // "content" is child markup and must not be scanned for value refs.
    const info = elType ? model.typeInfo(elType) : undefined;
    if (info?.kind !== "simple") return;
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
            `Undefined define "$${m[1]}"` +
              (provisional ? " (index incomplete — may be a false positive)" : ""),
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
    const expected = refType ? `of type \`${refType}\`` : "of the expected declared type";
    const code = provisional ? "unresolved-reference-indexing" : "unresolved-reference";
    const baseMessage = anyDef
      ? `Reference "${value}" has no definition ${expected} (ids with the same name exist for other types)`
      : `Unresolved reference "${value}" (not found in the current index)`;
    diags.push(
      this.diag(
        range,
        provisional
          ? `${baseMessage} (index incomplete — may be a false positive)`
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
          `Invalid Include type "${typeAttr.value}" (expected reference, instance or all)`,
          vscode.DiagnosticSeverity.Error,
          "include-type",
        ),
      );
    }
    if (!sourceAttr?.hasValue) return;
    const searchPaths = idx
      ? buildSearchPaths(idx.sdkDir, idx.projectDir)
      : this.ws.searchPaths();
    if (!searchPaths) return;
    const resolved = resolveSource(
      sourceAttr.value,
      dirname(document.uri.fsPath),
      searchPaths,
    );
    const candidateHit =
      idx?.sourceCandidates.some((c) => c.source === sourceAttr.value) ?? false;
    if (!resolved.path && !candidateHit) {
      diags.push(
        this.diag(
          new vscode.Range(
            document.positionAt(sourceAttr.valueStart),
            document.positionAt(sourceAttr.valueEnd),
          ),
          `Include target not found: ${sourceAttr.value}`,
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

function tagRange(document: vscode.TextDocument, el: XmlElement): vscode.Range {
  return new vscode.Range(
    document.positionAt(el.start),
    document.positionAt(el.startTagEnd),
  );
}
