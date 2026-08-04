/**
 * Lightweight XML parser with source offsets.
 *
 * The extension needs exact positions of tags, attributes and values for
 * completions, hover, navigation and diagnostics. fast-xml-parser does not
 * provide offsets, so we use this small purpose-built parser instead. It is
 * deliberately tolerant: malformed documents still produce a partial tree
 * plus a list of errors, so completion keeps working while typing.
 */

export interface XmlAttribute {
  name: string;
  value: string;
  /** Offset of the first character of the name. */
  nameStart: number;
  /** Offset one past the last character of the name. */
  nameEnd: number;
  /** Offset of the first value character (after the opening quote). */
  valueStart: number;
  /** Offset one past the last value character (before the closing quote). */
  valueEnd: number;
  /** Offset of the opening quote. */
  quoteStart: number;
  /** Offset one past the closing quote. */
  quoteEnd: number;
  hasValue: boolean;
  /** True when the value is delimited with double quotes. */
  doubleQuoted: boolean;
}

export interface XmlElement {
  name: string;
  attrs: XmlAttribute[];
  children: XmlElement[];
  parent: XmlElement | null;
  /** Offset of "<". */
  start: number;
  /** Offset one past the ">" of the start tag. */
  startTagEnd: number;
  /** Offset one past the end of the whole element (closing tag or "/>"). */
  end: number;
  selfClosing: boolean;
  /** Offset of "</" of the closing tag, or -1 when self-closing. */
  closeTagStart: number;
  depth: number;
  /**
   * True when the start tag was unterminated and recovered at a line break.
   * Attributes typed on later lines of the same tag are not part of the
   * parsed element; completion re-parses the partial tag up to the cursor.
   */
  recoveredStartTag?: boolean;
}

export interface XmlParseError {
  message: string;
  offset: number;
  line: number;
  character: number;
}

export interface XmlDocument {
  root: XmlElement | null;
  /** All elements in document order (including the root). */
  elements: XmlElement[];
  errors: XmlParseError[];
  /** Offset one past "?>" of the XML declaration, or 0. */
  declarationEnd: number;
}

export interface Position {
  line: number;
  character: number;
}

/**
 * Removes a leading UTF-8 byte-order mark (U+FEFF) so source offsets match
 * the text as editors expose it (VS Code strips the BOM from document text).
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Precomputes line start offsets for offset <-> position conversion. */
export class LineMap {
  private lineStarts: number[] = [0];

  constructor(text: string) {
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) {
        this.lineStarts.push(i + 1);
      }
    }
  }

  positionAt(offset: number): Position {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return { line: lo, character: offset - this.lineStarts[lo] };
  }

  lineStart(line: number): number {
    if (line < 0) return 0;
    if (line >= this.lineStarts.length) return this.lineStarts[this.lineStarts.length - 1];
    return this.lineStarts[line];
  }
}

interface RawTag {
  name: string;
  selfClosing: boolean;
  start: number;
  contentStart: number;
  contentEnd: number;
  end: number;
  attrs: XmlAttribute[];
}

const NAME_RE = /[A-Za-z_][\w:.-]*/y;

export function parseTag(content: string, contentStart: number): RawTag {
  const base = contentStart;
  let j = 0;
  while (j < content.length && /\s/.test(content[j])) {
    j++;
  }
  let name: string;
  NAME_RE.lastIndex = j;
  const m = NAME_RE.exec(content);
  if (!m) {
    name = "";
  } else {
    name = m[0];
  }
  const attrs: XmlAttribute[] = [];
  let i = m ? m.index + name.length : j;
  let selfClosing = false;

  while (i < content.length) {
    // skip whitespace
    while (i < content.length && /\s/.test(content[i])) {
      i++;
    }
    if (i >= content.length) break;
    const c = content[i];
    // The tag content excludes the terminating ">", so a bare "/" (outside
    // quotes) can only be the self-closing marker: "<name .../>".
    if (c === "/") {
      selfClosing = true;
      i++;
      break;
    }
    if (c === ">") {
      i += 1;
      break;
    }
    // attribute name
    const attrNameStart = i;
    while (i < content.length && !/[\s=/>]/.test(content[i])) {
      i++;
    }
    const attrName = content.slice(attrNameStart, i);
    const nameEnd = base + i;
    while (i < content.length && /\s/.test(content[i])) {
      i++;
    }
    let hasValue = false;
    let value = "";
    let valueStart = -1;
    let valueEnd = -1;
    let quoteStart = -1;
    let quoteEnd = -1;
    let doubleQuoted = true;
    if (content[i] === "=") {
      i++;
      while (i < content.length && /\s/.test(content[i])) {
        i++;
      }
      const q = content[i];
      if (q === '"' || q === "'") {
        doubleQuoted = q === '"';
        hasValue = true;
        quoteStart = base + i;
        i++;
        const valueStartLocal = i;
        while (i < content.length && content[i] !== q) {
          i++;
        }
        valueStart = base + valueStartLocal;
        valueEnd = base + i;
        value = content.slice(valueStartLocal, i);
        if (content[i] === q) {
          i++;
          quoteEnd = base + i;
        }
      } else {
        // unquoted value - tolerate
        const vs = i;
        while (i < content.length && !/[\s>]/.test(content[i])) {
          i++;
        }
        value = content.slice(vs, i);
        hasValue = true;
        valueStart = base + vs;
        valueEnd = base + i;
        quoteStart = valueStart;
        quoteEnd = valueEnd;
      }
    }
    attrs.push({
      name: attrName,
      value,
      nameStart: base + attrNameStart,
      nameEnd,
      valueStart,
      valueEnd,
      quoteStart,
      quoteEnd,
      hasValue,
      doubleQuoted,
    });
  }

  return {
    name,
    selfClosing,
    start: base - 1,
    contentStart: base,
    contentEnd: base + i,
    end: base + i,
    attrs,
  };
}

