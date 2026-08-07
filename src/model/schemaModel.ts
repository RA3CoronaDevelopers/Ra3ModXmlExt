import schemaModel from "./schema-model.json";
import assetTypes from "./asset-types.json";

export interface ChildInfo {
  name: string;
  type: string | null;
  min: number;
  max: number; // -1 = unbounded
  doc: string;
}

export interface AttributeInfo {
  name: string;
  required: boolean;
  default: string | null;
  doc: string;
  kind: string;
  type: string | null;
  refType: string | null;
  /** True for reference-typed attributes whose simple type has no refType. */
  isRef: boolean;
  enumValues: string[];
  /** True for xs:list types (whitespace-separated bit flags / lists). */
  isList: boolean;
  allowsDefine: boolean;
  isBoolean: boolean;
  base: string | null;
}

export interface ComplexTypeInfo {
  kind: "complex";
  children: ChildInfo[];
  attributes: AttributeInfo[];
  base: string | null;
  doc: string;
}

export interface SimpleTypeInfo {
  kind: "simple";
  base: string | null;
  refType: string | null;
  isRef: boolean;
  enumValues: string[];
  isList: boolean;
  allowsDefine: boolean;
  doc: string;
}

export type TypeInfo = ComplexTypeInfo | SimpleTypeInfo;

interface RawModel {
  version: number;
  rootXsd: string;
  topLevelElements: string[];
  elements: Record<string, { type: string | null; doc: string }>;
  types: Record<string, TypeInfo>;
  subTypesOf: Record<string, string[]>;
}

const model = schemaModel as unknown as RawModel;

/** Lowercase type name -> canonical (XSD) type name. */
const typeNameIndex = new Map<string, string>();
for (const name of Object.keys(model.types)) {
  const lower = name.toLowerCase();
  if (!typeNameIndex.has(lower)) typeNameIndex.set(lower, name);
}

/** Resolves a possibly-mis-cased type name to its canonical XSD spelling. */
export function canonicalTypeName(name: string | null): string | null {
  if (!name) return null;
  return typeNameIndex.get(name.toLowerCase()) ?? name;
}

/** element name -> type name, collected from every complex type's children. */
const elementToType = new Map<string, string>();
for (const type of Object.values(model.types)) {
  if (type.kind !== "complex") continue;
  for (const child of type.children) {
    if (!elementToType.has(child.name)) {
      elementToType.set(child.name, child.type ?? "");
    }
  }
}
for (const [name, info] of Object.entries(model.elements)) {
  elementToType.set(name, info.type ?? "");
}

export const modelMeta = {
  rootXsd: model.rootXsd,
  topLevelElementCount: model.topLevelElements.length,
  typeCount: Object.keys(model.types).length,
};

/** All type names in the XSD model (complex + simple), in model order. */
export function allTypeNames(): string[] {
  return Object.keys(model.types);
}

export function topLevelElements(): string[] {
  return model.topLevelElements;
}

export function isTopLevelElement(name: string): boolean {
  return model.topLevelElements.includes(name);
}

export function typeInfo(name: string): TypeInfo | undefined {
  return model.types[name];
}

export function elementTypeName(name: string): string | null {
  const t = elementToType.get(name);
  return t ? t : null;
}

export function childrenOfElement(name: string): ChildInfo[] {
  const type = elementTypeName(name);
  if (!type) return [];
  return childrenOfType(type);
}

export function childrenOfType(typeName: string | null): ChildInfo[] {
  if (!typeName) return [];
  const info = model.types[canonicalTypeName(typeName) ?? typeName];
  return info && info.kind === "complex" ? info.children : [];
}

export function attributesOfElement(name: string): AttributeInfo[] {
  const type = elementTypeName(name);
  if (!type) return [];
  return attributesOfType(type);
}

export function attributesOfType(typeName: string | null): AttributeInfo[] {
  if (!typeName) return [];
  const info = model.types[canonicalTypeName(typeName) ?? typeName];
  return info && info.kind === "complex" ? info.attributes : [];
}

/**
 * Returns the type of a child element inside a KNOWN parent type, or null
 * when the parent type is unknown or the child is not declared there.
 */
export function childTypeOf(
  parentTypeName: string | null,
  childName: string,
): string | null {
  if (!parentTypeName) return null;
  const info = model.types[canonicalTypeName(parentTypeName) ?? parentTypeName];
  if (info?.kind !== "complex") return null;
  return info.children.find((c) => c.name === childName)?.type ?? null;
}

/**
 * Context-aware element type resolution: prefers the child declaration inside
 * the parent element's type, falling back to the global element map. Same
 * element names used in different parents (e.g. <Weapon> under a weapon slot
 * vs. a plain reference) therefore resolve to their contextually correct type.
 */
export function elementTypeIn(
  parentElementName: string | null,
  childName: string,
): string | null {
  if (parentElementName) {
    const parentType = elementTypeName(parentElementName);
    const typed = childTypeOf(parentType, childName);
    if (typed) return typed;
  }
  return elementTypeName(childName);
}

export function typeDoc(name: string): string {
  const info = model.types[name];
  return info?.doc ?? "";
}

/** The type itself plus all ancestors (nearest first). */
export function typeChain(name: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = canonicalTypeName(name);
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    const info: TypeInfo | undefined = model.types[cur];
    cur = info && "base" in info && info.base ? canonicalTypeName(info.base) : null;
  }
  return out;
}

/**
 * True when an asset of type `actualType` satisfies a reference to `refType`.
 * Falls back to exact name matching; unknown types only match exactly.
 */
export function isAssignableTo(actualType: string, refType: string | null): boolean {
  if (!refType) return true;
  const actual = canonicalTypeName(actualType) ?? actualType;
  const ref = canonicalTypeName(refType) ?? refType;
  if (actual === ref) return true;
  return typeChain(actual).includes(ref);
}

/** Maps a manifest TypeId hash to a type name, when known. */
export function assetTypeNameFromHash(hash: number): string | undefined {
  return (assetTypes as { types: Record<string, string> }).types[hash];
}

export function assetTypeHashCount(): number {
  return (assetTypes as { count: number }).count ?? 0;
}

/** Elements that are structurally relevant everywhere. */
export const STRUCTURAL_ELEMENTS = [
  "AssetDeclaration",
  "Includes",
  "Include",
  "Tags",
  "Tag",
  "Defines",
  "Define",
];

/**
 * Element names that live outside the RA3 XSD model's namespace. The model
 * only covers `uri:ea.com:eala:asset`; other namespaces (so far the W3C
 * XInclude `xi:`) must not be validated against it.
 */
const FOREIGN_ELEMENT_PREFIXES = ["xi:"];

/** True when an element name belongs to the RA3 XSD model's namespace. */
export function isXsdElementName(name: string): boolean {
  const lower = name.toLowerCase();
  return !FOREIGN_ELEMENT_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * True when an attribute name can be validated against the RA3 XSD model.
 * EA schema attributes are unprefixed; prefixed attributes (`xai:`,
 * `xi:`, `xlink:`, `xml:`, `xsi:`, `xmlns:*`) are namespace machinery and
 * are not defined by the XSD.
 */
export function isXsdAttributeName(name: string): boolean {
  return !name.includes(":");
}
