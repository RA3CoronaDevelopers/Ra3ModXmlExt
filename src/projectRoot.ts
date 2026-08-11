/**
 * Mod project root discovery for RA3 Mod XML.
 *
 * Pure TypeScript (no vscode dependency) so the detection rules can be unit
 * tested and reused by other tools.
 *
 * A project root is any directory containing one of the markers the mod
 * compiler (defaultscript.cs) actually consumes:
 *   - `Data/Mod.xml`            (static data entry)
 *   - `Data/additionalmaps/mapmetadata_*.xml` (global data entries)
 *   - `*.babproj`               (mod SDK project file)
 *
 * Discovery works in three directions:
 *   - upward from a folder (the workspace folder may be `Data` or a deep
 *     subfolder of a mod);
 *   - upward from a file (single-file opens without a workspace folder);
 *   - shallow downward from a container folder (a folder that contains
 *     several sibling mods).
 */

import { dirname, join, resolve } from "node:path";
import { readdirSync } from "node:fs";

export const DEFAULT_MAX_UPWARD_DEPTH = 12;
export const DEFAULT_MAX_DOWNWARD_DEPTH = 3;

export type ProjectMarkerKind = "mod" | "babproj" | "mapmetadata";

/** Directories that never contain a mod root themselves. */
const SKIP_DIRECTORY_NAMES = new Set([
  "data",
  "art",
  "art1",
  "audio",
  "audio1",
  "builtmods",
  "builtmods-quantum",
  "sageml",
  "schemas",
  "xsd",
  "hlsl",
  "node_modules",
  "packages",
  "dist",
  "out",
  "bin",
  "obj",
  ".git",
  ".vs",
  ".vscode",
]);

/**
 * Returns the marker kind found directly under `dir`, or null when `dir` is
 * not a mod project root. `Data`/`mapmetadata` lookups are case-insensitive.
 */
export function projectMarkerKind(dir: string): ProjectMarkerKind | null {
  const data = findCaseInsensitiveDir(dir, "Data");
  if (data && hasFileIgnoreCase(data, ["Mod.xml"])) return "mod";
  const entries = readDirNames(dir);
  if (entries?.some((e) => e.toLowerCase().endsWith(".babproj"))) {
    return "babproj";
  }
  if (data && hasMapMetadata(data)) return "mapmetadata";
  return null;
}

/** True when `dir` is a mod project root (any marker). */
export function isProjectRoot(dir: string): boolean {
  return projectMarkerKind(dir) != null;
}

/**
 * Walks upward from `startDir` (up to `maxDepth` ancestors) and returns the
 * nearest directory that carries a project marker, or null.
 */
export function findProjectRootUpward(
  startDir: string,
  maxDepth = DEFAULT_MAX_UPWARD_DEPTH,
): string | null {
  let dir = resolve(startDir);
  for (let i = 0; i < maxDepth; i++) {
    if (isProjectRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Upward discovery starting from a file's directory (single-file opens). */
export function findProjectRootForFile(
  file: string,
  maxDepth = DEFAULT_MAX_UPWARD_DEPTH,
): string | null {
  return findProjectRootUpward(dirname(resolve(file)), maxDepth);
}

/**
 * Shallow downward discovery for a workspace folder that contains one or
 * more mods (e.g. the SDK `Mods` folder or a personal mods container).
 *
 * Descends at most `maxDepth` levels, never descends into known non-mod
 * directories, and stops descending once a directory is itself a project
 * root (a root's own `Data`/`Art` subtrees are never project containers).
 * Results are de-duplicated by normalized path.
 */
export function discoverProjects(
  folder: string,
  maxDepth = DEFAULT_MAX_DOWNWARD_DEPTH,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    if (isProjectRoot(dir)) {
      const key = normKey(dir);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(resolve(dir));
      }
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRECTORY_NAMES.has(entry.name.toLowerCase())) continue;
      visit(join(dir, entry.name), depth + 1);
    }
  };
  visit(resolve(folder), 0);
  return out;
}

function normKey(path: string): string {
  return resolve(path).toLowerCase();
}

function readDirNames(dir: string): string[] | null {
  try {
    return readdirSync(dir);
  } catch {
    return null;
  }
}

/** Case-insensitive child directory lookup under `parent`. */
function findCaseInsensitiveDir(parent: string, wanted: string): string | null {
  const entries = readDirNames(parent);
  if (!entries) return null;
  const hit = entries.find(
    (e) => e.toLowerCase() === wanted.toLowerCase(),
  );
  return hit ? join(parent, hit) : null;
}

/** True when `dir` contains any of `names` (case-insensitive file names). */
function hasFileIgnoreCase(dir: string, names: string[]): boolean {
  const entries = readDirNames(dir);
  if (!entries) return false;
  const lower = new Set(entries.map((e) => e.toLowerCase()));
  return names.some((n) => lower.has(n.toLowerCase()));
}

/** True when `dataDir/additionalmaps` contains a mapmetadata_*.xml file. */
function hasMapMetadata(dataDir: string): boolean {
  const maps = findCaseInsensitiveDir(dataDir, "additionalmaps");
  if (!maps) return false;
  const entries = readDirNames(maps);
  if (!entries) return false;
  return entries.some((e) => /^mapmetadata_.*\.xml$/i.test(e));
}
