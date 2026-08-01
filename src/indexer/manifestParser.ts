/**
 * Parser for SAGE `.manifest` files, ported from OpenSAGE
 * (src/OpenSage.Game/Data/StreamFS/ManifestFile.cs, commit d45d361).
 *
 * The manifest is a binary index produced by BinaryAssetBuilder: every asset
 * compiled into a stream is listed with hashed type/instance ids, an offset
 * into the asset-name string buffer, and an optional source file name.
 * Parsing it lets the extension treat `reference` includes (static.xml,
 * global.xml, audio.xml) as real, searchable asset pools.
 */

import { assetTypeNameFromHash } from "../model/schemaModel";

export interface ManifestAsset {
  typeId: number;
  typeName: string | null;
  name: string;
  sourceFileName: string;
}

export interface ManifestReferenceEntry {
  referenceType: number;
  path: string;
}

export interface ManifestInfo {
  version: number;
  isBigEndian: boolean;
  isLinked: boolean;
  assetCount: number;
  assets: ManifestAsset[];
  manifestReferences: ManifestReferenceEntry[];
  /** Present when the file could not be parsed. */
  error?: string;
}

/**
 * Derives an asset type from its manifest name. BAB stores manifest assets
 * as "TypeName:Id" (e.g. "PlayerTemplate:Allies"), so the part before the
 * first colon is the type even when the TypeId hash is unknown to the
 * bundled AssetType table. Asset ids cannot contain ":" (InstanceId pattern),
 * so the split is unambiguous.
 */
export function deriveAssetType(typeName: string | null, assetName: string): string | null {
  if (typeName) return typeName;
  const idx = assetName.indexOf(":");
  if (idx <= 0) return null;
  const prefix = assetName.slice(0, idx);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix) ? prefix : null;
}

/**
 * Extracts the referenceable asset id from a manifest name. BAB stores
 * manifest names as "TypeName:InstanceId" where the instance id may itself
 * carry a subtype prefix for art assets, e.g.
 *   W3dContainer:W3DContainer:AUANTIVEHICLEVEHICLETECH1_SKN
 * The referenceable id is the last colon-separated segment (asset ids cannot
 * contain ":" per the InstanceId pattern).
 */
export function deriveAssetId(assetName: string): string {
  const idx = assetName.lastIndexOf(":");
  return idx >= 0 ? assetName.slice(idx + 1) : assetName;
}

class Cursor {
  private pos = 0;
  constructor(private buf: Uint8Array) {}

  get position(): number {
    return this.pos;
  }

  byte(): number {
    if (this.pos >= this.buf.length) throw new Error("Unexpected end of file");
    return this.buf[this.pos++];
  }

  uint16(): number {
    const a = this.byte();
    const b = this.byte();
    return a | (b << 8);
  }

  uint32(): number {
    const a = this.byte();
    const b = this.byte();
    const c = this.byte();
    const d = this.byte();
    return ((a | (b << 8) | (c << 16) | (d << 24)) >>> 0);
  }

  skip(n: number): void {
    this.pos += n;
    if (this.pos > this.buf.length) throw new Error("Unexpected end of file");
  }

  nullTerminatedString(): string {
    const start = this.pos;
    while (this.pos < this.buf.length && this.buf[this.pos] !== 0) {
      this.pos++;
    }
    const end = this.pos;
    if (this.pos < this.buf.length) this.pos++; // consume NUL
    return decodeAscii(this.buf, start, end);
  }

  readNameBuffer(endPosition: number): Map<number, string> {
    const names = new Map<number, string>();
    let nameOffset = 0;
    while (this.pos < endPosition) {
      const start = this.pos;
      names.set(nameOffset, this.nullTerminatedString());
      nameOffset += this.pos - start;
    }
    return names;
  }
}

function decodeAscii(buf: Uint8Array, start: number, end: number): string {
  // Asset ids are ASCII; anything else decodes with replacement chars.
  let out = "";
  for (let i = start; i < end; i++) {
    out += String.fromCharCode(buf[i]);
  }
  return out;
}