export function parseXml(text: string): XmlDocument {
  const lineMap = new LineMap(text);
  const errors: XmlParseError[] = [];
  const elements: XmlElement[] = [];
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let declarationEnd = 0;
  let i = 0;
  const n = text.length;

  const err = (message: string, offset: number) => {
    const pos = lineMap.positionAt(offset);
    errors.push({ message, offset, line: pos.line, character: pos.character });
  };

  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;
    if (lt > i && stack.length === 0 && errors.length === 0) {
      // text before the root element - ignore unless it is non-whitespace
      const between = text.slice(i, lt);
      if (between.trim() !== "") {
        err("Content is not allowed before the root element", i);
      }
    }
    i = lt;

    // comment
    if (text.startsWith("<!--", i)) {
      const close = text.indexOf("-->", i + 4);
      if (close < 0) {
        err("Unterminated comment", i);
        break;
      }
      i = close + 3;
      continue;
    }
    // CDATA
    if (text.startsWith("<![CDATA[", i)) {
      const close = text.indexOf("]]>", i + 9);
      if (close < 0) {
        err("Unterminated CDATA section", i);
        break;
      }
      i = close + 3;
      continue;
    }
    // DOCTYPE
    if (text.startsWith("<!DOCTYPE", i) || text.startsWith("<!doctype", i)) {
      const close = text.indexOf(">", i);
      if (close < 0) {
        err("Unterminated DOCTYPE", i);
        break;
      }
      i = close + 1;
      continue;
    }
    // processing instruction / declaration
    if (text.startsWith("<?", i)) {
      const close = text.indexOf("?>", i + 2);
      if (close < 0) {
        err("Unterminated processing instruction", i);
        break;
      }
      if (i === 0 && /^<\?xml\s/i.test(text.slice(i, close + 2))) {
        declarationEnd = close + 2;
      }
      i = close + 2;
      continue;
    }
    // closing tag
    if (text.startsWith("</", i)) {
      const gt = text.indexOf(">", i + 2);
      if (gt < 0) {
        err("Unterminated closing tag", i);
        break;
      }
      const name = text.slice(i + 2, gt).trim();
      const top = stack[stack.length - 1];
      if (!top) {
        err(`Unexpected closing tag </${name}>`, i);
      } else if (top.name !== name) {
        err(`Mismatched closing tag: expected </${top.name}>, found </${name}>`, i);
        // recover: find the matching element on the stack if possible
        let idx = stack.length - 1;
        while (idx >= 0 && stack[idx].name !== name) idx--;
        if (idx >= 0) {
          const closingCount = stack.length - 1 - idx;
          for (let k = 0; k < closingCount; k++) {
            const el = stack.pop()!;
            el.end = gt + 1;
            el.closeTagStart = i;
          }
        }
      } else {
        const el = stack.pop()!;
        el.end = gt + 1;
        el.closeTagStart = i;
      }
      i = gt + 1;
      continue;
    }
    // opening tag
    if (text[i + 1] === "!" || text[i + 1] === "?") {
      err("Malformed markup", i);
      i++;
      continue;
    }
    const gt = findTagEnd(text, i + 1);
    if (gt < 0) {
      err("Unterminated start tag", i);
      // Recovery while typing: an attribute value whose closing quote has not
      // been typed yet makes the scanner run to EOF. End the malformed start
      // tag at the first line break (or EOF) so the rest of the document is
      // still parsed and completion/hover keep working for the elements after
      // the broken tag. The missing quote/tag end is still reported above.
      let recoverTo = i + 1;
      while (recoverTo < text.length && text[recoverTo] !== "\n" && text[recoverTo] !== "\r") {
        recoverTo++;
      }
      const content = text.slice(i + 1, recoverTo);
      const raw = parseTag(content, i + 1);
      if (raw.name) {
        const el = buildElement(raw, stack.length);
        el.recoveredStartTag = true;
        elements.push(el);
        if (stack.length === 0) {
          root = root ?? el;
        } else {
          const parent = stack[stack.length - 1];
          parent.children.push(el);
          el.parent = parent;
        }
        stack.push(el);
      }
      i = recoverTo + 1;
      continue;
    }
    const content = text.slice(i + 1, gt);
    const raw = parseTag(content, i + 1);
    raw.end = gt + 1;
    const el = buildElement(raw, stack.length);
    elements.push(el);
    if (stack.length === 0) {
      root = root ?? el;
    } else {
      const parent = stack[stack.length - 1];
      parent.children.push(el);
      el.parent = parent;
    }
    if (!raw.selfClosing) {
      stack.push(el);
    }
    i = gt + 1;
  }

  if (stack.length > 0) {
    for (const el of stack) {
      const pos = lineMap.positionAt(el.start);
      errors.push({
        message: `Element <${el.name}> is never closed`,
        offset: el.start,
        line: pos.line,
        character: pos.character,
      });
      el.end = n;
    }
  }

  return { root, elements, errors, declarationEnd };
}

