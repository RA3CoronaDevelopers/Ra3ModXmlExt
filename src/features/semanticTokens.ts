import * as vscode from "vscode";
import { parseXml } from "../language/xmlParser";
import { buildSemanticTokenRanges } from "../language/semanticTokens";
import type { ModWorkspace } from "../workspace";

const TOKEN_TYPES = ["type", "property", "string"] as const;

export const RA3_SEMANTIC_TOKENS_LEGEND = new vscode.SemanticTokensLegend([
  ...TOKEN_TYPES,
]);

/**
 * Highlighting fallback for malformed XML.
 *
 * While the document is well-formed, the built-in TextMate XML grammar colors
 * it as usual and this provider returns no tokens, so nothing changes. When
 * parsing reports errors (e.g. an attribute value whose closing quote has not
 * been typed yet), the TextMate structure is lost, and these semantic tokens
 * keep element names, attribute names and values colored.
 */
export class Ra3SemanticTokensProvider
  implements vscode.DocumentSemanticTokensProvider
{
  constructor(private ws: ModWorkspace) {}

  async provideDocumentSemanticTokens(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): Promise<vscode.SemanticTokens> {
    if (!this.ws.isRa3Workspace()) {
      return new vscode.SemanticTokens(new Uint32Array(0));
    }
    const text = document.getText();
    const doc = parseXml(text);
    if (doc.errors.length === 0) {
      return new vscode.SemanticTokens(new Uint32Array(0));
    }
    const ranges = buildSemanticTokenRanges(doc, text);
    const builder = new vscode.SemanticTokensBuilder(RA3_SEMANTIC_TOKENS_LEGEND);
    for (const r of ranges) {
      builder.push(
        new vscode.Range(r.line, r.startChar, r.line, r.startChar + r.length),
        r.tokenType,
      );
    }
    return builder.build();
  }
}
