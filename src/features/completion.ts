import * as vscode from "vscode";
import { parseXml, type XmlElement } from "../language/xmlParser";
import { analyzeContext, type CompletionContext } from "../language/context";
import { resolveElementType } from "../language/typeContext";
import * as model from "../model/schemaModel";
import type { ModWorkspace } from "../workspace";
import type { ModIndex, AssetDef } from "../indexer/types";

const MAX_VALUE_ITEMS = 400;

export class Ra3CompletionProvider implements vscode.CompletionItemProvider {
  constructor(private ws: ModWorkspace) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): Promise<vscode.CompletionItem[]> {
    const text = document.getText();
    const offset = document.offsetAt(position);
    const doc = parseXml(text);
    const ctx = analyzeContext(doc, text, offset);
    const idx = this.ws.index;

    switch (ctx.kind) {
      case "element-name":
        return this.elementNameItems(ctx, document, position);
      case "attribute-name":
        return this.attributeNameItems(ctx, document, position);
      case "attribute-value":
        return idx ? this.valueItems(ctx, document, position, idx) : [];
      case "content":
        return idx ? this.contentItems(ctx, document, position, idx) : [];
      default:
        return [];
    }
  }

  // ── Element name ──────────────────────────────────────────────────

  private elementNameItems(
    ctx: CompletionContext,
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    if (ctx.closing) return [];
    const parent = ctx.element?.parent ?? null;
    const names = this.childrenOf(parent);
    if (!names.length) return [];

    const start = ctx.element
      ? document.offsetAt(
          document.positionAt(ctx.element.start + (ctx.closing ? 2 : 1)),
        )
      : document.offsetAt(position);
    const range = new vscode.Range(document.positionAt(start), position);
    const items: vscode.CompletionItem[] = [];
    for (const child of names) {
      const item = new vscode.CompletionItem(child.name, vscode.CompletionItemKind.Field);
      item.range = range;
      const type = model.elementTypeName(child.name);
      const info = type ? model.typeInfo(type) : undefined;
      const docText =
        child.doc ||
        (info?.kind === "complex" ? info.doc : "") ||
        (type ? `Type: ${type}` : "");
      item.documentation = docText ? new vscode.MarkdownString(docText) : undefined;
      item.detail = type ? `RA3 XML · ${type}` : "RA3 XML";
      item.insertText = this.elementSnippet(child.name, type);
      items.push(item);
    }
    return items;
  }

  private childrenOf(
    parent: XmlElement | null,
  ): { name: string; type: string | null; doc: string }[] {
    if (!parent) {
      return [
        { name: "AssetDeclaration", type: null, doc: "Root element of every RA3 asset file" },
      ];
    }
    const parentType = resolveElementType(parent);
    const children = parentType
      ? model.childrenOfType(parentType)
      : model.childrenOfElement(parent.name);
    if (children.length) {
      return children.map((c) => ({ name: c.name, type: c.type, doc: c.doc }));
    }
    return [];
  }

  private elementSnippet(name: string, type: string | null): vscode.SnippetString {
    if (model.isTopLevelElement(name)) {
      return new vscode.SnippetString(`<${name} id="$1">\n\t$0\n</${name}>`);
    }
    const info = type ? model.typeInfo(type) : undefined;
    const hasChildren = info?.kind === "complex" && info.children.length > 0;
    if (hasChildren) {
      return new vscode.SnippetString(`<${name}>\n\t$0\n</${name}>`);
    }
    return new vscode.SnippetString(`<${name} />`);
  }

  // ── Attribute name ────────────────────────────────────────────────

  private attributeNameItems(
    ctx: CompletionContext,
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    const el = ctx.element;
    if (!el) return [];
    const elType = resolveElementType(el);
    const attrs = model.attributesOfType(elType);
    const used = new Set(ctx.existingAttrs.map((a) => a.toLowerCase()));
    const items: vscode.CompletionItem[] = [];

    const wordStart = findAttributeWordStart(document, position, el);
    const range = new vscode.Range(document.positionAt(wordStart), position);

    for (const attr of attrs) {
      if (used.has(attr.name.toLowerCase())) continue;
      const item = new vscode.CompletionItem(attr.name, vscode.CompletionItemKind.Property);
      item.range = range;
      item.sortText = attr.required ? "0" + attr.name : "1" + attr.name;
      const md = new vscode.MarkdownString();
      if (attr.doc) md.appendMarkdown(attr.doc + "\n\n");
      if (attr.required) md.appendMarkdown(`**Required**  \n`);
      if (attr.refType) md.appendMarkdown(`References: \`${attr.refType}\`  \n`);
      if (attr.enumValues.length)
        md.appendMarkdown(`Values: ${attr.enumValues.join(", ")}  \n`);
      if (attr.default != null) md.appendMarkdown(`Default: \`${attr.default}\`  \n`);
      md.appendMarkdown(`Type: \`${attr.type ?? "string"}\``);
      item.documentation = md;
      if (attr.required) {
        item.insertText = attr.name === "id" ? 'id="$1"' : `${attr.name}="$1"`;
      } else {
        item.insertText = `${attr.name}="$1"`;
      }
      item.command = {
        command: "editor.action.triggerSuggest",
        title: "Suggest attribute values",
      };
      items.push(item);
    }

    // Namespace/instance helpers.
    if (!used.has("xai:joinaction")) {
      const j = new vscode.CompletionItem("xai:joinAction", vscode.CompletionItemKind.Property);
      j.range = range;
      j.insertText = 'xai:joinAction="$1"';
      j.detail = "Instance join action";
      j.documentation = new vscode.MarkdownString(
        "Controls how this element merges with the inherited definition: `Replace` or `Remove`.",
      );
      items.push(j);
    }
    if (!used.has("xmlns:xai")) {
      const ns = new vscode.CompletionItem("xmlns:xai", vscode.CompletionItemKind.Property);
      ns.range = range;
      ns.insertText = 'xmlns:xai="uri:ea.com:eala:asset:instance"';
      ns.detail = "xai namespace";
      items.push(ns);
    }
    return items;
  }

  // ── Attribute value ───────────────────────────────────────────────

  private valueItems(
    ctx: CompletionContext,
    document: vscode.TextDocument,
    position: vscode.Position,
    idx: ModIndex,
  ): vscode.CompletionItem[] {
    const el = ctx.element;
    const attr = ctx.attr;
    if (!el || !attr) return [];
    const prefix = ctx.valuePrefix;

    const endOffset = attr.quoteEnd > attr.valueEnd ? attr.valueEnd : document.offsetAt(position);
    const valueRange = new vscode.Range(
      document.positionAt(attr.valueStart),
      document.positionAt(Math.max(attr.valueStart, endOffset)),
    );

    const make = (
      label: string,
      kind: vscode.CompletionItemKind,
      detail: string,
      doc?: string,
    ) => {
      const item = new vscode.CompletionItem(label, kind);
      item.range = valueRange;
      item.insertText = label;
      item.detail = detail;
      if (doc) item.documentation = new vscode.MarkdownString(doc);
      return item;
    };

    const isInclude = el.name === "Include";
    const attrName = attr.name.toLowerCase();

    // Include type / source
    if (isInclude && attrName === "type") {
      return ["reference", "instance", "all"].map((v) =>
        make(v, vscode.CompletionItemKind.EnumMember, "Include type"),
      );
    }
    if (isInclude && attrName === "source") {
      return this.includeSourceItems(idx, prefix, make);
    }
    if (attrName === "xai:joinaction" || attrName === "joinaction") {
      return ["Replace", "Remove"].map((v) =>
        make(v, vscode.CompletionItemKind.EnumMember, "xai:joinAction"),
      );
    }

    const elType = resolveElementType(el);
    const attrInfo = model
      .attributesOfType(elType)
      .find((a) => a.name.toLowerCase() === attrName);

    // inheritFrom: same element type first, then everything.
    if (attrName === "inheritfrom") {
      return this.assetIdItems(idx, el.name, null, prefix, make);
    }

    if (attrInfo?.refType) {
      return this.assetIdItems(idx, null, attrInfo.refType, prefix, make);
    }
    if (attrInfo?.enumValues?.length) {
      return attrInfo.enumValues
        .filter((v) => v.toLowerCase().startsWith(prefix.toLowerCase()))
        .map((v) => make(v, vscode.CompletionItemKind.EnumMember, attrInfo.type ?? "enum"));
    }
    if (attrInfo?.isBoolean) {
      return ["true", "false"]
        .filter((v) => v.startsWith(prefix.toLowerCase()))
        .map((v) => make(v, vscode.CompletionItemKind.Value, "boolean"));
    }
    if (attrInfo?.allowsDefine) {
      return this.defineItems(idx, prefix, make);
    }
    return [];
  }

  private includeSourceItems(
    idx: ModIndex,
    prefix: string,
    make: (label: string, kind: vscode.CompletionItemKind, detail: string, doc?: string) => vscode.CompletionItem,
  ): vscode.CompletionItem[] {
    const lower = prefix.toLowerCase();
    const candidates = idx.sourceCandidates
      .filter((c) => c.source.toLowerCase().includes(lower))
      .slice(0, MAX_VALUE_ITEMS);
    const priority: Record<string, number> = { "": 0, DATA: 1, ART: 2, AUDIO: 3 };
    candidates.sort(
      (a, b) =>
        (priority[a.prefix ?? ""] ?? 4) - (priority[b.prefix ?? ""] ?? 4) ||
        a.source.localeCompare(b.source),
    );
    return candidates.map((c) => {
      const item = make(c.source, vscode.CompletionItemKind.File, "Include source");
      item.detail = c.path;
      item.documentation = new vscode.MarkdownString(
        `\`${c.prefix ?? "relative"}\` · ${c.path}`,
      );
      return item;
    });
  }

  private assetIdItems(
    idx: ModIndex,
    selfType: string | null,
    refType: string | null,
    prefix: string,
    make: (label: string, kind: vscode.CompletionItemKind, detail: string, doc?: string) => vscode.CompletionItem,
  ): vscode.CompletionItem[] {
    const lower = prefix.toLowerCase();
    const scored: { def: AssetDef; score: number }[] = [];

    const consider = (def: AssetDef) => {
      if (!def.id.toLowerCase().startsWith(lower)) return;
      let score = 3;
      if (refType && model.isAssignableTo(def.type, refType)) score = 1;
      if (selfType && model.isAssignableTo(def.type, selfType)) score = 0;
      if (def.origin === "project") score -= 0.2;
      scored.push({ def, score });
    };

    const targetType = selfType ?? refType;
    if (!targetType) {
      for (const list of idx.assetsById.values()) for (const d of list) consider(d);
    } else {
      for (const [typeName, byId] of idx.assets) {
        if (!model.isAssignableTo(typeName, targetType)) continue;
        for (const list of byId.values()) for (const d of list) consider(d);
      }
    }

    scored.sort((a, b) => a.score - b.score || a.def.id.localeCompare(b.def.id));
    return scored.slice(0, MAX_VALUE_ITEMS).map(({ def }) => {
      const origin = def.origin === "manifest" ? `manifest (${def.manifestSource ?? ""})` : def.origin;
      const doc = new vscode.MarkdownString();
      doc.appendCodeblock(def.id);
      doc.appendMarkdown(`**Type**: ${def.type}  \n`);
      if (def.manifestSource) doc.appendMarkdown(`**Source**: ${def.manifestSource}  \n`);
      doc.appendMarkdown(`**Origin**: ${origin}`);
      return make(def.id, vscode.CompletionItemKind.Value, `${def.type} · ${origin}`, doc.value);
    });
  }

  private defineItems(
    idx: ModIndex,
    prefix: string,
    make: (label: string, kind: vscode.CompletionItemKind, detail: string, doc?: string) => vscode.CompletionItem,
  ): vscode.CompletionItem[] {
    const lower = prefix.replace(/^[=$]*/, "").toLowerCase();
    const items: vscode.CompletionItem[] = [];
    for (const [key, defs] of idx.defines) {
      if (!key.includes(lower)) continue;
      const def = defs[0];
      const label = `$${def.name}`;
      const item = make(label, vscode.CompletionItemKind.Constant, "Define", def.value);
      item.insertText = label;
      items.push(item);
    }
    return items.slice(0, MAX_VALUE_ITEMS);
  }

  // ── Element content ───────────────────────────────────────────────

  private contentItems(
    ctx: CompletionContext,
    _document: vscode.TextDocument,
    _position: vscode.Position,
    _idx: ModIndex,
  ): vscode.CompletionItem[] {
    const el = ctx.element;
    if (!el) return [];
    // Reuse element-name suggestions with a plain replacement range.
    const elType = resolveElementType(el);
    const names = elType ? model.childrenOfType(elType) : model.childrenOfElement(el.name);
    const items: vscode.CompletionItem[] = [];
    for (const child of names) {
      const item = new vscode.CompletionItem(child.name, vscode.CompletionItemKind.Field);
      item.insertText = this.elementSnippet(child.name, child.type);
      const type = child.type;
      const info = type ? model.typeInfo(type) : undefined;
      item.detail = type ? `RA3 XML · ${type}` : "RA3 XML";
      const doc = child.doc || (info?.kind === "complex" ? info.doc : "");
      if (doc) item.documentation = new vscode.MarkdownString(doc);
      items.push(item);
    }
    return items;
  }
}

function findAttributeWordStart(
  document: vscode.TextDocument,
  position: vscode.Position,
  el: { start: number },
): number {
  const offset = document.offsetAt(position);
  const tagStart = el.start;
  let i = offset;
  const text = document.getText();
  while (i > tagStart) {
    const c = text[i - 1];
    if (/[\s=<>"/]/.test(c)) break;
    i--;
  }
  return i;
}
