/**
 * Shallow XML scanner for large art-asset documents (e.g. .w3x).
 *
 * Full XML parsing builds an element tree whose memory footprint is roughly
 * 17x the source text (measured on Corona model files). Model exports like
 * <W3DMesh> contain hundreds of thousands of tiny numeric elements
 * (Vertices/V, Triangles/T, ...) that the extension never needs: the index
 * only consumes top-level asset definitions (name + id), top-level
 * <Includes>, nested <xi:include> targets and <Defines> constants.
 *
 * This scanner performs a single linear pass without building child nodes,
 * so multi-megabyte model files can be indexed in linear time with ~zero
 * retained memory.
 *
 * Pure TypeScript: no vscode dependency, reusable outside the extension.
 */

export interface ShallowAssetRecord {
  /** Top-level element name, e.g. "W3DContainer". */
  name: string;
  /** Value of the id attribute. */
  id: string;
  /** Offset of the first id value character. */
  idValueStart: number;
  /** Offset one past the last id value character. */
  idValueEnd: number;
  /** Offset of the element's "<". */
  start: number;
  /** Offset one past the ">" of the start tag. */
  startTagEnd: number;
}

export interface ShallowIncludeRecord {
  /** "all" | "instance" | "reference", or null when absent/unknown. */
  type: "all" | "instance" | "reference" | null;
  source: string;
  /** Offset of the <Include> element. */
  start: number;
}

export interface ShallowXiIncludeRecord {
  href: string;
  xpointer: string | null;
  /** Offset of the <xi:include> element. */
  start: number;
}

export interface ShallowDefineRecord {
  name: string;
  value: string;
  /** Offset of the <Define> element. */
  start: number;
}

export interface ShallowScanError {
  message: string;
  offset: number;
}

export interface ShallowDocument {
  assets: ShallowAssetRecord[];
  includes: ShallowIncludeRecord[];
  /** <xi:include> elements that are direct children of the root. */
  rootXiIncludes: ShallowXiIncludeRecord[];
  /** <xi:include> elements nested anywhere else in the document. */
  nestedXiIncludes: ShallowXiIncludeRecord[];
  defines: ShallowDefineRecord[];
  errors: ShallowScanError[];
}

interface AttrHit {
  value: string;
  valueStart: number;
  valueEnd: number;
}

/**
 * Matches a complete XML tag while respecting quoted attribute values, so a
 * ">" or "/" inside a value never terminates the tag early.
 */
const TAG_RE = /<(?:"[^"]*"|'[^']*'|[^'"<>])*>/g;