function findTagEnd(text: string, from: number): number {
  let i = from;
  let quote: string | null = null;
  while (i < text.length) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "<") {
      // A new tag start before the current tag's ">" means the ">" we would
      // find later belongs to that other tag (typically a closing tag after
      // a just-typed "<" in element content). Treat the current tag as
      // unterminated so the parser recovers at the line break: the context
      // stays "content" and the completion range can cover the typed "<".
      return -1;
    } else if (c === ">") {
      return i;
    }
    i++;
  }
  return -1;
}

function buildElement(raw: RawTag, depth: number): XmlElement {
  return {
    name: raw.name,
    attrs: raw.attrs,
    children: [],
    parent: null,
    start: raw.start,
    startTagEnd: raw.end,
    end: raw.selfClosing ? raw.end : -1,
    selfClosing: raw.selfClosing,
    closeTagStart: -1,
    depth,
  };
}

/** Returns the innermost element whose span contains `offset`. */
export function findElementAt(doc: XmlDocument, offset: number): XmlElement | null {
  let best: XmlElement | null = null;
  for (const el of doc.elements) {
    if (el.end < 0) continue;
    if (elementContainsOffset(el, offset)) {
      if (!best || el.depth > best.depth) {
        best = el;
      }
    }
  }
  return best;
}

/**
 * Whether `offset` belongs to an element's span.
 *
 * The end offset is exclusive for a completed element (closing tag or
 * self-closing tag): a cursor right after `</Name>` belongs to the parent's
 * content, not the child. The one exception is an unclosed element whose
 * parser-recovered `end` is the document end: a cursor at EOF is still
 * inside the element being typed.
 */
export function elementContainsOffset(el: XmlElement, offset: number): boolean {
  if (offset < el.start) return false;
  if (offset < el.end) return true;
  if (offset > el.end) return false;
  return !el.selfClosing && el.closeTagStart < 0;
}

export interface TextToken {
  value: string;
  /** Absolute offset of the first character of the token. */
  start: number;
  /** Absolute offset one past the last character of the token. */
  end: number;
}

/**
 * Returns the whitespace-delimited text token inside an element's content
 * that contains `offset`, with absolute source offsets. Used for
 * simple-content elements (e.g. `<CreateObject>CrateDebris_01</CreateObject>`)
 * by completion, hover, navigation and diagnostics. Returns null when the
 * offset is not inside text content (start tag, closing tag, self-closing).
 */
export function textContentTokenAt(
  text: string,
  el: XmlElement,
  offset: number,
): TextToken | null {
  if (el.selfClosing) return null;
  const contentEnd = el.closeTagStart >= 0 ? el.closeTagStart : el.end;
  if (contentEnd <= el.startTagEnd) return null;
  if (offset <= el.startTagEnd || offset > contentEnd) return null;
  const contentStart = el.startTagEnd;
  // A cursor right before the closing tag is still inside the content; clamp
  // the relative position to the content length in that case.
  const rel = Math.min(offset - contentStart, contentEnd - contentStart);
  let tokenStart = rel;
  while (tokenStart > 0 && !/\s/.test(text[contentStart + tokenStart - 1])) {
    tokenStart--;
  }
  let tokenEnd = rel;
  while (
    tokenEnd < contentEnd - contentStart &&
    !/\s/.test(text[contentStart + tokenEnd])
  ) {
    tokenEnd++;
  }
  // The cursor may sit on trailing whitespace or at the closing-tag
  // boundary; trim whitespace so the token is exactly the value word.
  while (tokenEnd > tokenStart && /\s/.test(text[contentStart + tokenEnd - 1])) {
    tokenEnd--;
  }
  if (tokenEnd <= tokenStart) return null;
  return {
    value: text.slice(contentStart + tokenStart, contentStart + tokenEnd),
    start: contentStart + tokenStart,
    end: contentStart + tokenEnd,
  };
}

/** Finds an element by name that contains the offset (including its start tag). */
export function findOpenTagElementAt(doc: XmlDocument, offset: number): XmlElement | null {
  const el = findElementAt(doc, offset);
  if (!el) return null;
  // When the cursor is inside the start tag itself, `el` is already the
  // innermost candidate. If the cursor is before the element's start, use
  // the parent.
  if (offset >= el.start && offset <= el.startTagEnd) return el;
  return el;
}
