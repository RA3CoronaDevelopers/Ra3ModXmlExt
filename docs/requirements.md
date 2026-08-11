# RA3 Mod XML VSCode 插件 — 情况描述与需求清单

> 由 `prompts` 中的零散描述整理而成。目标产物：一个用于编辑《命令与征服：红色警戒 3》Mod XML 文件的 VS Code 扩展。

## 一、情况描述（整理后）

红警 3 的 Mod 数据以 XML 文件组织，由 EA 的 BinaryAssetBuilder（BAB）编译。一个 Mod 项目通常包含两类数据：

1. **基础数据（Static Data）**：单位、武器、建筑、贴图、音频、AI、UI 等绝大多数内容。入口文件是 `Data/Mod.xml`。
2. **全局数据（Global Data）**：无法放进基础数据里的全局配置（游戏设置、全局单例等）。入口是 `Data/additionalmaps/mapmetadata_*.xml` 这类文件——它们原本是 EA 的地图元数据文件，但因为加载最早且允许写任意标签，被 modder 用作“全局数据”入口。

XML 之间的组织靠 `<Include>` 标签，共有三种语义：

| type | 语义 | 说明 |
|---|---|---|
| `reference` | 引用预编译 manifest | 不展开内容。典型用法是 `DATA:static.xml` / `DATA:global.xml` / `DATA:audio.xml` 这三个占位文件，实际对应 SDK `builtmods` 里已编译的 `static.manifest` / `global.manifest` / `audio.manifest` |
| `instance` | 源码级可见 | 不展开进当前文件，但编译时“看得到”目标源码；典型用于 `inheritFrom` 继承 |
| `all` | 内容合并 | 等价于把目标文件内容直接复制进来；`Mod.xml` 通过它递归聚合整个 Mod |

路径解析规则（来自现有工具 `check_duplicate_ids.py` 与编译脚本 `defaultscript.cs`）：

- 带前缀 `DATA:` / `ART:` / `AUDIO:` 的路径按固定搜索顺序查找；
- 无前缀的路径相对于当前文件所在目录；
- `ART:` 路径支持“文件名前两个小写字母作为子目录”的匹配（如 `JUAntiShip` → `ju/JUAntiShip`）。

继承机制：`inheritFrom` 让一个元素默认获得目标元素的所有内容；具体合并行为由 `xai:joinAction`（`uri:ea.com:eala:asset:instance` 命名空间）控制，实际项目中出现的取值为 `Replace`、`Remove`。XSD 只在 `BaseInheritableAsset` 上显式声明 `inheritFrom`，但原版与 Corona 数据也在 `FXList`、`AIMicroManagerData` 等 `BaseAssetType` 系资产上使用它，插件按“所有资产类型的通用属性”处理。

全部 XML 语法由 XSD 定义：SDK 自带 `Schemas/xsd/CnC3Types.xsd`（及其 800+ 个子 XSD）。大型 Mod 项目（如 Corona）还会携带自己修改过的 XSD 副本。

## 二、需求清单

### P0：近期核心功能

1. **语法高亮**：为 RA3 Mod XML 提供可读的高亮；重点补充普通 XML 高亮之外的领域标记（如 `$DEFINE` 常量引用、`inheritFrom` 等）。
2. **自动补全**：
   - 元素名（按当前父元素的 XSD 定义补全，含顶层资产元素）；
   - 属性名（按当前元素的 XSD 定义补全，`id` 必填者优先）；
   - 属性值：
     - 引用型属性（XSD 中带 `xas:refType`）补全已定义的资产 ID；
     - `inheritFrom` 补全可继承的资产 ID；
     - 枚举值（XSD `xs:enumeration`）；
     - `$DEFINE` 常量（如 `$CIV_HEALTH_SMALL`）；
     - `<Include source>` 补全可解析的文件路径（`DATA:` / `ART:` / `AUDIO:`）。
   - **元素文本内容（simple content）**：带 `xas:refType` 的内容元素
     （simple type 如 `<CreateObject>ID</CreateObject>`，simpleContent 复杂类型
     如 `<Sound>AudioFile</Sound>`、`<Subsound>VoiceEvent</Subsound>`）在标签间
     补全对应类型的资产 ID、枚举或 `$DEFINE`；补全出的 simple-content 元素必须
     是可填值的成对标签（`<Name></Name>`），且内容区已输入 `<` 时不得产生 `<<`。
