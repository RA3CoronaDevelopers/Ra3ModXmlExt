import type { XmlAttribute, XmlDocument, XmlElement } from "./xmlParser";

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
    if (attr.hasValue && offset >= attr.quoteStart && offset <= attr.quoteEnd) {
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
