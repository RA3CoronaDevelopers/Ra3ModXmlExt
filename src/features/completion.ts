import * as vscode from "vscode";
import type { XmlAttribute, XmlElement } from "../language/xmlParser";
import { textContentTokenAt } from "../language/xmlParser";
import {
  analyzeContext,
  splitListValuePrefix,
  type CompletionContext,
} from "../language/context";
import { resolveElementType } from "../language/typeContext";
import * as model from "../model/schemaModel";
import type { AttributeInfo, SimpleTypeInfo } from "../model/schemaModel";
import { isLocalReferenceAttribute } from "../indexer/refs";
import {
  findContainingGameObject,
  collectLocalIds,
  type LogicalElement,
} from "../indexer/logicalTree";
import type { ModWorkspace } from "../workspace";
import type { ModIndex, AssetDef } from "../indexer/types";
import { t } from "../localize";

const MAX_VALUE_ITEMS = 400;

export class Ra3CompletionProvider implements vscode.CompletionItemProvider {
  constructor(private ws: ModWorkspace) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): Promise<vscode.CompletionItem[] | vscode.CompletionList<vscode.CompletionItem>> {
    if (!this.ws.isRa3Workspace()) return [];
    const text = document.getText();
    const offset = document.offsetAt(position);
    const scope = await this.ws.getScope(document);
    const doc = scope.expanded;
    const ctx = analyzeContext(doc, text, offset);
    const idx = scope.merged;

    switch (ctx.kind) {
      case "element-name":
        return this.elementNameItems(ctx, document, position);
      case "attribute-name":
        return this.attributeNameItems(ctx, document, position);
      case "attribute-value":
        return this.valueItems(ctx, document, position, idx);
      case "content":
        return this.contentItems(ctx, document, position, idx);
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

    // The "<" already exists at the element's start: replace only the name
    // area and insert the tag body WITHOUT a leading "<", otherwise the
    // range text ("<") would also be used as the filter prefix and hide
    // every suggestion.
    const start = ctx.element
      ? ctx.element.start + (ctx.closing ? 2 : 1)
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
        (type ? t("Type: {0}", type) : "");
      item.documentation = docText ? new vscode.MarkdownString(docText) : undefined;
      item.detail = type ? t("RA3 XML · {0}", type) : t("RA3 XML");
      item.insertText = this.elementSnippet(child.name, type, ctx.element == null);
      items.push(item);
    }
    return items;
  }

  private childrenOf(
    parent: XmlElement | null,
  ): { name: string; type: string | null; doc: string }[] {
    if (!parent) {
      return [
        {
          name: "AssetDeclaration",
          type: null,
          doc: t("Root element of every RA3 asset file"),
        },
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

  private elementSnippet(
    name: string,
    type: string | null,
    includeOpenBracket = true,
  ): vscode.SnippetString {
    const open = includeOpenBracket ? "<" : "";
    if (model.isTopLevelElement(name)) {
      return new vscode.SnippetString(`${open}${name} id="$1">\n\t$0\n</${name}>`);
    }
    const info = type ? model.typeInfo(type) : undefined;
    // Simple types hold text content (asset id / enum / define / string), so
    // they need an explicit closing tag and a value placeholder instead of a
    // self-closing tag that can never contain a value.
    if (info?.kind === "simple") {
      return new vscode.SnippetString(`${open}${name}>$1</${name}>`);
    }
    const hasChildren = info?.kind === "complex" && info.children.length > 0;
    if (hasChildren) {
      return new vscode.SnippetString(`${open}${name}>\n\t$0\n</${name}>`);
    }
    return new vscode.SnippetString(`${open}${name} />`);
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

    const text = document.getText();
    const offset = document.offsetAt(position);
    const layout = attributeInsertLayout(text, el, offset);
    const range = new vscode.Range(document.positionAt(layout.rangeStart), position);

    this.ws.log(
      `[completion] attr-name ${el.name} existing=[${ctx.existingAttrs.join(", ")}] ` +
        `range=${layout.rangeStart}..${offset} prefix=${JSON.stringify(layout.prefix)}`,
    );

    for (const attr of attrs) {
      if (used.has(attr.name.toLowerCase())) continue;
      const item = new vscode.CompletionItem(attr.name, vscode.CompletionItemKind.Property);
      item.range = range;
      item.sortText = attr.required ? "0" + attr.name : "1" + attr.name;
      const md = new vscode.MarkdownString();
      if (attr.doc) md.appendMarkdown(attr.doc + "\n\n");
      if (attr.required) md.appendMarkdown(`${t("**Required**")}  \n`);
      if (attr.refType) {
        md.appendMarkdown(`${t("References: `{0}`", attr.refType)}  \n`);
      }
      if (attr.enumValues.length)
        md.appendMarkdown(`${t("Values: {0}", attr.enumValues.join(", "))}  \n`);
      if (attr.default != null) {
        md.appendMarkdown(`${t("Default: `{0}`", attr.default)}  \n`);
      }
      md.appendMarkdown(t("Type: `{0}`", attr.type ?? "string"));
      item.documentation = md;
      const value = this.attributeValuePlaceholder(attr, el);
      item.insertText = new vscode.SnippetString(
        layout.prefix + `${attr.name}="${value.snippet}"`,
      );
      if (value.trigger) {
        item.command = {
          command: "editor.action.triggerSuggest",
          title: t("Suggest attribute values"),
        };
      }
      items.push(item);
    }

    // Namespace/instance helpers.
    if (!used.has("xai:joinaction")) {
      const j = new vscode.CompletionItem("xai:joinAction", vscode.CompletionItemKind.Property);
      j.range = range;
      j.insertText = new vscode.SnippetString(
        layout.prefix + 'xai:joinAction="$1"',
      );
      j.detail = t("Instance join action");
      j.documentation = new vscode.MarkdownString(
        t(
          "Controls how this element merges with the inherited definition: `Replace` or `Remove`.",
        ),
      );
      j.command = {
        command: "editor.action.triggerSuggest",
        title: t("Suggest attribute values"),
      };
      items.push(j);
    }
    if (!used.has("xmlns:xai")) {
      const ns = new vscode.CompletionItem("xmlns:xai", vscode.CompletionItemKind.Property);
      ns.range = range;
      ns.insertText = new vscode.SnippetString(
        layout.prefix + 'xmlns:xai="uri:ea.com:eala:asset:instance"',
      );
      ns.detail = t("xai namespace");
      items.push(ns);
    }
    return items;
  }

  /**
   * Chooses the placeholder/value inserted for a completed attribute:
   * attributes whose value is picked from suggestions (references, enums,
   * lists, booleans, defines, include sources, local ids) keep a `$1`
   * placeholder and re-trigger the value popup; scalar attributes get the XSD
   * default (or a type-appropriate example such as `0d` for angles or `0s`
   * for times) so the completed value shows the expected format immediately.
   */
  private attributeValuePlaceholder(
    attr: AttributeInfo,
    el: XmlElement,
  ): { snippet: string; trigger: boolean } {
    if (
      attr.isBoolean ||
      attr.isList ||
      attr.enumValues.length > 0 ||
      attr.refType != null ||
      attr.isRef ||
      attr.name === "inheritFrom" ||
      (el.name === "Include" && attr.name === "source")
    ) {
      return { snippet: "$1", trigger: true };
    }
    if (attr.name === "id") {
      // `id` is the element's own definition point; nothing to suggest, but
      // keep the placeholder for the user to type the id.
      return { snippet: "$1", trigger: false };
    }
    if (attr.default != null && attr.default !== "") {
      return { snippet: attr.default, trigger: false };
    }
    const example = DEFAULT_VALUE_BY_TYPE[(attr.type ?? "").toLowerCase()];
    if (example != null) return { snippet: example, trigger: false };
    return { snippet: "$1", trigger: false };
  }

  // ── Attribute value ───────────────────────────────────────────────

  private valueItems(
    ctx: CompletionContext,
    document: vscode.TextDocument,
    position: vscode.Position,
    idx: ModIndex | null,
  ): vscode.CompletionItem[] | vscode.CompletionList<vscode.CompletionItem> {
    const el = ctx.element;
    const attr = ctx.attr;
    if (!el || !attr) return [];
    const rawPrefix = ctx.valuePrefix;

    const attrName = attr.name.toLowerCase();
    const elType = resolveElementType(el);
    const attrInfo = model
      .attributesOfType(elType)
      .find((a) => a.name.toLowerCase() === attrName);

    // xs:list values (bit flags such as Surfaces="GROUND WATER") are
    // whitespace-separated: only the token currently being edited is used for
    // filtering, and the replacement range covers that token instead of the
    // whole value.
    const isList = attrInfo?.isList === true;
    const seg = isList
      ? splitListValuePrefix(rawPrefix)
      : { token: rawPrefix, start: 0 };
    const prefix = seg.token;

    const valueStartOffset =
      attr.valueStart >= 0 ? attr.valueStart : document.offsetAt(position);
    const cursorOffset = document.offsetAt(position);
    // For list values the replacement must cover only the segment being
    // edited; extending to the end of the whole value would delete the flags
    // after the cursor when inserting in the middle of an existing list.
    const endOffset = isList
      ? Math.min(cursorOffset, attr.valueEnd >= 0 ? attr.valueEnd : cursorOffset)
      : attr.quoteEnd > attr.valueEnd
        ? attr.valueEnd
        : cursorOffset;
    const rangeStart = valueStartOffset + seg.start;
    const valueRange = new vscode.Range(
      document.positionAt(rangeStart),
      document.positionAt(Math.max(rangeStart, endOffset)),
    );

    const make = (
      label: string,
      kind: vscode.CompletionItemKind,
      detail: string,
      doc?: string,
      range?: vscode.Range,
      insertText?: string,
    ) => {
      const item = new vscode.CompletionItem(label, kind);
      item.range = range ?? valueRange;
      item.insertText = insertText ?? label;
      item.detail = detail;
      if (doc) item.documentation = new vscode.MarkdownString(doc);
      return item;
    };

    const isInclude = el.name === "Include";

    // Include type / source
    if (isInclude && attrName === "type") {
      return ["reference", "instance", "all"].map((v) =>
        make(v, vscode.CompletionItemKind.EnumMember, t("Include type")),
      );
    }
    if (isInclude && attrName === "source") {
      if (!idx) return [];
      return this.includeSourceItems(idx, prefix, make);
    }
    if (attrName === "xai:joinaction" || attrName === "joinaction") {
      return ["Replace", "Remove"].map((v) =>
        make(v, vscode.CompletionItemKind.EnumMember, t("xai:joinAction")),
      );
    }

    // inheritFrom: same element type first, then everything.
    if (attrName === "inheritfrom") {
      if (!idx) return [];
      return this.assetIdItems(idx, el.name, null, prefix, make);
    }

    // `id` attributes are definitions and Poid attributes are pipeline-local
    // references; offering global asset ids for them would be wrong.
    if (attrInfo && isLocalReferenceAttribute(elType, attr.name)) {
      if (attrName === "id") return [];
      return this.localIdItems(el as LogicalElement, prefix, make);
    }

    if (attrInfo?.refType) {
      if (!idx) return [];
      return this.assetIdItems(idx, null, attrInfo.refType, prefix, make);
    }
    if (attrInfo?.enumValues?.length) {
      if (attrInfo.isList) {
        return this.listEnumItems(attrInfo, rawPrefix, seg, valueRange, make);
      }
      return attrInfo.enumValues
        .filter((v) => v.toLowerCase().startsWith(prefix.toLowerCase()))
        .map((v) =>
          make(
            v,
            vscode.CompletionItemKind.EnumMember,
            attrInfo.type ?? t("enum"),
          ),
        );
    }
    if (attrInfo?.isBoolean) {
      return ["true", "false"]
        .filter((v) => v.startsWith(prefix.toLowerCase()))
        .map((v) => make(v, vscode.CompletionItemKind.Value, t("boolean")));
    }
    if (idx && attrInfo?.allowsDefine) {
      return this.defineItems(idx, prefix, make);
    }
    return [];
  }

  /**
   * Completions for xs:list enum values (whitespace-separated bit flags).
   *
   * Only the segment being edited is used for filtering, and values already
   * present earlier in the list are excluded so adding a flag never re-offers
   * an existing one. When the current segment is already a complete flag and
   * no other flag extends it (e.g. "GROUND" -> "GROUND_EDGE" would disable
   * this), the remaining flags are offered as insertions after the cursor
   * (" FLAG") so flags can be appended to an already-closed value.
   */
  private listEnumItems(
    attrInfo: { enumValues: string[]; type?: string | null },
    rawPrefix: string,
    seg: { token: string; start: number },
    valueRange: vscode.Range,
    make: (
      label: string,
      kind: vscode.CompletionItemKind,
      detail: string,
      doc?: string,
      range?: vscode.Range,
      insertText?: string,
    ) => vscode.CompletionItem,
  ): vscode.CompletionItem[] {
    const used = new Set(
      rawPrefix
        .slice(0, seg.start)
        .split(/\s+/)
        .map((t) => t.toLowerCase())
        .filter(Boolean),
    );
    const token = seg.token.toLowerCase();
    const exact = token !== "" && attrInfo.enumValues.some((v) => v.toLowerCase() === token);
    const extendable = attrInfo.enumValues.some(
      (v) => v.toLowerCase().startsWith(token) && v.toLowerCase() !== token,
    );
    const append = exact && !extendable;
    const range = append
      ? new vscode.Range(valueRange.end, valueRange.end)
      : valueRange;
    const filtered = attrInfo.enumValues.filter((v) => {
      const lower = v.toLowerCase();
      if (used.has(lower)) return false;
      if (append) return lower !== token;
      if (exact && lower === token) return false;
      return lower.startsWith(token);
    });
    return filtered.map((v) =>
      make(
        v,
        vscode.CompletionItemKind.EnumMember,
        attrInfo.type ?? t("enum"),
        undefined,
        range,
        append ? ` ${v}` : v,
      ),
    );
  }

  private includeSourceItems(
    idx: ModIndex,
    prefix: string,
    make: (label: string, kind: vscode.CompletionItemKind, detail: string, doc?: string) => vscode.CompletionItem,
  ): vscode.CompletionItem[] | vscode.CompletionList<vscode.CompletionItem> {
    const lower = prefix.toLowerCase();
    const candidates = idx.sourceCandidates.filter((c) =>
      c.source.toLowerCase().includes(lower),
    );
    const priority: Record<string, number> = { "": 0, DATA: 1, ART: 2, AUDIO: 3 };
    candidates.sort(
      (a, b) =>
        (priority[a.prefix ?? ""] ?? 4) - (priority[b.prefix ?? ""] ?? 4) ||
        a.source.localeCompare(b.source),
    );
    const items = candidates.map((c) => {
      const item = make(
        c.source,
        vscode.CompletionItemKind.File,
        t("Include source"),
      );
      item.detail = c.path;
      item.documentation = new vscode.MarkdownString(
        t("`{0}` · {1}", c.prefix ?? t("relative"), c.path),
      );
      return item;
    });
    return this.limitItems(items, items.length);
  }

  private assetIdItems(
    idx: ModIndex,
    selfType: string | null,
    refType: string | null,
    prefix: string,
    make: (label: string, kind: vscode.CompletionItemKind, detail: string, doc?: string) => vscode.CompletionItem,
  ): vscode.CompletionItem[] | vscode.CompletionList<vscode.CompletionItem> {
    const lower = prefix.toLowerCase();
    // Deduplicate by id: the same asset can be defined in several places at
    // once (current file's local overlay + global index, project XML +
    // compiled manifest, or an override). Showing one completion entry per
    // id is enough; the other definitions are listed in the documentation.
    // Definitions are still de-duplicated by (type, id, file, line) so the
    // same record found through both local and global maps is not repeated
    // inside a single entry either.
    const seen = new Set<string>();
    const byId = new Map<
      string,
      { best: { def: AssetDef; score: number }; extras: AssetDef[] }
    >();

    const consider = (def: AssetDef) => {
      const defKey = `${def.type}:${def.id.toLowerCase()}:${def.file}:${def.line}`;
      if (seen.has(defKey)) return;
      seen.add(defKey);
      const idKey = def.id.toLowerCase();
      if (!idKey.startsWith(lower)) return;
      let score = 3;
      if (refType && model.isAssignableTo(def.type, refType)) score = 1;
      if (selfType && model.isAssignableTo(def.type, selfType)) score = 0;
      if (def.origin === "project") score -= 0.2;
      if (def.stream === "local") score -= 0.4;
      const entry = byId.get(idKey);
      if (!entry) {
        byId.set(idKey, { best: { def, score }, extras: [] });
        return;
      }
      if (score < entry.best.score) {
        entry.extras.push(entry.best.def);
        entry.best = { def, score };
      } else {
        entry.extras.push(def);
      }
    };

    const targetType = selfType ?? refType;
    const localAssets = idx.local?.assets;
    const localById = idx.local?.assetsById;
    if (localAssets || localById) {
      if (!targetType) {
        for (const list of localById!.values()) for (const d of list) consider(d);
      } else {
        for (const [typeName, byId] of localAssets!) {
          if (!model.isAssignableTo(typeName, targetType)) continue;
          for (const list of byId.values()) for (const d of list) consider(d);
        }
      }
    }
    if (!targetType) {
      for (const list of idx.assetsById.values()) for (const d of list) consider(d);
    } else {
      for (const [typeName, byId] of idx.assets) {
        if (!model.isAssignableTo(typeName, targetType)) continue;
        for (const list of byId.values()) for (const d of list) consider(d);
      }
    }

    const entries = [...byId.values()];
    const top = topScoredDefs(
      entries.map((e) => e.best),
      MAX_VALUE_ITEMS,
    );
    const items = top.map(({ def }) => {
      const originLabel = (d: AssetDef) =>
        d.origin === "manifest"
          ? d.manifestSource
            ? t("manifest ({0})", d.manifestSource)
            : t("manifest")
          : originLabelText(d.origin);
      const origin = originLabel(def);
      const doc = new vscode.MarkdownString();
      doc.appendCodeblock(def.id);
      doc.appendMarkdown(`${t("**Type**: {0}", def.type)}  \n`);
      if (def.manifestSource) {
        doc.appendMarkdown(`${t("**Source**: {0}", def.manifestSource)}  \n`);
      }
      doc.appendMarkdown(t("**Origin**: {0}", origin));
      for (const extra of byId.get(def.id.toLowerCase())?.extras ?? []) {
        doc.appendMarkdown(
          `\n\n${t("Also defined as **{0}** · {1}", extra.type, originLabel(extra))}`,
        );
      }
      return make(
        def.id,
        vscode.CompletionItemKind.Value,
        t("{0} · {1}", def.type, origin),
        doc.value,
      );
    });
    return this.limitItems(items, byId.size);
  }

  private defineItems(
    idx: ModIndex,
    prefix: string,
    make: (label: string, kind: vscode.CompletionItemKind, detail: string, doc?: string) => vscode.CompletionItem,
  ): vscode.CompletionItem[] | vscode.CompletionList<vscode.CompletionItem> {
    const lower = prefix.replace(/^[=$]*/, "").toLowerCase();
    const items: vscode.CompletionItem[] = [];
    // The same define can be visible through both the local overlay and the
    // global index; show one entry per name (local definitions win because
    // they are iterated first).
    const seen = new Set<string>();
    for (const defines of [idx.local?.defines, idx.defines]) {
      if (!defines) continue;
      for (const [key, defs] of defines) {
        if (!key.includes(lower)) continue;
        const def = defs[0];
        const dedupe = def.name.toLowerCase();
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const label = `$${def.name}`;
        const item = make(
          label,
          vscode.CompletionItemKind.Constant,
          t("Define"),
          def.value,
        );
        item.insertText = label;
        items.push(item);
      }
    }
    return this.limitItems(items, items.length);
  }

  private localIdItems(
    el: LogicalElement,
    prefix: string,
    make: (label: string, kind: vscode.CompletionItemKind, detail: string, doc?: string) => vscode.CompletionItem,
  ): vscode.CompletionItem[] | vscode.CompletionList<vscode.CompletionItem> {
    const root = findContainingGameObject(el);
    if (!root) return [];
    const lower = prefix.toLowerCase();
    const items: vscode.CompletionItem[] = [];
    for (const { id } of collectLocalIds(root)) {
      if (!id.toLowerCase().startsWith(lower)) continue;
      items.push(
        make(
          id,
          vscode.CompletionItemKind.Value,
          t("local module"),
          t(
            "Pipeline-local id in the enclosing GameObject (includes xi:include targets).",
          ),
        ),
      );
    }
    return this.limitItems(items, items.length);
  }

  /**
   * VS Code filters the returned items client-side while the user keeps
   * typing. Once the result is capped, the list must be marked incomplete so
   * the provider is asked again with the narrower prefix; otherwise a wanted
   * id (e.g. CrateDebris_01) can be silently cut off behind the first 400
   * alphabetically-earlier candidates and never reappear.
   */
  private limitItems<T extends vscode.CompletionItem>(
    items: T[],
    total: number,
  ): T[] | vscode.CompletionList<T> {
    if (total <= MAX_VALUE_ITEMS) return items;
    return new vscode.CompletionList(items.slice(0, MAX_VALUE_ITEMS), true);
  }

  // ── Element content ───────────────────────────────────────────────

  private contentItems(
    ctx: CompletionContext,
    document: vscode.TextDocument,
    position: vscode.Position,
    idx: ModIndex | null,
  ): vscode.CompletionItem[] | vscode.CompletionList<vscode.CompletionItem> {
    const el = ctx.element;
    if (!el) return [];
    const elType = resolveElementType(el);
    const info = elType ? model.typeInfo(elType) : undefined;

    // Simple-content element: the text between the tags is the value itself
    // (e.g. <CreateObject>CrateDebris_01</CreateObject>), so offer value
    // completions (asset ids / enums / defines) instead of child elements.
    if (info?.kind === "simple") {
      return this.simpleContentItems(el, elType, info, document, position, idx);
    }

    return this.contentChildItems(el, document, position);
  }

  private simpleContentItems(
    el: XmlElement,
    elType: string | null,
    info: SimpleTypeInfo,
    document: vscode.TextDocument,
    position: vscode.Position,
    idx: ModIndex | null,
  ): vscode.CompletionItem[] | vscode.CompletionList<vscode.CompletionItem> {
    const text = document.getText();
    const offset = document.offsetAt(position);
    const token = textContentTokenAt(text, el, offset);
    const prefix = token ? text.slice(token.start, Math.min(offset, token.end)) : "";
    const rawPrefix = text.slice(el.startTagEnd, offset);
    const isList = info.isList === true;
    const seg = isList
      ? splitListValuePrefix(rawPrefix)
      : { token: prefix, start: token ? token.start - el.startTagEnd : 0 };
    const rangeStart = token ? token.start : offset;
    const valueRange = new vscode.Range(
      document.positionAt(rangeStart),
      document.positionAt(Math.max(rangeStart, offset)),
    );
    const make = (
      label: string,
      kind: vscode.CompletionItemKind,
      detail: string,
      doc?: string,
      range?: vscode.Range,
      insertText?: string,
    ) => {
      const item = new vscode.CompletionItem(label, kind);
      item.range = range ?? valueRange;
      item.insertText = insertText ?? label;
      item.detail = detail;
      if (doc) item.documentation = new vscode.MarkdownString(doc);
      return item;
    };

    // Typed asset references only (isRef without refType is used by real
    // data for shader constants / mesh sub-object names, not global ids).
    if (info.refType) {
      if (!idx) return [];
      return this.assetIdItems(idx, null, info.refType, seg.token, make);
    }
    if (info.enumValues.length) {
      if (isList) return this.listEnumItems(info, rawPrefix, seg, valueRange, make);
      return info.enumValues
        .filter((v) => v.toLowerCase().startsWith(seg.token.toLowerCase()))
        .map((v) =>
          make(
            v,
            vscode.CompletionItemKind.EnumMember,
            elType ?? t("enum"),
          ),
        );
    }
    if (idx && info.allowsDefine) {
      return this.defineItems(idx, seg.token, make);
    }
    return [];
  }

  private contentChildItems(
    el: XmlElement,
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    const elType = resolveElementType(el);
    const names = elType ? model.childrenOfType(elType) : model.childrenOfElement(el.name);
    const items: vscode.CompletionItem[] = [];
    if (!names.length) return items;

    const text = document.getText();
    const offset = document.offsetAt(position);
    // When the user already typed "<" (optionally followed by a partial
    // name), keep that "<" and replace only the name area; the inserted
    // snippet then has no leading "<" so the range text stays a valid
    // filter prefix ("", "Cr", ...) instead of "<" (which would hide every
    // item). Without a typed "<" the full "<Name>…</Name>" is inserted.
    const { rangeStart, typedOpen } = contentElementRange(text, offset);
    const range = new vscode.Range(document.positionAt(rangeStart), position);

    for (const child of names) {
      const item = new vscode.CompletionItem(child.name, vscode.CompletionItemKind.Field);
      item.range = range;
      item.insertText = this.elementSnippet(child.name, child.type, !typedOpen);
      const type = child.type;
      const info = type ? model.typeInfo(type) : undefined;
      item.detail = type ? t("RA3 XML · {0}", type) : t("RA3 XML");
      const doc = child.doc || (info?.kind === "complex" ? info.doc : "");
      if (doc) item.documentation = new vscode.MarkdownString(doc);
      if (info?.kind === "simple" && this.simpleContentValueKind(info)) {
        item.command = {
          command: "editor.action.triggerSuggest",
          title: t("Suggest content value"),
        };
      }
      items.push(item);
    }
    return items;
  }

  private simpleContentValueKind(info: SimpleTypeInfo): boolean {
    return (
      info.refType != null ||
      info.enumValues.length > 0 ||
      info.allowsDefine
    );
  }
}

interface ScoredDef {
  def: AssetDef;
  score: number;
}

function originLabelText(origin: AssetDef["origin"]): string {
  switch (origin) {
    case "project":
      return t("project");
    case "sdk":
      return t("SDK");
    case "manifest":
      return t("manifest");
    default:
      return origin;
  }
}

function compareScoredDefs(a: ScoredDef, b: ScoredDef): number {
  return a.score - b.score || a.def.id.localeCompare(b.def.id);
}

/**
 * Returns the best `limit` scored definitions without sorting the whole
 * candidate list. A max-heap keeps the worst item of the current top set at
 * the root, so every additional candidate only needs an O(log limit) check.
 */
function topScoredDefs(scored: ScoredDef[], limit: number): ScoredDef[] {
  if (scored.length <= limit) {
    scored.sort(compareScoredDefs);
    return scored;
  }
  const better = (a: ScoredDef, b: ScoredDef) => compareScoredDefs(a, b) < 0;
  const heap: ScoredDef[] = [];
  const swap = (i: number, j: number) => {
    const t = heap[i];
    heap[i] = heap[j];
    heap[j] = t;
  };
  const siftUp = (i: number) => {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (better(heap[i], heap[parent])) {
        swap(i, parent);
        i = parent;
      } else {
        break;
      }
    }
  };
  const siftDown = (i: number) => {
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let worst = i;
      if (left < heap.length && better(heap[left], heap[worst])) worst = left;
      if (right < heap.length && better(heap[right], heap[worst])) worst = right;
      if (worst === i) break;
      swap(i, worst);
      i = worst;
    }
  };
  for (const entry of scored) {
    if (heap.length < limit) {
      heap.push(entry);
      siftUp(heap.length - 1);
    } else if (better(entry, heap[0])) {
      heap[0] = entry;
      siftDown(0);
    }
  }
  heap.sort(compareScoredDefs);
  return heap;
}