3. **引用提示（Hover）**：元素/属性悬停显示 XSD 文档、类型、默认值；资产 ID 悬停显示定义位置；`$DEFINE` 悬停显示值与定义位置。
   - 元素文本内容（simple content 引用）悬停同样显示定义位置。
4. **引用导航**：
   - 从引用型属性值跳转到对应资产定义（Go to Definition）；
   - 从 simple-content 引用元素（`<CreateObject>ID</CreateObject>`）的文本跳转到对应资产定义；
   - 查找某资产 ID 的所有引用（Find All References）；
   - `<Include source>` / `xi:include href` 直接打开目标文件；
   - `inheritFrom` 跳转到被继承元素；
   - 文档大纲：显示文件内的顶层资产元素。
5. **错误检查（实时诊断）**：
   - XML 格式错误（well-formedness）；
   - 未知元素 / 未知属性（相对 XSD 模型）；
   - 缺失必填 `id`（顶层资产）；
   - 重复 ID（同类型 + 同 id，mod 文件之间；覆盖原版 SageXml 不算冲突）；
   - 引用未解析（引用了不存在的资产 ID，可配置是否忽略原版 manifest 中的 ID）；
   - simple-content 引用元素的文本未解析（同属性引用规则，仅带 refType 的类型）。
   - `<Include>` 目标文件找不到、Include 循环；
   - `$DEFINE` 未定义。

**补充（工作区/项目检测，2026-08-07）**：
- 项目根不要求工作区精确匹配 `Data/Mod.xml`：从工作区文件夹向上最多 12 层、
  从打开的 XML 文件向上、以及从“包含多个 mod 的容器文件夹”向下浅扫最多 3 层
  均可发现项目根（`Data/Mod.xml`、`Data/additionalmaps/mapmetadata_*.xml`、
  `*.babproj` 任一标记命中即可，大小写不敏感、最近命中优先）。
- 多项目同时打开时按文档就近选择项目；单项目打开立即建索引，容器/多项目采用
  惰性索引（活动文档所属项目先建，其他在文档打开或首次请求时建），构建串行执行。

**补充（manifest 解析，支持 include reference 后的补全/导航/诊断）**：

- 当 `Mod.xml`（或其他文件）用 `<Include type="reference" source="DATA:static.xml" />` 引用占位文件时，实际内容来自 SDK `builtmods` 下对应的已编译二进制 manifest（`static.manifest` / `global.manifest` / `audio.manifest`）。
- 通过解析这些 manifest，可以得到其包含的全部资产（名称、类型、来源文件），从而：
  - **代码补全**：例如 reference 了 `audio.xml` 后，所有音频资产 ID 都能出现在引用型属性（如 `AudioEventRef`）的补全里；
  - **引用导航/悬停**：能定位资产来自哪个 manifest、哪个源文件；
  - **诊断**：能把“引用了 manifest 中的 ID”识别为已解析，而不是误报未解析引用。
- manifest 的 `sourceFileName`（如 `DATA:globaldata/weapon.xml`）是**原版编译
  时的源地址**，按 vanilla-only 搜索路径（SDK 根 + `SageXml`）解析，不能用当前
  mod 的 BAB 顺序解析——否则 mod 同名 DATA 路径会遮蔽 SageXml 源码。ART/AUDIO
  源码默认不映射（SDK 基本不提供）；SageXml 源缺失时保持 manifest-only，
  文件存在但 id 被删时降级到文件顶部。
- manifest 为二进制格式，解析逻辑参考 OpenSAGE `ManifestFile.cs`（用户已在本工作区 `OpenSAGE/` 克隆并切到指定 commit）。关键格式要点：
  - 头部含版本（5/6/7）、端序标志、各缓冲区大小、资产数量；
  - 每个资产条目含 `TypeId`（哈希）、`NameOffset`、`SourceFileNameOffset` 等；
  - `TypeId` 哈希 → 类型名的映射来自 OpenSAGE 的 `AssetType` 枚举（本工作区可提取）；
  - 资产名与源文件名各自存放在独立的空字符结尾字符串缓冲区中。

