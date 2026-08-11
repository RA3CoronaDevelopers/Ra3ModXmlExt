/**
 * SDK path normalization, validation and registry-based detection.
 *
 * Pure TypeScript (no vscode dependency) so the rules can be unit tested and
 * reused by the indexer.
 *
 * The registry keys mirror what the SDK's own build script
 * (`defaultscript.cs` initialize()) reads: the uninstall entry's
 * InstallLocation, first in the 64-bit view and then under Wow6432Node.
 * The installer path is only a hint - every candidate is validated against
 * the actual SDK layout before being offered to the user.
 */

import { execFile } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type SdkValidationStatus = "ok" | "partial" | "not-sdk" | "missing";

export interface SdkValidation {
  /** Resolved absolute path, or "" when nothing was configured. */
  path: string;
  status: SdkValidationStatus;
  /** Human-readable relative paths that failed validation. */
  missing: string[];
}

/** Uninstall entries queried by the SDK installer (same GUIDs as defaultscript.cs). */
export const SDK_REGISTRY_KEYS = [
  "HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{F6A3F605-7B10-4939-8D3D-4594332C1649}",
  "HKEY_LOCAL_MACHINE\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{F6A3F605-7B10-4939-8D3D-4594332C1649}",
] as const;

/**
 * The one required marker that identifies an RA3 Mod SDK root. The extension
 * bundles its own schema model, but this file is the most distinctive SDK
 * layout item (and is what `npm run generate-model` consumes).
 */
const SDK_ROOT_MARKER = ["Schemas", "xsd", "CnC3Types.xsd"] as const;

/**
 * Functional items used by the extension. Missing ones degrade specific
 * features (manifests, vanilla sources, SDK-side search paths), so they are
 * reported as "partial" instead of rejecting the root outright.
 */
const SDK_FUNCTIONAL_ITEMS: { rel: readonly string[] }[] = [
  { rel: ["builtmods"] },
  { rel: ["SageXml"] },
  { rel: ["Mods"] },
  { rel: ["Static.xml"] },
  { rel: ["Global.xml"] },
  { rel: ["Audio.xml"] },
];

/**
 * Trims quotes/whitespace and resolves to an absolute path. Returns "" for
 * an empty value so callers can treat it as "no SDK configured".
 */
export function normalizeSdkPath(raw: string): string {
  if (!raw) return "";
  let p = String(raw).trim();
  if (
    p.length >= 2 &&
    ((p.startsWith('"') && p.endsWith('"')) ||
      (p.startsWith("'") && p.endsWith("'")))
  ) {
    p = p.slice(1, -1).trim();
  }
  return p ? resolve(p) : "";
}

/**
 * Validates a configured/offered SDK path.
 *
 * - `missing`: nothing configured, or the path does not exist.
 * - `not-sdk`: exists, but lacks the SDK root marker.
 * - `partial`: is an SDK root, but some extension-relevant items are absent.
 * - `ok`: every checked item exists.
 */
export function validateSdkPath(raw: string): SdkValidation {
  const path = normalizeSdkPath(raw);
  if (!path) return { path: "", status: "missing", missing: [] };
  if (!isDirectory(path)) return { path, status: "missing", missing: [] };
  if (!hasNestedIgnoreCase(path, SDK_ROOT_MARKER)) {
    return {
      path,
      status: "not-sdk",
      missing: [SDK_ROOT_MARKER.join("/")],
    };
  }
  const missing: string[] = [];
  for (const item of SDK_FUNCTIONAL_ITEMS) {
    if (!hasNestedIgnoreCase(path, item.rel)) {
      missing.push(item.rel.join("/"));
    }
  }
  return {
    path,
    status: missing.length ? "partial" : "ok",
    missing,
  };
}

/**
 * Reads InstallLocation from one registry key via `reg.exe` (Windows only).
 * Returns null when the key/value is absent or the query fails.
 */
export async function readRegistryValue(
  key: string,
  valueName = "InstallLocation",
  timeoutMs = 3000,
): Promise<string | null> {
  if (process.platform !== "win32") return null;
  try {
    const stdout = await new Promise<string>((resolveValue, reject) => {
      execFile(
        "reg",
        ["query", key, "/v", valueName],
        { timeout: timeoutMs, windowsHide: true },
        (err, stdout, _stderr) => {
          if (err) reject(err);
          else resolveValue(stdout);
        },
      );
    });
    return parseRegistryInstallLocation(stdout);
  } catch {
    return null;
  }
}

/** Extracts the InstallLocation value from `reg.exe query` output. */
export function parseRegistryInstallLocation(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*InstallLocation\s+REG_[A-Z_]+\s+(.+?)\s*$/i);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

/** Queries both registry views in the same order defaultscript.cs uses. */
export async function detectSdkPathFromRegistry(): Promise<string | null> {
  for (const key of SDK_REGISTRY_KEYS) {
    const value = await readRegistryValue(key);
    if (value?.trim()) return value.trim();
  }
  return null;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readDirNames(dir: string): string[] | null {
  try {
    return readdirSync(dir);
  } catch {
    return null;
  }
}

function hasNestedIgnoreCase(root: string, rel: readonly string[]): boolean {
  let dir = root;
  for (let i = 0; i < rel.length - 1; i++) {
    const names = readDirNames(dir);
    if (!names) return false;
    const hit = names.find((n) => n.toLowerCase() === rel[i].toLowerCase());
    if (!hit) return false;
    dir = join(dir, hit);
  }
  const names = readDirNames(dir);
  if (!names) return false;
  const wanted = rel[rel.length - 1].toLowerCase();
  return names.some((n) => n.toLowerCase() === wanted);
}
