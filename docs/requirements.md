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

继承机制：`inheritFrom` 让一个元素默认获得目标元素的所有内容；具体合并行为由 `xai:joinAction`（`uri:ea.com:eala:asset:instance` 命名空间）控制，实际项目中出现的取值为 `Replace`、`Remove`。

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
3. **引用提示（Hover）**：元素/属性悬停显示 XSD 文档、类型、默认值；资产 ID 悬停显示定义位置；`$DEFINE` 悬停显示值与定义位置。
4. **引用导航**：
   - 从引用型属性值跳转到对应资产定义（Go to Definition）；
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
   - `<Include>` 目标文件找不到、Include 循环；
   - `$DEFINE` 未定义。

**补充（manifest 解析，支持 include reference 后的补全/导航/诊断）**：

- 当 `Mod.xml`（或其他文件）用 `<Include type="reference" source="DATA:static.xml" />` 引用占位文件时，实际内容来自 SDK `builtmods` 下对应的已编译二进制 manifest（`static.manifest` / `global.manifest` / `audio.manifest`）。
- 通过解析这些 manifest，可以得到其包含的全部资产（名称、类型、来源文件），从而：
  - **代码补全**：例如 reference 了 `audio.xml` 后，所有音频资产 ID 都能出现在引用型属性（如 `AudioEventRef`）的补全里；
  - **引用导航/悬停**：能定位资产来自哪个 manifest、哪个源文件；
  - **诊断**：能把“引用了 manifest 中的 ID”识别为已解析，而不是误报未解析引用。
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
  美术资产目录（Corona 约 2.6 GB）。

### P1：非近期目标（本期不做，但预留扩展点）

6. **高效搜索**：Mod 项目巨大（Corona 约 7500 个 XML、38MB）时直接全文搜索很慢，需要一个高效的 XML 内容索引机制。
7. **索引机制的复用性**：希望索引不仅能服务 VS Code 插件，也能被其他工具（如搜索、静态分析）复用，因此索引/解析核心应设计成与编辑器无关的纯模块。

## 三、环境与参考资源

- SDK：`C:\Apps\RA3-MODSDK-X`（含 `defaultscript.cs` 编译脚本、`Schemas/xsd`、`SageXml` 原版源码、`builtmods` 编译产物）。
- 中小项目：`C:\Apps\RA3-MODSDK-X\Mods\AttachTest`、`D:\Mods\CoronaMod\mods\mods\GenEvoTest`。
- 大型项目：`D:\Mods\CoronaMod\mods\mods\corona`（自带 `xsd/`）。
- 现有工具：工作区 `check_duplicate_ids.py`（include 解析与重复 ID 检测的参考实现）。
- manifest 格式参考：OpenSAGE `src/OpenSage.Game/Data/StreamFS/ManifestFile.cs`（commit `d45d361`，最新分支已移除该文件）。本机网络受限未能拉取，且 manifest 为压缩/哈希的二进制，本期不实现其解析。

## 四、验收标准

- 在 AttachTest / GenEvoTest 上开箱即用（高亮、补全、跳转、诊断）。
- 在 Corona 规模的目录上不卡 UI：索引在后台执行、保存文件后增量更新。
- 纯解析/索引核心不依赖 VS Code API，可被其他工具复用。
- 可用 `vsce package` 打出可安装的 `.vsix`。
