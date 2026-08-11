import * as vscode from "vscode";

type L10n = {
  t(message: string, ...args: Array<string | number | boolean>): string;
  t(
    message: string,
    args: Record<string, string | number | boolean>,
  ): string;
};

/**
 * Thin wrapper around VS Code's built-in `l10n.t`.
 *
 * The fallback keeps the message unchanged when no bundle is loaded (for
 * example in unit tests or when the extension runs with the default English
 * locale), so the same call sites work in production and tests.
 */
export function t(
  message: string,
  ...args: Array<string | number | boolean>
): string {
  const l10n = (vscode as unknown as { l10n?: L10n }).l10n;
  if (!l10n?.t) return formatIndexed(message, args);
  try {
    return l10n.t(message, ...args);
  } catch {
    return formatIndexed(message, args);
  }
}

/** Named-placeholder variant of {@link t}. */
export function tN(
  message: string,
  args: Record<string, string | number | boolean>,
): string {
  const l10n = (vscode as unknown as { l10n?: L10n }).l10n;
  if (!l10n?.t) return formatNamed(message, args);
  try {
    return l10n.t(message, args);
  } catch {
    return formatNamed(message, args);
  }
}

function formatIndexed(
  message: string,
  args: Array<string | number | boolean>,
): string {
  return message.replace(/\{(\d+)\}/g, (match, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? match : String(value);
  });
}

function formatNamed(
  message: string,
  args: Record<string, string | number | boolean>,
): string {
  return message.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
    const value = args[name];
    return value === undefined ? match : String(value);
  });
}