/**
 * Replacement range for a child-element completion in element content:
 * - when the user typed "<" (optionally followed by a partial name), the
 *   "<" is kept and the range covers the name area after it;
 * - a partial name typed without "<" is replaced as a word;
 * - whitespace-only content leaves the range empty at the cursor.
 * Typing a closing tag ("</" / "</Name") never suggests child elements.
 */
function contentElementRange(
  text: string,
  offset: number,
): { rangeStart: number; typedOpen: boolean } {
  let j = offset;
  while (j > 0 && /[ \t]/.test(text[j - 1])) j--;
  let i = j;
  while (i > 0 && /[A-Za-z0-9_:.-]/.test(text[i - 1])) i--;
  if (i >= 2 && text.slice(i - 2, i) === "</") {
    return { rangeStart: offset, typedOpen: false };
  }
  if (i > 0 && text[i - 1] === "<") {
    return { rangeStart: i, typedOpen: true };
  }
  if (i < j) return { rangeStart: i, typedOpen: false };
  return { rangeStart: offset, typedOpen: false };
}

interface AttributeInsertLayout {
  /** Offset where the completed attribute name starts replacing the text. */
  rangeStart: number;
  /** Text to insert before the attribute name (space / newline + indent). */
  prefix: string;
}

/**
 * Computes the insertion layout for an attribute-name completion:
 * - a leading space when the cursor sits directly against a closing quote;
 * - a plain newline when the element's attributes are laid out one per line
 *   (the editor supplies the new line's base indentation itself; embedding
 *   our own indent here would be ADDED on top of it, e.g. 3+3=6, 6+3=9);
 * - replacing the current line's whitespace with that indentation when the
 *   user already started a new line.
 *
 * The indentation anchor is deliberately NOT the last parsed attribute:
 * a half-typed attribute name on the cursor's new line has no value yet, and
 * using its line indentation would copy the editor's own auto-indent (which
 * can grow line by line) into every inserted attribute. Instead we use the
 * first complete attribute that starts on its own line, which is stable and
 * pre-existing, and only fall back to the last complete attribute when the
 * whole element is inline.
 */