**补充（美术资产 `.w3x` 索引）**：
- `W3X.xml` / `ART:` include 链中的 `.w3x` 是文本 XML（建模工具导出，BAB 同样按
  XML 编译），其顶层资产（`W3DContainer` / `W3DMesh` / `W3DHierarchy` 等）应参与
  补全、悬停、导航与诊断——`Model@Name`、`Hierarchy`、`Mesh` 等引用依赖这些定义；
- 大模型文件（实测 Corona 最大 22.8 MB，顶点/三角形数据占大头）采用**顶层浅扫描**
  （不建 DOM 树），结果在 workspace 级缓存并跨重建复用，避免每次保存都重读整个
  美术资产目录（Corona 约 2.6 GB）；索引记录与 include 解析结果同样跨重建缓存，
  保存触发的重建零 stat、零重读（Corona 实测约 2 秒）。

**补充（引用计数、语义 Find All References 与未引用资产，2026-08-05）**：
- 每个顶部 asset 显示被引用次数（CodeLens，0 也显示），点击直接打开
  references peek；只在“设计上应被引用”的类型上显示，避免设置类/地图元数据/
  w3x 子结构等自动注册类型制造满屏 0；
- Find All References 改为基于语义引用索引（属性引用 + simple-content 文本 +
  `inheritFrom`，排除 id 定义点 / Poid / `$DEFINE`），不再全文搜索；
- 命令 `Find unreferenced assets…`：按类型列出所有零引用的项目定义并跳转；
  编辑器右键菜单 `Find unreferenced assets of this type` 预选光标所在类型；
- 设计文档见 `docs/features-reference-counts.md`。

### P1：非近期目标（本期不做，但预留扩展点）

6. **高效搜索**：Mod 项目巨大（Corona 约 7500 个 XML、38MB）时直接全文搜索很慢，需要一个高效的 XML 内容索引机制。
   （2026-08-05：语义引用索引已落地，FAR / 引用计数 / 未引用报告不再全文搜索；
   通用内容搜索与索引复用仍属远期。）
7. **索引机制的复用性**：希望索引不仅能服务 VS Code 插件，也能被其他工具（如搜索、静态分析）复用，因此索引/解析核心应设计成与编辑器无关的纯模块。

## 三、环境与参考资源

- SDK：`C:\Apps\RA3-MODSDK-X`（含 `defaultscript.cs` 编译脚本、`Schemas/xsd`、`SageXml` 原版源码、`builtmods` 编译产物）。
- 中小项目：`C:\Apps\RA3-MODSDK-X\Mods\AttachTest`、`D:\Mods\CoronaMod\mods\mods\GenEvoTest`。
- 大型项目：`D:\Mods\CoronaMod\mods\mods\corona`（自带 `xsd/`）。
- 现有工具：工作区 `check_duplicate_ids.py`（include 解析与重复 ID 检测的参考实现）。
- manifest 格式参考：OpenSAGE `src/OpenSage.Game/Data/StreamFS/ManifestFile.cs`
  （commit `d45d361`，本仓库 `OpenSAGE/` 子目录）。插件已实现 v5/v6/v7 二进制
  解析（`src/indexer/manifestParser.ts`），未知 TypeId 哈希时按资产名前缀推导类型。

## 四、验收标准

- 在 AttachTest / GenEvoTest 上开箱即用（高亮、补全、跳转、诊断）。
- 打开 mod 的 `Data` 文件夹、`Data` 子文件夹、仅含 mapmetadata 的项目、
  单个 XML 文件、以及“内部包含多个 mod”的容器文件夹时均能正确发现项目根；
  多项目打开时各自索引与功能互不串扰。
- 在 Corona 规模的目录上不卡 UI：索引在后台执行、保存文件后增量更新。
- 纯解析/索引核心不依赖 VS Code API，可被其他工具复用。
- 可用 `vsce package` 打出可安装的 `.vsix`。