export function parseManifest(buffer: Uint8Array): ManifestInfo {
  try {
    return parseManifestInner(buffer);
  } catch (err) {
    return {
      version: 0,
      isBigEndian: false,
      isLinked: false,
      assetCount: 0,
      assets: [],
      manifestReferences: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function parseManifestInner(buffer: Uint8Array): ManifestInfo {
  const cursor = new Cursor(buffer);

  const testValue = cursor.uint32();
  let version: number;
  let isBigEndian: boolean;
  let isLinked: boolean;

  if (testValue === 0) {
    version = cursor.uint16();
    if (version !== 7) throw new Error(`Unsupported manifest version ${version}`);
    isBigEndian = readBooleanChecked(cursor);
    isLinked = readBooleanChecked(cursor);
  } else {
    cursor.skip(-4);
    isBigEndian = readBooleanChecked(cursor);
    isLinked = readBooleanChecked(cursor);
    version = cursor.uint16();
    if (version !== 5 && version !== 6) {
      throw new Error(`Unsupported manifest version ${version}`);
    }
  }

  const streamChecksum = cursor.uint32();
  const allTypesHash = cursor.uint32();
  const assetCount = cursor.uint32();
  const totalInstanceDataSize = cursor.uint32();
  const maxInstanceChunkSize = cursor.uint32();
  const maxRelocationChunkSize = cursor.uint32();
  const maxImportsChunkSize = cursor.uint32();
  const assetReferenceBufferSize = cursor.uint32();
  const referencedManifestNameBufferSize = cursor.uint32();
  const assetNameBufferSize = cursor.uint32();
  const sourceFileNameBufferSize = cursor.uint32();

  void streamChecksum;
  void allTypesHash;
  void totalInstanceDataSize;
  void maxInstanceChunkSize;
  void maxRelocationChunkSize;
  void maxImportsChunkSize;

  interface RawEntry {
    typeId: number;
    nameOffset: number;
    sourceFileNameOffset: number;
  }
  const rawEntries: RawEntry[] = [];
  for (let i = 0; i < assetCount; i++) {
    const typeId = cursor.uint32();
    cursor.uint32(); // instanceId
    cursor.uint32(); // typeHash
    cursor.uint32(); // instanceHash
    cursor.uint32(); // assetReferenceOffset
    cursor.uint32(); // assetReferenceCount
    const nameOffset = cursor.uint32();
    const sourceFileNameOffset = cursor.uint32();
    cursor.uint32(); // instanceDataSize
    cursor.uint32(); // relocationDataSize
    cursor.uint32(); // importsDataSize
    if (version >= 6) {
      cursor.byte(); // isTokenized
      cursor.skip(3);
    }
    rawEntries.push({
      typeId,
      nameOffset,
      sourceFileNameOffset,
    });
  }

  // Asset references buffer (not needed for completions).
  cursor.skip(assetReferenceBufferSize);

  // Referenced manifest names.
  const manifestRefsEnd = cursor.position + referencedManifestNameBufferSize;
  const manifestReferences: ManifestReferenceEntry[] = [];
  while (cursor.position < manifestRefsEnd) {
    const referenceType = cursor.byte();
    const path = cursor.nullTerminatedString();
    manifestReferences.push({ referenceType, path });
  }

  // Asset names.
  const assetNamesEnd = cursor.position + assetNameBufferSize;
  const assetNames = cursor.readNameBuffer(assetNamesEnd);

  // Source file names.
  const sourceNamesEnd = cursor.position + sourceFileNameBufferSize;
  const sourceNames = cursor.readNameBuffer(sourceNamesEnd);

  const assets: ManifestAsset[] = rawEntries.map((entry) => ({
    typeId: entry.typeId,
    typeName: assetTypeNameFromHash(entry.typeId) ?? null,
    name: assetNames.get(entry.nameOffset) ?? "",
    sourceFileName: sourceNames.get(entry.sourceFileNameOffset) ?? "",
  }));

  return {
    version,
    isBigEndian,
    isLinked,
    assetCount,
    assets,
    manifestReferences,
  };
}

function readBooleanChecked(cursor: Cursor): boolean {
  const value = cursor.byte();
  if (value === 0) return false;
  if (value === 1) return true;
  throw new Error(`Invalid boolean byte ${value}`);
}
