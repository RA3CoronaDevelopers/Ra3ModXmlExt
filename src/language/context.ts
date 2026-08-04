import type { XmlAttribute, XmlDocument, XmlElement } from "./xmlParser";
import { parseTag } from "./xmlParser";

export type ContextKind =
  | "element-name"
  | "attribute-name"
  | "attribute-value"
  | "content"
  | "none";

export interface CompletionContext {
  kind: ContextKind;
  /** The element whose start tag the cursor is in (or whose content). */
  element: XmlElement | null;
  /** Set when the cursor is inside a closing tag name ("</..."). */
  closing: boolean;
  /** The attribute being edited (attribute-value context). */
  attr: XmlAttribute | null;
  /** Text between the opening quote and the cursor. */
  valuePrefix: string;
  /** Names of attributes already present on the element. */
  existingAttrs: string[];
}

export function analyzeContext(
  doc: XmlDocument,
  text: string,
  offset: number,
): CompletionContext {
  // Find the innermost element whose span contains the offset.
  let container: XmlElement | null = null;
  for (const el of doc.elements) {
    if (el.end < 0) continue;
    if (offset >= el.start && offset <= el.end) {
      if (!container || el.depth > container.depth) container = el;
    }
  }

  if (!container) return empty("none");

  // Inside the start tag of the element.
  if (offset >= container.start && offset <= container.startTagEnd) {
    return analyzeStartTag(container, text, offset);
  }

  // A start tag that had to be recovered (e.g. an attribute quote is still
  // open) is truncated at the first line break, so attributes typed on later
  // lines of the same tag are not part of the parsed element. Re-parse the
  // partial tag up to the cursor so value/attribute completion keeps working
  // while typing in the malformed tag.
  if (container.recoveredStartTag) {
    return analyzeRecoveredStartTag(container, text, offset);
  }

  // Otherwise the cursor is in element content.
  return {
    kind: "content",
    element: container,
    closing: false,
    attr: null,
    valuePrefix: "",
    existingAttrs: [],
  };
}

/**
 * Classifies the cursor inside a recovered (truncated) start tag by re-parsing
 * the raw tag content up to the cursor. The original element only kept the
 * attributes that fit on its first line; re-parsing the partial text recovers
 * attributes typed on later lines without affecting the rest of the document.
 */
function analyzeRecoveredStartTag(
  el: XmlElement,
  text: string,
  offset: number,
): CompletionContext {
  const raw = parseTag(text.slice(el.start + 1, offset), el.start + 1);
  const partial: XmlElement = {
    name: raw.name,
    attrs: raw.attrs,
    children: [],
    parent: el.parent,
    start: raw.start,
    startTagEnd: offset,
    end: offset,
    selfClosing: raw.selfClosing,
    closeTagStart: -1,
    depth: el.depth,
  };
  return analyzeStartTag(partial, text, offset);
}

function analyzeStartTag(
  el: XmlElement,
  text: string,
  offset: number,
): CompletionContext {
  const closing = text.startsWith("</", el.start);
  const nameStart = el.start + (closing ? 2 : 1);
  const nameEnd = nameStart + el.name.length;
  const existingAttrs = el.attrs.map((a) => a.name);

  if (offset <= nameEnd) {
    return {
      kind: "element-name",
      element: el,
      closing,
      attr: null,
      valuePrefix: "",
      existingAttrs,
    };
  }

  // Inside an attribute value?
  for (const attr of el.attrs) {
    // An unterminated value (quoteEnd < 0) happens while the user is typing
    // the opening quote of a new attribute value; it must still be treated as
    // an attribute-value context so enum/ref/define completions show up.
    if (
      attr.hasValue &&
      attr.quoteStart >= 0 &&
      offset >= attr.quoteStart &&
      (attr.quoteEnd < 0 || offset < attr.quoteEnd)
    ) {
      const start = attr.valueStart;
      const prefix = offset > start ? text.slice(start, offset) : "";
      return {
        kind: "attribute-value",
        element: el,
        closing: false,
        attr,
        valuePrefix: prefix,
        existingAttrs,
      };
    }
  }

  // Right after "=" (no quotes yet) or between attributes.
  const before = text.slice(el.start, offset);
  const trimmed = before.replace(/\s+$/, "");
  if (trimmed.endsWith("=")) {
    return {
      kind: "attribute-value",
      element: el,
      closing: false,
      attr: lastAttrOf(el),
      valuePrefix: "",
      existingAttrs,
    };
  }

  return {
    kind: "attribute-name",
    element: el,
    closing: false,
    attr: null,
    valuePrefix: "",
    existingAttrs,
  };
}

function lastAttrOf(el: XmlElement): XmlAttribute | null {
  return el.attrs.length ? el.attrs[el.attrs.length - 1] : null;
}

function empty(kind: ContextKind): CompletionContext {
  return {
    kind,
    element: null,
    closing: false,
    attr: null,
    valuePrefix: "",
    existingAttrs: [],
  };
}

/**
 * Splits the typed prefix of a whitespace-separated list value (xs:list, e.g.
 * bit flags such as Surfaces="GROUND WATER") into the token being edited and
 * the offset of that token inside the prefix.
 *
 * "GROUND WA" -> { token: "WA", start: 7 }
 * "GROUND "   -> { token: "",  start: 7 }
 * "WA"        -> { token: "WA", start: 0 }
 */
export function splitListValuePrefix(prefix: string): { token: string; start: number } {
  let start = prefix.length;
  while (start > 0 && !/\s/.test(prefix[start - 1])) {
    start--;
  }
  return { token: prefix.slice(start), start };
}
