# Changelog

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