export function scanXmlShallow(text: string): ShallowDocument {
  const errors: ShallowScanError[] = [];
  const assets: ShallowAssetRecord[] = [];
  const includes: ShallowIncludeRecord[] = [];
  const rootXiIncludes: ShallowXiIncludeRecord[] = [];
  const nestedXiIncludes: ShallowXiIncludeRecord[] = [];
  const defines: ShallowDefineRecord[] = [];

  // Depth of the currently open element stack. The document root opens at
  // depth 0 -> 1, so its direct children open when depth === 1.
  let depth = 0;
  let inIncludes = false;
  let inDefines = false;
  let i = 0;

  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;

    // Non-element constructs: comments, CDATA, DOCTYPE and processing
    // instructions are skipped whole so their content never looks like tags.
    if (text.startsWith("<!--", lt)) {
      const close = text.indexOf("-->", lt + 4);
      if (close < 0) {
        errors.push({ message: "Unterminated comment", offset: lt });
        break;
      }
      i = close + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const close = text.indexOf("]]>", lt + 9);
      if (close < 0) {
        errors.push({ message: "Unterminated CDATA section", offset: lt });
        break;
      }
      i = close + 3;
      continue;
    }
    if (text.startsWith("<!", lt)) {
      const close = text.indexOf(">", lt + 2);
      if (close < 0) {
        errors.push({ message: "Unterminated DOCTYPE", offset: lt });
        break;
      }
      i = close + 1;
      continue;
    }
    if (text.startsWith("<?", lt)) {
      const close = text.indexOf("?>", lt + 2);
      if (close < 0) {
        errors.push({ message: "Unterminated processing instruction", offset: lt });
        break;
      }
      i = close + 2;
      continue;
    }

    TAG_RE.lastIndex = lt;
    const m = TAG_RE.exec(text);
    if (!m) {
      errors.push({ message: "Unterminated tag", offset: lt });
      break;
    }
    const tag = m[0];
    const gt = m.index + tag.length - 1;
    const inner = tag.slice(1, -1);
    const closing = inner.startsWith("/");
    const selfClosing = !closing && /\/\s*$/.test(inner);
    const body = closing ? inner.slice(1) : inner;
    let nameEnd = 0;
    while (nameEnd < body.length && !/[\s/>]/.test(body[nameEnd])) nameEnd++;
    const name = body.slice(0, nameEnd);
    const base = lt + 1;

    if (!closing) {
      // Top-level elements (direct children of the root).
      if (depth === 1) {
        inIncludes = name === "Includes";
        inDefines = name === "Defines";
        const idAttr = findAttr(inner, base, "id");
        if (idAttr && idAttr.value) {
          assets.push({
            name,
            id: idAttr.value,
            idValueStart: idAttr.valueStart,
            idValueEnd: idAttr.valueEnd,
            start: lt,
            startTagEnd: gt + 1,
          });
        }
      }
      // <Include> entries inside the top-level <Includes> block.
      if (inIncludes && depth === 2 && name === "Include") {
        const type = findAttr(inner, base, "type");
        const source = findAttr(inner, base, "source");
        if (source?.value) {
          includes.push({
            type:
              type?.value === "all" || type?.value === "instance" || type?.value === "reference"
                ? type.value
                : null,
            source: source.value,
            start: lt,
          });
        }
      }
      // <Define> entries inside the top-level <Defines> block.
      if (inDefines && depth === 2 && name === "Define") {
        const nameAttr = findAttr(inner, base, "name");
        const valueAttr = findAttr(inner, base, "value");
        if (nameAttr?.value) {
          defines.push({ name: nameAttr.value, value: valueAttr?.value ?? "", start: lt });
        }
      }
      // Nested <xi:include> (or any *:include) anywhere in the document.
      if (localName(name) === "include") {
        const href = findAttr(inner, base, "href");
        const xpointer = findAttr(inner, base, "xpointer");
        if (href?.value) {
          const rec: ShallowXiIncludeRecord = {
            href: href.value,
            xpointer: xpointer?.value ?? null,
            start: lt,
          };
          if (depth === 1) rootXiIncludes.push(rec);
          else nestedXiIncludes.push(rec);
        }
      }
      if (!selfClosing) depth++;
    } else {
      depth--;
    }
    i = gt + 1;
  }

  return { assets, includes, rootXiIncludes, nestedXiIncludes, defines, errors };
}

/**
 * Scans the attributes of a tag (its inner text, without "<" and ">") for
 * the first occurrence of `want` and returns its value with absolute offsets
 * (base = offset one past the "<").
 */
function findAttr(inner: string, base: number, want: string): AttrHit | null {
  let i = 0;
  while (i < inner.length) {
    while (i < inner.length && /\s/.test(inner[i])) i++;
    // Self-closing marker or end of tag: no more attributes.
    if (i >= inner.length || inner[i] === "/" || inner[i] === ">") break;
    const nameStart = i;
    while (i < inner.length && !/[\s=/>]/.test(inner[i])) i++;
    const name = inner.slice(nameStart, i);
    while (i < inner.length && /\s/.test(inner[i])) i++;
    if (inner[i] === "=") {
      i++;
      while (i < inner.length && /\s/.test(inner[i])) i++;
      const q = inner[i];
      if (q === '"' || q === "'") {
        const vStart = i + 1;
        const vEnd = inner.indexOf(q, vStart);
        if (vEnd < 0) {
          return name === want ? { value: "", valueStart: -1, valueEnd: -1 } : null;
        }
        if (name === want) {
          return {
            value: inner.slice(vStart, vEnd),
            valueStart: base + vStart,
            valueEnd: base + vEnd,
          };
        }
        i = vEnd + 1;
        continue;
      }
      // Unquoted value (tolerated).
      const vs = i;
      while (i < inner.length && !/[\s>]/.test(inner[i])) i++;
      if (name === want) {
        return { value: inner.slice(vs, i), valueStart: base + vs, valueEnd: base + i };
      }
      continue;
    }
    // Attribute without a value (rare but tolerated).
    if (name === want) return { value: "", valueStart: -1, valueEnd: -1 };
  }
  return null;
}

function localName(name: string): string {
  const idx = name.lastIndexOf(":");
  return idx >= 0 ? name.slice(idx + 1) : name;
}
