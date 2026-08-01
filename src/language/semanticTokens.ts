import { LineMap, type XmlDocument } from "./xmlParser";

/**
 * Semantic token types used by the highlighting fallback. They are standard
 * vscode token types, so every theme already has colors for them.
 */
export type SemanticTokenType = "type" | "property" | "string";

export interface SemanticTokenRange {
  line: number;
  startChar: number;
  length: number;
  tokenType: SemanticTokenType;
}

/**
 * Builds semantic token ranges from a tolerant parse tree.
 *
 * This is the highlighting fallback for malformed XML: while the TextMate
 * grammar loses structure (e.g. an attribute value whose closing quote has
 * not been typed yet turns the rest of the file into one string), semantic
 * tokens keep element names, attribute names and attribute values colored.
 * The ranges are sorted by position for the vscode encoder.
 */
export function buildSemanticTokenRanges(
  doc: XmlDocument,
  text: string,
): SemanticTokenRange[] {
  const lineMap = new LineMap(text);
  const out: SemanticTokenRange[] = [];

  const push = (offset: number, length: number, tokenType: SemanticTokenType) => {
    if (length <= 0 || offset < 0 || offset + length > text.length) return;
    const pos = lineMap.positionAt(offset);
    out.push({
      line: pos.line,
      startChar: pos.character,
      length,
      tokenType,
    });
  };

  for (const el of doc.elements) {
    // Element name in the start tag.
    push(el.start + 1, el.name.length, "type");
    // Element name in the closing tag (when present).
    if (el.closeTagStart >= 0) {
      push(el.closeTagStart + 2, el.name.length, "type");
    }
    for (const attr of el.attrs) {
      push(attr.nameStart, attr.name.length, "property");
      if (!attr.hasValue) continue;
      // Include the surrounding quotes when available; for an unterminated
      // value quoteEnd is -1 and the token ends at the recovered value end.
      const start = attr.quoteStart >= 0 ? attr.quoteStart : attr.valueStart;
      const end = attr.quoteEnd >= 0 ? attr.quoteEnd : attr.valueEnd;
      push(start, end - start, "string");
    }
  }

  out.sort((a, b) => a.line - b.line || a.startChar - b.startChar);
  return out;
}
