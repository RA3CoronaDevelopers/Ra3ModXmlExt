// Extracts the SAGE AssetType hash -> type name mapping from OpenSAGE's
// AssetType.cs into src/model/asset-types.json.
//
// Usage:
//   node tools/extract-asset-types.mjs [path-to-AssetType.cs]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultSource = resolve(
  __dirname,
  "..",
  "OpenSAGE",
  "src",
  "OpenSage.Game",
  "Data",
  "StreamFS",
  "AssetType.cs",
);
const sourcePath = process.argv[2] ?? defaultSource;

const text = readFileSync(sourcePath, "utf8");

// Match lines like:
//   GameObject = 0x942FFF2D,
//   W3dAnimation = 0x2448AE30,
const typeRegex = /^\s*(\w+)\s*=\s*0x([0-9A-Fa-f]{8})\s*,/gm;
const types = new Map();
let match;
while ((match = typeRegex.exec(text)) !== null) {
  const name = match[1];
  const hash = match[2].toUpperCase();
  const numeric = parseInt(hash, 16);
  if (types.has(numeric)) {
    console.warn(`duplicate hash 0x${hash}: ${types.get(numeric)} vs ${name}`);
  }
  types.set(numeric, name);
}

if (types.size === 0) {
  console.error(`No AssetType entries found in ${sourcePath}`);
  process.exit(1);
}

const output = {
  version: 1,
  source: "OpenSAGE src/OpenSage.Game/Data/StreamFS/AssetType.cs",
  count: types.size,
  types: Object.fromEntries(
    [...types.entries()].map(([hash, name]) => [hash, name]),
  ),
};

const outPath = resolve(__dirname, "..", "src", "model", "asset-types.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(output, null, 1));
console.log(`Wrote ${types.size} asset types to ${outPath}`);
