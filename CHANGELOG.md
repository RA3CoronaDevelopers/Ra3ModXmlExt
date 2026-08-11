# Changelog

## 0.1.22 — 2026-08-11

### Fixed

- Manifest assets that share the same id under different types are now all kept in the by-id index. Previously the first same-id entry (e.g. `W3DHierarchy:AUMCV_HOVER`) could shadow later definitions (e.g. `W3DContainer:AUMCV_HOVER`), causing `Model@Name` and other `BaseRenderAssetType` references to be reported as unresolved even though the asset existed in `Static.manifest`.
- `xi:include` without an `xpointer` now splices the target document's root element itself (XInclude semantics), so fragments like `GenericCelestialBuildingSuicide.xml` keep their module wrapper (`CreateObjectDie`) instead of only inserting its children.
- Fragment files (documents whose root is not `AssetDeclaration`) no longer trigger standalone-document diagnostics: top-level `missing-id`, duplicate-id, unresolved-reference and undefined-define checks are skipped, unknown wrapper roots are not reported as unknown elements, and a known fragment root still validates its subtree's elements/attributes.

### Added

- Missing `xi:include` targets now surface in the Problems panel as `include-not-found` warnings for the edited document (previously only tracked in indexer diagnostics).

## 0.1.21 — 2026-08-11

### Added

- English/Chinese localization for the extension manifest, commands, settings, status bar, notifications, hover, completions, CodeLens, and diagnostics.
- `package.nls.*` and `l10n/` bundles so future languages can be added without touching source code.
- AI-generated project disclosure in both `README.md` and `README.zh-CN.md`.

### Changed

- Packaged extension now includes localization resources.
- `npm run package` no longer fails on missing repository-link rewriting.

### Fixed

- Parser errors carry stable codes and parameters so the UI layer can localize them while the parsing core stays VS Code-independent.
