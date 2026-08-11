# Changelog

## 0.1.25 — 2026-08-11

### Changed

- Repository and homepage links now point to the GitHub mirror; README links to both GitHub and Gitea.
- Extension now activates in untrusted (Restricted Mode) workspaces; workspace-defined `ra3modxml.sdkPath` and `ra3modxml.additionalDataSearchPaths` are ignored until the workspace is trusted.

## 0.1.24 — 2026-08-11

### Fixed

- Manifest-style qualified reference values (`Type:Id`, e.g.
  `inheritFrom="AudioEvent:BaseSoundEffect"`,
  `Sound="AudioEvent:JAP_Refinery_Select"`, `Side="PlayerTemplate:Allies"`)
  now resolve to the plain-id definitions indexed from XML (mod or
  `SageXml`). Previously the plugin only applied the “last colon segment”
  rule to manifest asset names, so qualified XML references were reported as
  unresolved even when the definition existed (the reported
  `AudioEvent:BaseSoundEffect` case).
- The same normalization now applies to simple-content references, the
  semantic reverse index (Find All References / CodeLens counts), and the
  reference peek path, so hover, Ctrl+click, diagnostics, reference counts
  and unreferenced reports all agree.
- Value completion keeps a `Type:` prefix the user already typed:
  `inheritFrom="AudioEvent:Base…` completes to
  `AudioEvent:BaseSoundEffect` instead of dropping the prefix. Plain ids
  without a prefix keep the previous bare-id behavior.

- `inheritFrom` is now accepted on all `BaseAssetType`-derived assets (e.g. `FXList`, `AIMicroManagerData`, `ObjectCreationList`, `OnDemandTextureImage`, `AITargetingHeuristic`). The XSD only declares it on `BaseInheritableAsset`, but vanilla and Corona data use it more broadly. Attribute legality is now separate from the CodeLens / Find All References “reference target by design” filter, so the universal attribute does not widen the code-lens type list.
- `simpleContent` complex types (`AudioFileRefWithWeight`, `MultisoundSubsoundRef`) keep their XSD attributes (`Weight`, `Volume`, `PitchShiftLow/High`, ...) and their text content (`<Sound>AudioFile</Sound>`, `<Subsound>VoiceEvent</Subsound>`) is now handled as a typed asset reference by completion, hover, navigation, diagnostics, the semantic reference index, and Find All References.
- Fragment roots whose name also appears as a nested child type (e.g. `<EvaEvent>`, `<UpgradeTemplate>`) now resolve to the top-level `AssetDeclaration` type instead of the colliding child type.
- Element-name completion for simple-content children now re-triggers value suggestions after inserting the `<Name>$1</Name>` snippet.

### Added

- 128×128 PNG extension icon (converted from `images/icon.webp`). The `.vsix` no longer bundles the `images` folder, so the large GIF demos stay out of the package.

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
