# RA3 Mod XML（VS Code 扩展）

面向《命令与征服：红色警戒 3》Mod XML（SAGE / BinaryAssetBuilder 格式）的 VS Code 工具扩展。

## 功能

- **语法高亮**：在普通 XML 高亮之上叠加领域标记（`$DEFINE` 常量、`inheritFrom`、`xai:joinAction`、结构标签）；XML 语法异常（如未闭合引号）期间由语义 token 兜底，标签/属性/值着色不中断。
- **自动补全**：
  - 元素名：按当前父元素的 XSD 模型补全子元素；顶层资产（`AssetDeclaration` 内）补全 `GameObject`、`WeaponTemplate` 等 295 种类型。已输入 `<` 时补全保留该 `<`、只替换名称区（不会出现 `<<`）；需要填文本的 simple-content 元素（如 `<CreateObject>`）补全为 `<CreateObject>$1</CreateObject>` 并自动弹出值补全，而不是无法填值的自闭合标签。
  - 属性名：必填属性优先，附带类型/文档/默认值；自动提示 `xai:joinAction` 与 `xmlns:xai`。接受补全时自动避免与上一个属性贴在一起，并按文件已有的排版补空格或换行（换行的基础缩进由编辑器提供，插件不再内嵌缩进以免叠加）；数字/角度/时间等标量属性直接填入 XSD 默认值或类型示例（如 `0d`、`0s`），引用/枚举/布尔等保留真正的 `$1` 占位符并弹出值补全。
  - 属性值：
    - 引用型属性（如 `CommandSet`、`Weapon`）按 `xas:refType` 补全对应类型的资产 ID（**同名 ID 只补全匹配类型**）；
    - `inheritFrom` 补全可继承的资产 ID；
    - 枚举与位标志列表（如 `Include type`、`LocomotorTemplate@Surfaces`、`KindOf`；列表值在空格后自动继续补全下一项，已使用的 flag 不再重复推荐，闭合值末尾可直接追加新 flag）；
    - 布尔值、`$DEFINE` 常量；
    - `<Include source>` 补全可解析的 `DATA:` / `ART:` / `AUDIO:` 与项目相对路径。
  - 元素文本内容：simple-content 引用元素（如 `<CreateObject>`、`<RequiredUpgrade>`、`<SpawnTemplate>`）直接在标签间补全对应类型的资产 ID（`GameObjectWeakRef` → GameObject）、枚举或 `$DEFINE`。
    接受片段后的 `$1` 光标位置会立即弹出值补全，而不是属性名；引用列表超过
    400 条时标记为不完整，继续输入会重新请求，因此 `CrateDebris_01` 这类排在
    列表后部的 id 不会因首屏截断而消失。
- **悬停提示**：元素/属性显示 XSD 文档、类型、必填/默认值；引用值显示定义位置；`$DEFINE` 显示值与定义位置；`Include source` / `xi:include href` 显示解析后的目标文件；`xi:include` 元素与属性给出 XInclude 说明。
- **引用导航**：从引用值（`CommandSet="..."`、`Weapon="..."`、`inheritFrom`、`<CreateObject>ID</CreateObject>` 等元素文本）跳转到定义（严格按引用类型过滤，候选由 `ra3modxml.definitionMode` 控制：`all` 列出 mod + 原版、`project-only` 优先项目内定义）；`Ctrl+点击` Include / `xi:include href` 打开目标文件；Find All References 同时搜索属性值与元素文本内容；文档大纲列出顶层资产与 `$DEFINE`。
- **当前文档局部作用域（T1）**：即使一个文件不在任何全局流里（没有从
  `Data/Mod.xml` / `additionalmaps` 可达），插件也会按当前文件自身的资产、
  `$DEFINE` 及其 include 链建立局部索引。`xi:include` 会在逻辑树中展开，
  使 include 进来的内容获得正确的父上下文；`AttachModuleId` / `ModuleId` /
  `AutoResolveBody` 等管线局部（Poid）引用可以补全、悬停与跳转到同一
  GameObject 内的模块（含通过 `xi:include` 拼入的兄弟模块）。
