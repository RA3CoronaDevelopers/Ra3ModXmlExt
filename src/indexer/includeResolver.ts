/**
 * Include path resolution for RA3 Mod XML, ported from the reference
 * implementation in check_duplicate_ids.py.
 *
 * Pure TypeScript: no vscode dependency, so the module can be reused outside
 * the extension (e.g. by search/analysis tools).
 */

import { join, resolve, normalize, isAbsolute } from "node:path";
import { statSync } from "node:fs";
import type { ExistenceSnapshot } from "./existence";

export type IncludeKind = "all" | "instance" | "reference";
export type SourcePrefix = "DATA" | "ART" | "AUDIO" | null;

export interface SearchPaths {
  DATA: string[];
  ART: string[];
  AUDIO: string[];
}

export interface ResolveResult {
  path: string | null;
  prefix: SourcePrefix;
  raw: string;
}

const PREFIXES: Exclude<SourcePrefix, null>[] = ["DATA", "ART", "AUDIO"];

/**
 * Builds the search path lists used by the SDK compiler:
 * (from defaultscript.cs getIncludePaths(), where "." is the SDK root):
 * DATA:  sdk -> modGranParent -> project/Data -> sdk/Mods -> modParentPath -> sdk/SageXml
 * ART:   sdk -> modGranParent -> project/Art1 -> project/Art -> sdk/Mods -> modParentPath -> sdk/Art
 * AUDIO: sdk -> modGranParent -> project/Audio1 -> project/Audio -> sdk/Mods -> modParentPath -> sdk/Audio
 *
 * `extra` directories (from user settings) are appended after the defaults
 * for their matching prefix.
 */
export function buildSearchPaths(
  sdkDir: string,
  projectDir: string,
  extra?: Partial<Record<"DATA" | "ART" | "AUDIO", string[]>>,
): SearchPaths {
  const modParentPath = resolve(projectDir, "..");
  const modGranParent = resolve(modParentPath, "..");
  const sdk = sdkDir && sdkDir.trim() ? resolve(sdkDir) : "";
  const sdkItems = (items: string[]): string[] => (sdk ? items : []);
  return {
    DATA: [
      ...sdkItems([sdk]),
      modGranParent,
      join(projectDir, "Data"),
      ...sdkItems([join(sdk, "Mods")]),
      modParentPath,
      ...sdkItems([join(sdk, "SageXml")]),
      ...(extra?.DATA ?? []),
    ],
    ART: [
      ...sdkItems([sdk]),
      modGranParent,
      join(projectDir, "Art1"),
      join(projectDir, "Art"),
      ...sdkItems([join(sdk, "Mods")]),
      modParentPath,
      ...sdkItems([join(sdk, "Art")]),
      ...(extra?.ART ?? []),
    ],
    AUDIO: [
      ...sdkItems([sdk]),
      modGranParent,
      join(projectDir, "Audio1"),
      join(projectDir, "Audio"),
      ...sdkItems([join(sdk, "Mods")]),
      modParentPath,
      ...sdkItems([join(sdk, "Audio")]),
      ...(extra?.AUDIO ?? []),
    ],
  };
}

/**
 * Search paths used to resolve a `manifestSource` back to the original
 * vanilla SDK source file.
 *
 * `manifestSource` records where the asset came from when the vanilla
 * manifest was compiled; it is not an Include path that should be resolved
 * with the current mod's BAB search order. If a mod shadows the same DATA:
 * path (for example `Data/globaldata/weapon.xml` exists in both the mod and
 * `SageXml`), the manifest definition must still point at the SageXml file.
 *
 * DATA/ART/AUDIO are resolved against the SDK root first (matching the
 * vanilla BAB `/data "/art" /audio` order), then against the corresponding
 * SDK source folder. ART/AUDIO source files are not shipped for most assets,
 * so those resolutions usually return null and callers fall back to
 * manifest-only behavior.
 */
export function buildVanillaSearchPaths(sdkDir: string): SearchPaths {
  const sdk = sdkDir && sdkDir.trim() ? resolve(sdkDir) : "";
  return {
    DATA: sdk ? [sdk, join(sdk, "SageXml")] : [],
    ART: sdk ? [sdk, join(sdk, "Art")] : [],
    AUDIO: sdk ? [sdk, join(sdk, "Audio")] : [],
  };
}

function splitPrefix(source: string): { prefix: SourcePrefix; rest: string } {
  for (const prefix of PREFIXES) {
    if (source.toUpperCase().startsWith(`${prefix}:`)) {
      return { prefix, rest: source.slice(prefix.length + 1).replace(/^[/\\]+/, "") };
    }
  }
  return { prefix: null, rest: source.replace(/^[/\\]+/, "") };
}

/**
 * Resolves an Include/@source (or xi:include/@href) to an absolute file path,
 * or null when not found.
 *
 * - DATA:/ART:/AUDIO: prefixes are resolved against the corresponding search
 *   paths, in order.
 * - ART: paths without a directory separator also try the 2-letter prefix
 *   subdirectory (e.g. JUAntiShip -> ju/JUAntiShip).
 * - Paths without a prefix are resolved relative to the including file.
 */
export function resolveSource(
  source: string,
  currentDir: string | null,
  searchPaths: SearchPaths,
  existence?: ExistenceSnapshot,
): ResolveResult {
  const raw = source.trim().replace(/\\/g, "/");
  const { prefix, rest } = splitPrefix(raw);

  if (prefix) {
    const bases = searchPaths[prefix] ?? [];
    const direct = findInBases(rest, bases, existence);
    if (direct) return { path: direct, prefix, raw };
    if (prefix === "ART" && !rest.includes("/")) {
      const two = rest.slice(0, 2).toLowerCase();
      const prefixed = findInBases(`${two}/${rest}`, bases, existence);
      if (prefixed) return { path: prefixed, prefix, raw };
    }
    return { path: null, prefix, raw };
  }

  if (currentDir && isAbsolute(rest)) {
    return {
      path: fileExists(rest, existence) ? rest : null,
      prefix: null,
      raw,
    };
  }
  if (currentDir) {
    const candidate = resolve(currentDir, rest);
    return {
      path: fileExists(candidate, existence) ? candidate : null,
      prefix: null,
      raw,
    };
  }
  return { path: null, prefix: null, raw };
}

function findInBases(
  relPath: string,
  bases: string[],
  existence?: ExistenceSnapshot,
): string | null {
  for (const base of bases) {
    const candidate = normalize(resolve(base, relPath));
    if (fileExists(candidate, existence)) return candidate;
  }
  return null;
}

function fileExists(path: string, existence?: ExistenceSnapshot): boolean {
  if (existence) {
    const known = existence.has(path);
    if (known !== null) return known;
  }
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * For `<Include type="reference" source="DATA:static.xml">`, returns the
 * compiled manifest file that backs the placeholder, when present in one of
 * the builtmods directories. The placeholder file name maps to
 * `<name>.manifest` (e.g. static.xml -> static.manifest).
 */
export function manifestPathForReference(
  source: string,
  builtmodsDirs: string[],
): string | null {
  const base = basenameWithoutExt(stripPrefix(source).replace(/\\/g, "/"));
  if (!base) return null;
  for (const dir of builtmodsDirs) {
    const candidate = join(dir, `${base}.manifest`);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

function basenameWithoutExt(path: string): string {
  const idx = path.lastIndexOf("/");
  const file = idx >= 0 ? path.slice(idx + 1) : path;
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
}

function stripPrefix(source: string): string {
  const idx = source.indexOf(":");
  return idx >= 0 ? source.slice(idx + 1) : source;
}
