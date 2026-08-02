import { readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import type { FileWalker, SourceCandidate } from "./types";

/**
 * Extensions offered as Include/@source candidates in DATA directories:
 * regular XML plus art-asset XML (.w3x) that mods include via W3X.xml hubs.
 * ART/AUDIO directories already list every file.
 */
const DATA_CANDIDATE_EXTENSIONS = new Set([".xml", ".w3x"]);

function isDataCandidate(path: string): boolean {
  return DATA_CANDIDATE_EXTENSIONS.has(extname(path).toLowerCase());
}

/**
 * Recursive file list walker with a simple directory-mtime cache. Used to
 * enumerate candidate files for Include/@source completion. Directory scans
 * outside the workspace (e.g. the SDK) are cached until the directory mtime
 * changes.
 */
export class CachedDirectoryWalker implements FileWalker {
  private cache = new Map<string, { mtimeMs: number; files: string[] }>();

  async listFiles(dir: string): Promise<string[]> {
    const key = dir.toLowerCase();
    try {
      const dirStat = await stat(dir);
      const cached = this.cache.get(key);
      if (cached && cached.mtimeMs === dirStat.mtimeMs) {
        return cached.files;
      }
      const files: string[] = [];
      await this.walk(dir, files);
      this.cache.set(key, { mtimeMs: dirStat.mtimeMs, files });
      return files;
    } catch {
      return [];
    }
  }

  private async walk(dir: string, out: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walk(full, out);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }
}

/**
 * Builds the candidate list for Include/@source completion from a set of
 * search directories. For DATA directories only *.xml files are listed; for
 * ART/AUDIO directories every file is listed (includes commonly point at
 * .w3x/.dds/.mpf files there).
 */
export async function collectSourceCandidates(
  walker: FileWalker,
  dataDirs: string[],
  artDirs: string[],
  audioDirs: string[],
  projectDataDir: string,
): Promise<SourceCandidate[]> {
  const out: SourceCandidate[] = [];
  const seen = new Set<string>();

  const add = (path: string, baseDir: string, prefix: "DATA" | "ART" | "AUDIO" | null) => {
    const rel = relative(baseDir, path).replace(/\\/g, "/");
    if (rel.startsWith("..")) return;
    const source = prefix ? `${prefix}:${rel}` : rel;
    const key = `${prefix ?? ""}:${source.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ source, path: resolve(path), prefix, baseDir: resolve(baseDir) });
  };

  // List directories in parallel; the walker caches each directory by its
  // mtime, so rebuilds after the first are still cheap.
  const [dataLists, artLists, audioLists] = await Promise.all([
    Promise.all(dataDirs.map(async (dir) => ({ dir, files: await walker.listFiles(dir) }))),
    Promise.all(artDirs.map(async (dir) => ({ dir, files: await walker.listFiles(dir) }))),
    Promise.all(audioDirs.map(async (dir) => ({ dir, files: await walker.listFiles(dir) }))),
  ]);

  for (const { dir, files } of dataLists) {
    for (const f of files) {
      if (!isDataCandidate(f)) continue;
      add(f, dir, "DATA");
    }
    if (samePath(dir, projectDataDir)) {
      // Also offer project-relative paths (what Mod.xml itself uses).
      for (const f of files) {
        if (isDataCandidate(f)) add(f, projectDataDir, null);
      }
    }
  }

  for (const { dir, files } of artLists) {
    for (const f of files) add(f, dir, "ART");
  }
  for (const { dir, files } of audioLists) {
    for (const f of files) add(f, dir, "AUDIO");
  }

  return out;
}

function samePath(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}
