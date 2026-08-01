import { test } from "node:test";
import assert from "node:assert/strict";
import { parseManifest } from "../out/indexer/manifestParser.js";

function u32(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
}
function u16(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v >>> 0);
  return b;
}

test("parses a minimal version 5 manifest", () => {
  const name = Buffer.from("VanillaTank\0", "ascii");
  const src = Buffer.from("DATA:globaldata/armor.xml\0", "ascii");
  const parts = [
    Buffer.from([0, 1]), // isBigEndian=false, isLinked=true (one byte each)
    u16(5), // version
    u32(0x1234), // streamChecksum
    u32(0), // allTypesHash
    u32(1), // assetCount
    u32(0), // totalInstanceDataSize
    u32(0), // maxInstanceChunkSize
    u32(0), // maxRelocationChunkSize
    u32(0), // maxImportsChunkSize
    u32(0), // assetReferenceBufferSize
    u32(0), // referencedManifestNameBufferSize
    u32(name.length), // assetNameBufferSize
    u32(src.length), // sourceFileNameBufferSize
    // one asset entry (version 5 = 44 bytes, no tokenized flag)
    u32(0x942fff2d), // typeId (GameObject)
    u32(0), // instanceId
    u32(0), // typeHash
    u32(0), // instanceHash
    u32(0), // assetReferenceOffset
    u32(0), // assetReferenceCount
    u32(0), // nameOffset
    u32(0), // sourceFileNameOffset
    u32(0), // instanceDataSize
    u32(0), // relocationDataSize
    u32(0), // importsDataSize
    name,
    src,
  ];
  const info = parseManifest(new Uint8Array(Buffer.concat(parts)));
  assert.equal(info.version, 5);
  assert.equal(info.assetCount, 1);
  assert.equal(info.assets.length, 1);
  assert.equal(info.assets[0].name, "VanillaTank");
  assert.equal(info.assets[0].typeName, "GameObject");
  assert.equal(info.assets[0].sourceFileName, "DATA:globaldata/armor.xml");
});

test("reports an error for garbage input", () => {
  const info = parseManifest(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  assert.ok(info.error);
  assert.equal(info.assets.length, 0);
});
