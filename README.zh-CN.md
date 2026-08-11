> This site is not endorsed by or affiliated with Electronic Arts, or its licensors. Trademarks are the property of their respective owners. Game content and materials copyright Electronic Arts Inc. and its licensors. All Rights Reserved.
>
> RA3 Mod XML is an unofficial fan-made tool. It requires a separately installed RA3 Mod SDK.

[English](README.md) | [**中文**](README.zh-CN.md)

# RA3 Mod XML

一款面向 **《命令与征服：红色警戒 3》** XML 模组的 VS Code 扩展，提供 **IntelliSense、导航、引用追踪与诊断** 能力。

它理解 RA3 Mod SDK 的 XML schema、资产类型、引用、include 以及原版游戏数据——编辑大型模组的体验会更接近真正的编程语言。

<table>
  <tr>
    <td align="center">
      <strong>智能补全</strong><br>
      <a href="https://ra3modxml-images.ratotal.workers.dev/enum_completion.gif">
        <img src="https://ra3modxml-images.ratotal.workers.dev/enum_completion.gif" alt="RA3 XML 智能补全" width="100%">
      </a>
    </td>
    <td align="center">
      <strong>转到定义</strong><br>
      <a href="https://ra3modxml-images.ratotal.workers.dev/navigation.gif">
        <img src="https://ra3modxml-images.ratotal.workers.dev/navigation.gif" alt="RA3 XML 导航" width="100%">
      </a>
    </td>
  </tr>
</table>

<p align="center">
  <strong>引用感知补全</strong><br>
  <a href="https://ra3modxml-images.ratotal.workers.dev/ref_completion.gif">
    <img src="https://ra3modxml-images.ratotal.workers.dev/ref_completion.gif" alt="RA3 XML 引用补全" width="80%">
  </a>
</p>

## 功能特性

### 智能补全

基于 RA3 XML schema 与项目数据，提供上下文感知的补全。

* 基于 RA3 XSD 的元素与属性
* 必填属性、类型、文档与默认值
* 资产引用，如 `Weapon`、`CommandSet` 与 `inheritFrom`
* 枚举值与标志位列表，如 `KindOf` 与 `Surfaces`
* 文本内容元素中的资产 ID，如 `<CreateObject>` 与 `<RequiredUpgrade>`
* `DATA:`、`ART:` 与 `AUDIO:` 路径
* 编辑标志位列表时的自动续写

引用补全是类型感知的，因此资产 ID 只会在其类型有效的位置被提示。

### 语法高亮

在保留内置 XML 语法的基础上，额外高亮 RA3 特有的结构。

### 导航与引用

直接在编辑器中浏览模组的资产关系图。

* 资产引用的**转到定义**（Ctrl+Click）
* 基于语义引用信息的**查找所有引用**
* **引用 CodeLens**：显示资产被引用了多少次
* 元素、属性、引用与 `$DEFINE` 的悬停信息
* `Include` 与 `xi:include` 的 Ctrl+Click 导航
* 顶层资产与 `$DEFINE` 的文档大纲

### 诊断

在编辑时发现常见的模组编写错误。

* XML 语法错误
* 未知元素与属性
* 缺失或重复的资产 ID
* 无法解析的资产引用
* 引用了错误的资产类型
* 未定义的 `$DEFINE`

### 项目分析

扩展可以分析整个工作区，而不仅仅是当前打开的文件。

**查找未引用的资产** 会列出工作区中任何地方都未被引用的项目资产，帮助识别过时或意外未使用的定义。

运行：

`RA3 Mod XML: Find unreferenced assets…`

你也可以使用编辑器右键菜单查找当前资产类型的未引用资产。

### 原版 SDK 集成

扩展可以使用 **RA3 Mod SDK** 中的资产定义，让原版游戏资产参与补全、悬停、导航与诊断。

当对应的 SDK 数据可用时，支持 `<Include type="reference">` 引用的 manifest，例如 SDK `builtmods` 目录下的 `static.manifest`、`global.manifest` 与 `audio.manifest`。

### 大型模组支持

工作区索引在后台运行，并使用持久化缓存，避免每次启动 VS Code 时都重建全部数据。

扩展已在大型 RA3 模组日冕 Mod 上测试：

- 32000+ 资产
- 8000+ XML 文件
- 3000+ W3X 文件
- **完整索引：** 约 3 分钟
- **缓存启动：** 约 40 秒校验缓存数据并重建内存索引

以上数据在机械硬盘上测得。实际性能取决于硬件与项目结构。

## 开始使用