function attributeInsertLayout(
  text: string,
  el: XmlElement,
  offset: number,
): AttributeInsertLayout {
  const wordStart = findAttributeWordStart(text, offset, el.start);
  const attrs = el.attrs;
  const complete = attrs.filter((a) => a.hasValue);
  // Only attributes that end before the cursor decide whether the completed
  // attribute is already on its own line. The tag's last complete attribute
  // may still be AFTER the cursor when the user inserts a new attribute in
  // the middle of a one-per-line tag; using it here would wrongly re-wrap.
  const beforeCursor = complete.filter((a) => attributeEndOffset(a) <= offset);
  const last = beforeCursor.length ? beforeCursor[beforeCursor.length - 1] : null;
  const lastEnd = last ? attributeEndOffset(last) : -1;
  const alreadyOnNewLine =
    lastEnd >= 0
      ? text.slice(lastEnd, offset).includes("\n")
      : text.slice(el.start + 1 + el.name.length, offset).includes("\n");

  // Canonical indent anchor: the first complete attribute that starts on its
  // own line. Fall back to the last complete attribute for inline elements.
  let anchor: XmlAttribute | null = null;
  let onePerLine = false;
  let prevEnd = el.start + 1 + el.name.length;
  for (const a of complete) {
    if (text.slice(prevEnd, a.nameStart).includes("\n")) {
      anchor = a;
      onePerLine = true;
      break;
    }
    prevEnd = attributeEndOffset(a);
  }
  if (!anchor && complete.length) anchor = complete[complete.length - 1];
  const indent = anchor
    ? text.slice(0, anchor.nameStart).match(/[ \t]*$/)?.[0] ?? ""
    : "";

  if (alreadyOnNewLine) {
    // The attribute being completed is already on its own line: never insert
    // another newline. In one-per-line files align with the canonical indent;
    // in inline files keep whatever indentation the user already typed.
    if (onePerLine) {
      const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
      return { rangeStart: lineStart, prefix: indent };
    }
    return { rangeStart: wordStart, prefix: "" };
  }
  // The cursor sits on the same line as the element name or a complete
  // attribute: the completed attribute would be the second one on that line.
  if (onePerLine) {
    // Insert on a new line. The editor adds the current line's indentation
    // to the new line, so we must NOT embed our own indent here (it would
    // compound). If whitespace was typed between the previous attribute and
    // the cursor (e.g. a space used to trigger the suggestion popup), consume
    // it so it does not linger as a trailing space.
    const wsStart =
      lastEnd >= 0 &&
      wordStart > lastEnd &&
      /^[ \t]*$/.test(text.slice(lastEnd, wordStart))
        ? lastEnd
        : wordStart;
    return { rangeStart: wsStart, prefix: "\n" };
  }
  const needsSpace = wordStart > el.start + 1 && !/\s/.test(text[wordStart - 1]);
  return { rangeStart: wordStart, prefix: needsSpace ? " " : "" };
}

function attributeEndOffset(attr: XmlAttribute): number {
  return attr.quoteEnd >= 0 ? attr.quoteEnd : attr.nameEnd;
}

function findAttributeWordStart(text: string, offset: number, tagStart: number): number {
  let i = offset;
  while (i > tagStart) {
    const c = text[i - 1];
    if (/[\s=<>"/]/.test(c)) break;
    i--;
  }
  return i;
}

/** Type-appropriate example values for common RA3 XSD scalar types. */
const DEFAULT_VALUE_BY_TYPE: Record<string, string> = {
  angle: "0d",
  time: "0s",
  velocity: "0.0",
  percentage: "100%",
  sagereal: "0.0",
  sageint: "0",
  sageunsignedint: "0",
  float: "0.0",
  double: "0.0",
  int: "0",
  unsignedint: "0",
  unsignedbyte: "0",
  byte: "0",
  short: "0",
  long: "0",
  decimal: "0.0",
};
