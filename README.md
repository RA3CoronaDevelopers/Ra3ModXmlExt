# RA3 Mod XML（VS Code 扩展）

面向《命令与征服：红色警戒 3》Mod XML（SAGE / BinaryAssetBuilder 格式）的 VS Code 工具扩展。

## 功能

- **语法高亮**：在普通 XML 高亮之上叠加领域标记（`$DEFINE` 常量、`inheritFrom`、`xai:joinAction`、结构标签）；XML 语法异常（如未闭合引号）期间由语义 token 兜底，标签/属性/值着色不中断。
- **自动补全**：
  - 元素名：按当前父元素的 XSD 模型补全子元素；顶层资产（`AssetDeclaration` 内）补全 `GameObject`、`WeaponTemplate` 等 295 种类型。
  - 属性名：必填属性优先，附带类型/文档/默认值；自动提示 `xai:joinAction` 与 `xmlns:xai`。
  - 属性值：
    - 引用型属性（如 `CommandSet`、`Weapon`）按 `xas:refType` 补全对应类型的资产 ID（**同名 ID 只补全匹配类型**）；
    - `inheritFrom` 补全可继承的资产 ID；
    - 枚举与位标志列表（如 `Include type`、`LocomotorTemplate@Surfaces`、`KindOf`；列表值支持空格后继续补全下一项）；
    - 布尔值、`$DEFINE` 常量；
    - `<Include source>` 补全可解析的 `DATA:` / `ART:` / `AUDIO:` 与项目相对路径。
- **悬停提示**：元素/属性显示 XSD 文档、类型、必填/默认值；引用值显示定义位置；`$DEFINE` 显示值与定义位置；`Include source` / `xi:include href` 显示解析后的目标文件；`xi:include` 元素与属性给出 XInclude 说明。
- **引用导航**：从引用值（`CommandSet="..."`、`Weapon="..."`、`inheritFrom`）跳转到定义（严格按引用类型过滤，候选由 `ra3modxml.definitionMode` 控制：`all` 列出 mod + 原版、`project-only` 优先项目内定义）；`Ctrl+点击` Include / `xi:include href` 打开目标文件；Find All References 搜索整个工作区；文档大纲列出顶层资产与 `$DEFINE`。
- **错误检查**：XML 格式错误、未知元素/属性（`xi:` 等外来命名空间不误报）、顶层资产缺 `id`、重复 ID、未解析引用（含类型不匹配）、Include / 嵌套 `xi:include` 目标找不到、`$DEFINE` 未定义。
- **manifest 支持**：`<Include type="reference">` 指向的 `static/global/audio.manifest`（SDK `builtmods`）会被解析，manifest 中的原版资产 ID 可用于补全/悬停/导航/诊断。

## 使用

1. 用 VS Code 打开 RA3 Mod 项目文件夹（含 `Data/Mod.xml` 或 `mod.babproj`）。
2. 插件自动激活并开始后台索引（状态栏显示资产数量）。
3. 编辑任意 `*.xml` 即可获得补全、跳转与诊断。

### 设置（`settings.json`）

| 设置 | 默认值 | 说明 |
|---|---|---|
| `ra3modxml.sdkPath` | `C:\Apps\RA3-MODSDK-X` | Mod SDK 根目录 |
| `ra3modxml.indexSageXml` | `true` | 是否索引 SDK 的 `SageXml` 原版源码 |
| `ra3modxml.reportUnresolvedReferences` | `warning` | 未解析引用诊断级别（`warning`/`information`/`none`） |
| `ra3modxml.diagnoseUnknownElements` | `true` | 是否报告未知元素/属性（自定义 XSD 项目可关闭） |
| `ra3modxml.definitionMode` | `all` | 跳转候选：`all` 列出 mod 定义与原版定义（mod 优先）；`project-only` 仅在项目内已有定义时直接跳转 mod 定义 |
| `ra3modxml.additionalDataSearchPaths` | `[]` | 追加的 `DATA:` 搜索目录 |

### 命令

- `RA3 Mod XML: Re-index workspace`：手动重建索引。
- `RA3 Mod XML: Show index report`：查看索引统计。

## 开发

```powershell
npm install
npm run generate-model   # 从 SDK XSD 重新生成 src/model/schema-model.json
npm test                 # 单元测试（tsc + node --test）
npm run build            # esbuild 打包到 dist/
npm run package          # 生成可安装的 .vsix
```

测试夹具：`test/fixtures/minimod`（含 include、重复 ID、同名不同类型 ID、manifest 回退等场景）。

## 架构

```
src/
  extension.ts            激活入口与 provider 注册
  workspace.ts            项目检测、索引生命周期、状态栏
  settings.ts             配置读取（sdkPath、definitionMode 等）
  language/
    xmlParser.ts          带源码偏移的轻量 XML 解析器（容错、行尾恢复）
    context.ts            补全上下文分析
    typeContext.ts        上下文感知元素类型解析
    semanticTokens.ts     语义 token 兜底高亮（纯 TS）
  model/
    schemaModel.ts        XSD 模型运行时（schema-model.json / asset-types.json 由 tools 生成）
  indexer/
    includeResolver.ts    Include 路径解析（纯 TS，移植 check_duplicate_ids.py）
    manifestParser.ts     .manifest 二进制解析（移植 OpenSAGE ManifestFile.cs）
    fileScanner.ts        目录扫描与 Include source 候选
    refs.ts               引用目标解析（按引用类型过滤）
    indexer.ts            工作区索引器（后台、缓存、增量重建）
  features/               completion / hover / navigation / diagnostics / semanticTokens
syntaxes/                 TextMate 注入语法
tools/                    XSD → 模型、AssetType 枚举提取
```

解析/索引核心不依赖 VS Code API，可被其他工具复用（见 `docs/plan.md` 的远期目标：搜索与索引复用）。

## 参考

- 领域说明与需求：`docs/requirements.md`
- 调研与设计决策：`docs/plan.md`
- 问题分析与修复记录：`docs/analysis-issues.md`
- Manifest 格式参考：OpenSAGE `src/OpenSage.Game/Data/StreamFS/ManifestFile.cs`（本仓库 `OpenSAGE/` 子目录，commit `d45d361`）