1. 从 VS Code Marketplace 安装扩展。
2. 在 VS Code 中打开 RA3 Mod 项目文件夹。
3. 确保工作区包含 `Data/Mod.xml`、`Data/additionalmaps/mapmetadata_*.xml` 或 `*.babproj` 文件。
4. 如有必要，配置 RA3 Mod SDK 路径——扩展可以从 Windows 注册表自动检测已安装的
   SDK，也可以手动选择文件夹；留空则进入仅项目模式。
5. 打开任意 `*.xml` 文件开始编辑。

扩展会自动检测 RA3 Mod 工作区并在后台开始索引。当缺少 SDK 时，状态栏会给出提示，
并在每个会话中提供一次一键设置入口。

## 配置

| 设置                                | 默认值                  | 说明                                                                             |
| ----------------------------------- | ----------------------- | -------------------------------------------------------------------------------- |
| `ra3modxml.sdkPath`                 | *(空)*                   | RA3 Mod SDK 的路径；留空则禁用原版 SDK 功能（仅项目模式）                          |
| `ra3modxml.indexSageXml`            | `true`                  | 索引 SDK `SageXml` 目录中的原版 XML 定义                                          |
| `ra3modxml.reportUnresolvedReferences` | `warning`             | 无法解析引用的诊断级别：`warning`、`information` 或 `none`                       |
| `ra3modxml.diagnoseUnknownElements` | `true`                  | 报告未知的 XML 元素与属性                                                        |
| `ra3modxml.definitionMode`          | `all`                   | 导航引用时选择项目定义或原版定义                                                  |
| `ra3modxml.additionalDataSearchPaths` | `[]`                  | 额外的 `DATA:` 路径搜索目录                                                      |

如果已安装 SDK，扩展会从注册表检测到它并提供一键设置；也可以手动设置
`ra3modxml.sdkPath`，或使用 `RA3 Mod XML: Configure SDK path…` 命令。

## 命令

* `RA3 Mod XML: Re-index workspace`（重新索引工作区）
* `RA3 Mod XML: Show index report`（显示索引报告）
* `RA3 Mod XML: Clear caches and rebuild`（清除缓存并重建）
* `RA3 Mod XML: Configure SDK path…`（配置 SDK 路径）
* `RA3 Mod XML: Show cache report`（显示缓存报告）
* `RA3 Mod XML: Find unreferenced assets…`（查找未引用的资产…）
* `RA3 Mod XML: Find unreferenced assets of this type`（查找此类型的未引用资产）

## 环境要求

* Visual Studio Code
* 安装 Red Alert 3 Mod SDK，以获得完整的 schema 与原版资产支持
* 包含 `Data/Mod.xml`、`Data/additionalmaps/mapmetadata_*.xml` 或 `*.babproj` 文件的 RA3 Mod 项目

## 开发

```powershell
npm install

npm run generate-model   # 从 SDK XSD 生成运行时 schema 模型
npm test                 # 运行单元测试
npm run build            # 构建扩展
npm run package          # 打包 .vsix
```

测试夹具位于 `test/fixtures/minimod`，覆盖 include、重复 ID、同名不同类型 ID 以及 manifest 回退等场景。

## 架构

扩展围绕一个与 VS Code 无关的解析与索引核心组织：

```text
src/
  extension.ts
  projectRoot.ts
  workspace.ts
  settings.ts

  language/
    xmlParser.ts
    context.ts
    typeContext.ts
    semanticTokens.ts

  model/
    schemaModel.ts
    schema-model.json   # 生成的 XSD 模型，随扩展打包
    asset-types.json    # 生成的 AssetType 哈希表，随扩展打包

  indexer/
    includeResolver.ts
    existence.ts
    manifestParser.ts
    fileScanner.ts
    refs.ts
    referenceIndex.ts
    xpointer.ts
    logicalTree.ts
    localScope.ts
    shallowScan.ts
    records.ts
    caches.ts
    diskCache.ts
    indexer.ts
    types.ts

  features/
    completion.ts
    hover.ts
    navigation.ts
    references.ts
    codeLens.ts
    unreferenced.ts
    diagnostics.ts
    semanticTokens.ts

syntaxes/
  ra3modxml.tmLanguage.json   # 注入式领域语法（保留内置 XML 语法）

tools/
  xsd-to-model.mjs            # 从 SDK XSD 生成 schema-model.json
  extract-asset-types.mjs     # 从 OpenSAGE 提取 AssetType 哈希
```

## 参考

* OpenSAGE `ManifestFile.cs` — manifest 格式参考