- **错误检查**：XML 格式错误、未知元素/属性（`xi:` 等外来命名空间不误报）、顶层资产缺 `id`、重复 ID、未解析引用（含属性值与元素文本内容、类型不匹配）、Include / 嵌套 `xi:include` 目标找不到、`$DEFINE` 未定义。
- **manifest 支持**：`<Include type="reference">` 指向的 `static/global/audio.manifest`（SDK `builtmods`）会被解析，manifest 中的原版资产 ID 可用于补全/悬停/导航/诊断。
- **美术资产（`.w3x`）**：`W3X.xml` / `ART:` include 链中的 `.w3x` 模型文件会被
  索引（`W3DContainer` / `W3DMesh` / `W3DHierarchy` 等顶层资产），因此
  `Model@Name`、`Hierarchy`、`Mesh` 等引用可以解析、悬停与跳转。超大模型
  （几十 MB 的顶点/三角形数据）采用浅扫描——只提取顶层资产记录、不建 DOM 树，
  结果在 workspace 级缓存并跨重建复用，保存文件触发的重建不会重读未变化的模型文件。
- **索引分阶段与部分可用性**：先建立 XML + manifest 索引（首建早期即可用），
  w3x 美术资产随后台扫描补齐。索引完成前，语法/模型诊断、枚举与子元素补全、
  Include 跳转/悬停照常工作；引用类诊断会“显示但标注”
  （`unresolved-reference-indexing` + `(index incomplete)` 说明），不会把
  未完成的索引误当成最终结论。
- **大项目性能**：索引记录（资产 / Define / Include / 行号）与 include 解析结果
  跨重建缓存，保存触发的重建零 stat、零重读（Corona 实测约 2 秒）；DOM 树只按需
  保留并设元素预算，避免内存膨胀。编辑器外的文件改动（git pull、导出工具）会
  触发防抖重建；构建期间文件再次被修改时，已发布索引会标记 `(stale)` 并自动重跑。
  include 路径解析使用目录枚举建立的文件集快照（无 statSync 风暴）；records
  缓存会持久化到磁盘（gzip + 多信号 stat 校验 + 原子写），重启 VS Code 后冷启动
  只需秒级校验，Corona 实测约 11 秒（首次全量约 2 分钟）。

## 使用

1. 用 VS Code 打开 RA3 Mod 项目文件夹（含 `Data/Mod.xml` 或 `mod.babproj`）。
2. 插件自动激活并开始后台索引（状态栏显示阶段与资产数量；扩展也会在打开
   任意 XML 文件时激活，非 RA3 工作区不会显示 RA3 专属功能）。
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
- `RA3 Mod XML: Clear caches and rebuild`：清空内存/磁盘缓存并强制全量重建。
- `RA3 Mod XML: Show cache report`：查看磁盘缓存路径、大小、校验统计与命中数。

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
    existence.ts          文件集存在性快照（目录枚举 Set，替代逐路径 statSync）
    manifestParser.ts     .manifest 二进制解析（移植 OpenSAGE ManifestFile.cs）
    fileScanner.ts        目录扫描与 Include source 候选
    refs.ts               引用目标解析（按引用类型过滤）
    xpointer.ts           xi:include xpointer 子集解析（纯 TS）
    logicalTree.ts        当前文档逻辑树（xi:include 拼接、局部作用域）
    localScope.ts         文档局部索引 overlay（自身链 + include 链）
    shallowScan.ts        .w3x 等大体积美术资产顶层浅扫描（纯 TS，不建 DOM）
    records.ts            每文件紧凑索引记录（资产/Define/Include/xi + 行号）
    caches.ts             跨重建持久缓存（DocumentCache / IndexRecordsCache /
                          IncludeResolveCache）+ 失效纪元 InvalidationsEpoch
    diskCache.ts          跨会话磁盘缓存（gzip JSON、原子写、多信号 stat 校验）
    indexer.ts            工作区索引器（后台、缓存、记录驱动重建、分阶段发布）
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
