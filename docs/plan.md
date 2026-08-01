# 调研结论与实施计划（已按最新代码同步更新）

> 说明：本文档随实现演进持续同步。最近一次同步（2026-08-01）对齐了实现过程中新增的模块与设计变更：BAB 精确搜索路径、manifest 类型/ID 推导、上下文感知元素类型、属性级 refType / Poid 局部引用（`id` 定义点）、精确跳转范围、嵌套 `xi:include`、注入式语法高亮等。

## 一、调研结论（带证据）

### 1. Include 解析规则（证据：`check_duplicate_ids.py` + `defaultscript.cs`）

从 `Data/Mod.xml` 递归处理 `<Include type="all">`（以及任意层级的 `xi:include`）。路径解析按 `defaultscript.cs` `getIncludePaths()` 的编译参数（`/data /art /audio`，`.` 为 SDK 根目录）：

- `DATA:`：SDK 根 → modGranParent → 项目 `Data` → `SDK\Mods` → modParentPath → `SDK\SageXml`
- `ART:`：SDK 根 → modGranParent → 项目 `Art1` → 项目 `Art` → `SDK\Mods` → modParentPath → `SDK\Art`
- `AUDIO:`：SDK 根 → modGranParent → 项目 `Audio1` → 项目 `Audio` → `SDK\Mods` → modParentPath → `SDK\Audio`

其中 modParentPath = 项目目录的父目录，modGranParent = modParentPath 的父目录（如 AttachTest 位于 SDK 内时二者都收敛到 SDK 目录）。无前缀路径相对于当前文件目录解析；`ART:` 支持 2 字母前缀匹配。`defaultscript.cs` 第 4 步“建立全局数据”按 `additionalmaps\mapmetadata_*.xml` 逐个编译；第 5 步“建立基础数据”编译 `Data/Mod.xml`。

### 2. 文件规模（证据：实测统计）

- Corona `Data`：**7540 个 XML / 38.1 MB**
- SDK `SageXml`：**5976 个 XML / 21.4 MB**
- 合计约 1.3 万个文件、60 MB → 索引必须后台化、缓存解析结果、按需惰性加载。

### 3. XSD 结构（证据：`Schemas/xsd` 实测）

- 共 **821 个 XSD / 1.5 MB**，入口 `CnC3Types.xsd`。
- 根元素 `AssetDeclaration`：`Tags` / `Includes` / `Defines` + **295 个顶层资产元素**（含内联声明）。
- 每个元素名对应一个 `complexType`，子元素用 `xs:sequence` / `xs:choice` 定义，属性用 `xs:attribute` 定义；复杂类型通过 `xs:extension` 继承（如 `BaseInheritableAsset` 提供 `inheritFrom`）。
- `Includes/Ref.xsd` 定义了大量带 `xas:refType="<资产类型>"` 的引用类型（如 `CommandSet` 引用 `LogicCommandSet`）→ 补全/导航按引用类型过滤的依据。
- `XmlEdit:Default` 提供默认值；`xs:enumeration` 提供枚举值。`xas:refType` 可声明在 simple type 上，也可声明在 `<xs:attribute>` 节点上（模型生成器两者都读、属性级优先）。
- `Poid`（"Pipeline Object Id"，`xas:isWeakRef="true"`）表示**管线局部标识**：`id` 属性定义元素自身（如 `ModuleData@id` → refType `ModuleData`）；`ModuleId`、`AutoResolveBody`、`SoundRef` 等 Poid 属性引用同一资产/子树内的模块、子对象、材质——它们都不对全局资产索引做 resolved 判定。
- **同名元素在不同父节点下类型不同**（如 `<Weapon>` 在武器槽下是 `WeaponSlot_WeaponData`，在别处可能是 `WeaponRef`）→ 需要上下文感知解析。

### 4. 领域特有约定

- `$NAME` / `=$NAME` 是 `<Defines>` 中定义的常量引用（Corona `GlobalData/GlobalDefines.xml` 实测），属性值补全与 hover 支持。
- `xai:joinAction` 实测取值 `Replace`、`Remove`。
- 原版数据双来源：SDK `SageXml` 提供 XML 源码；`reference` 指向的编译 manifest 提供完整资产表（含美术素材）。

### 5. 网络与工具链（证据：本机实测）

- Node v24.16.0、npm 11.13.0、VS Code 1.130 可用；无全局 `vsce`、Python 不可用。
- npm 注册表可用（需提升权限安装依赖）；esbuild 原生二进制在沙箱内受限，构建需提升权限。

### 6. manifest 二进制格式（证据：工作区 `OpenSAGE/` 源码）

用户已克隆 OpenSAGE 并切到 `d45d361`，`src/OpenSage.Game/Data/StreamFS/ManifestFile.cs` 给出完整格式：

- 头部：首 4 字节为 0 时版本固定为 7；否则 `IsBigEndian`(1B) + `IsLinked`(1B) + `Version`(u16，5/6) + 10 个 u32 缓冲区/计数信息。
- 资产条目（版本 ≥ 6 时每条 48B）：`TypeId`/`InstanceId`/`TypeHash`/`InstanceHash`/`AssetReferenceOffset`/`AssetReferenceCount`/`NameOffset`/`SourceFileNameOffset`/`InstanceDataSize`/`RelocationDataSize`/`ImportsDataSize`。
- 之后依次是：资产引用缓冲区、被引用 manifest 名缓冲区、资产名字符串缓冲区、源文件名字符串缓冲区。
- `TypeId` 为哈希；OpenSAGE `AssetType.cs` 枚举提供部分哈希→类型名映射（**不完整**：`Global.manifest` 11268 个资产中 2707 个哈希未知，如 `PlayerTemplate`）。
- **实测发现**：manifest 资产名是 `类型名:ID` 格式，美术资产还带子类型段（`W3dContainer:W3DContainer:AUANTIVEHICLEVEHICLETECH1_SKN`）。类型可从第一个冒号段推导，可引用 ID 取最后一个冒号段。

**结论**：manifest 解析为 P0 能力，用于 reference include 的资产补全/悬停/导航/诊断。

## 二、技术方案

### 选型

- **TypeScript + VS Code 扩展 API（非 LSP）**：补全 / hover / 跳转 / 诊断 / 大纲均用原生 provider，无需语言服务器进程。
- **核心与编辑器解耦**：`language/`、`model/`、`indexer/` 为纯 TS 模块（不 import `vscode`），可单测与复用（呼应 P1 需求 7）。
- **esbuild 打包**，产物 `dist/extension.js`。
- **XSD → JSON 模型**：开发期工具 `tools/xsd-to-model.mjs` 把 821 个 XSD 解析成 `schema-model.json`（元素树、属性、文档、枚举、引用类型映射），随插件发布；运行时不再解析 XSD。
- **运行时 XML 解析**：自研带源码偏移的轻量解析器 `language/xmlParser.ts`（标签/属性/值均记录起止偏移，容错解析以支持输入中的补全与诊断；未闭合引号在行尾恢复，避免吞掉整个文档）。`fast-xml-parser` 仅用于开发期 XSD 生成。
- **AssetType 哈希表**：`tools/extract-asset-types.mjs` 从 OpenSAGE `AssetType.cs` 提取 `asset-types.json`；哈希未知时以 manifest 名称前缀推导类型。

### 架构

```
src/
  extension.ts         激活入口（provider 注册、索引调度、诊断调度）
  workspace.ts         项目检测（Data/Mod.xml / mod.babproj）、索引生命周期、状态栏、重建防抖
  settings.ts          配置读取（sdkPath、indexSageXml、definitionMode 等）
  language/
    xmlParser.ts       带源码偏移的轻量 XML 解析器（格式错误定位、容错）
    context.ts         补全上下文分析（元素名/属性名/属性值/内容）
    typeContext.ts     上下文感知元素类型解析（resolveElementType 沿解析树逐层解析）
    semanticTokens.ts  语义 token 兜底高亮（纯 TS：标签/属性/值范围，仅 malformed 时启用）
  model/
    schemaModel.ts     schema-model.json 的类型/属性/子元素查询 + 类型名规范化（纯 TS）
    schema-model.json  由 tools/xsd-to-model.mjs 生成
    asset-types.json   由 tools/extract-asset-types.mjs 生成（TypeId 哈希→类型名）
  indexer/
    includeResolver.ts Include 路径解析（纯 TS，BAB /data /art /audio 顺序）
    manifestParser.ts  .manifest 二进制解析 + 类型/ID 推导（纯 TS）
    fileScanner.ts     目录遍历缓存 + Include source 候选收集
    refs.ts            引用目标解析（按 refType / isRef / inheritFrom 过滤，纯 TS）
    indexer.ts         工作区索引器（资产/Define/流/manifest 合并，LRU 解析缓存）
    types.ts           共享类型
  features/
    completion.ts      补全 provider（元素/属性/值，上下文感知；xs:list 多值按当前段过滤）
    hover.ts           hover provider
    navigation.ts      定义/引用/文档链接/大纲
    diagnostics.ts     实时诊断
    semanticTokens.ts  语义 token provider（文档有解析错误时接管着色）
syntaxes/
  ra3modxml.tmLanguage.json   注入 source.xml 的领域高亮（纯注入，不替换 XML 主语法）
tools/
  xsd-to-model.mjs       XSD → schema-model.json（含 xs:list：继承 item 枚举/引用语义，isList 标记）
  extract-asset-types.mjs OpenSAGE AssetType.cs → asset-types.json
test/
  fixtures/minimod      样例 Mod（include 各种情形、同名 ID、嵌套 xi:include、manifest 回退）
  *.test.mjs            11 个测试文件（xmlParser / context / completion / semanticTokens /
                        includeResolver / manifestParser / indexer / schemaModel / refs /
                        typeContext / manifestTypes）
```

### 关键设计决策

1. **语言激活范围**：不劫持 `*.xml`。通过 `workspaceContains:**/Data/Mod.xml`、`**/*.babproj` 激活；语法高亮为**纯注入** grammar（不声明 `language`，避免覆盖内置 XML 语法）。
2. **索引范围与默认值**：索引“项目 Data + additionalmaps + 沿 include 可达的 SageXml 原版源码”；SDK 路径默认 `C:\Apps\RA3-MODSDK-X`（可配置）。`reference` include 解析为 `builtmods` 下对应 manifest（惰性解析、按文件缓存），manifest 缺失/无效时回退到占位 XML。
3. **manifest 资产建模**：类型优先用哈希表，未知时从名称前缀推导；可引用 ID 取最后冒号段；类型名统一走大小写规范化（`W3dContainer` ↔ `W3DContainer`），类型匹配严格遵循 XSD 继承链。
4. **上下文感知元素类型**：同名元素按父元素类型解析（`resolveElementType` 沿解析树逐层 `childTypeOf`，失败回退全局映射），保证 `<Weapon>` 等元素的属性/引用判定正确。
5. **引用判定与解析**：`refType` 或 `isRef` 均视为引用；带 `refType` 时严格按类型过滤（同名 ID 不串类型）；`inheritFrom` 按可继承类型过滤。**局部作用域例外**（`isLocalReferenceAttribute`）：`id` 是元素自身的定义点——无 refType 或 refType 与自身类型兼容时不检查、不解析（`RoadObject@id→Road` 这类跨类型 id 引用保留检查）；Poid 类型属性是管线局部引用，全局索引无法判定，不检查、不解析。
6. **重复 ID 诊断**：与 `check_duplicate_ids.py` 一致——SageXml 不参与冲突判定，mod 覆盖原版视为正常。
7. **未解析引用诊断**：按设置严重级别报告（默认 warning）；类型不匹配时给出明确文案（"有同名 ID 但类型不匹配"）。`definitionMode` 设置控制跳转候选：`all`（mod + 原版全部列出，mod 优先）或 `project-only`。
8. **跳转精度**：XML 定义跳转到 `id` 属性值的精确 Range；manifest 定义映射到源码文件（如 SageXml）时也在文件内精确定位；找不到再回退到记录行。
9. **嵌套 `xi:include`**：任意层级处理——目标缺失产生诊断、目标存在则纳入索引；根级 `xpointer` 容器内容按顶层资产索引。
10. **性能**：索引在后台执行；解析结果 LRU 缓存（约 64 个文档）；文件保存后防抖全量重建（1.5s），重建期间的新请求标记脏并在完成后重跑；状态栏显示进度与统计。
11. **`xs:list` 建模与多值补全**：list 简单类型继承 itemType 的枚举 / refType / isRef /
    allowsDefine 并标记 `isList`（`LocomotorSurfaceBitFlags`、`KindOfBitFlags` 等 79 个
    类型、317 处属性声明受益）；补全只对“最后一个空格段”过滤，替换范围只覆盖当前段，
    支持 `Surfaces="GROUND ` 之后继续输入 `W` 提示 `WATER`。
12. **未闭合引号的行尾恢复**：起始标签扫描到 EOF 且引号未闭合时，在第一个换行处截断
    标签并继续解析，未闭合只影响当前行（仍上报 `Unterminated start tag`），后续元素
    的补全 / hover / 诊断不中断。
13. **语义 token 兜底高亮**：TextMate 对未闭合引号会把后续内容当字符串吞掉（任何
    XML 编辑器皆然）；扩展注册 `DocumentSemanticTokensProvider`，仅当解析报错时用
    语义 token 覆盖标签名 / 属性名 / 属性值（标准 token 类型 `type` / `property` /
    `string`，主题自带配色）。合法文件返回空，观感与纯 TextMate 完全一致。

## 三、实施步骤

1. [x] 调研（Include 规则、XSD、示例项目、规模、工具链）——见本文档第一部分。
2. [x] 脚手架：`package.json`、`tsconfig.json`、esbuild、`.vscodeignore`、README。
3. [x] 生成模型：`schema-model.json`（XSD，295 顶层元素 / 1851 类型）与 `asset-types.json`（79 个 AssetType 哈希）。
4. [x] 纯 TS 核心：include 解析、manifest 解析、XML 解析封装、索引器、引用解析。
5. [x] 功能层：补全、hover、导航、诊断、大纲、高亮 grammar。
6. [x] 单测（fixture Mod，53 个用例全绿：含 xs:list 枚举、未闭合引号恢复、list 多值
   分段、带 vscode stub 的补全集成、语义 token 兜底）+ 编译 + `vsce package` 打包
   （ra3-mod-xml-0.1.0.vsix，约 495KB）。
7. [x] 在 AttachTest / GenEvoTest / Corona 上做冒烟验证，并按真实项目反馈修复问题（详见 `docs/analysis-issues.md` 六轮分析）。

## 四、验证结果（实测）

| 项目 | 规模 | 索引耗时 | 资产数 | 说明 |
|---|---|---|---|---|
| AttachTest | 71 文件 | ~0.6s | 35,546（manifest 35,322） | 2 个流（static + mapmetadata） |
| GenEvoTest | 24 文件 | ~1.8s | 35,392（manifest 35,322） | 项目 ID（alliedmcv 等）正确收录 |
| Corona | 3,448 文件（+ 非 XML 资产路径） | ~54.5s | 55,305（manifest 35,322） | 3 个流、183 个 Define、0 诊断 |

单元测试覆盖：XML 解析（自闭合/容错/偏移/未闭合引号行尾恢复）、补全上下文（未闭合引号仍为 attribute-value、list 多值分段）、补全集成（vscode stub 下 `LocomotorTemplate@Surfaces` 未闭合引号枚举补全、空格后第二段过滤与替换范围）、语义 token（标签/属性/值范围、合法文档返回空、malformed 返回兜底 token）、include 解析（BAB 顺序、SDK 根优先于 SageXml）、manifest 二进制解析（合成 v5 样本、类型/ID 推导）、索引器（资产/Define/流/缺失 include/嵌套 xi:include）、XSD 模型（上下文类型、`childTypeOf`、大小写规范化、属性级 refType、外来命名空间判定、`xs:list` 枚举继承与 `isList` 标记）、引用过滤（`Weapon="X"` 只跳 `WeaponTemplate`、模块 `id` 定义点、Poid 局部引用、`xi:include` 不校验、`Side="Allies"` 命中 manifest 的 `PlayerTemplate`）。

> 注：`D:\Mods\CoronaMod` 位于移动硬盘，当前未连接；GenEvoTest / Corona 的回归需在 D: 盘可用时补跑（用户会另行通知）。

## 五、假设与开放问题

- 假设 SDK 路径默认 `C:\Apps\RA3-MODSDK-X`（与 prompts 一致），可在设置中修改。
- 假设补全/导航以“文本语义分析”为主，不做完整 XSD 校验（BAB 才是权威校验器）。
- 开放：是否发布到 VS Code Marketplace（需要 publisher）——本期先保证本地 `vsce package` 可安装。
- 开放：**“宏展开”式虚拟合并**（用户提议，方向已确认）：解析前先把 `xi:include`
  （以及顶层 `<Include type="all">`、`inheritFrom` 继承合并）展开成不含 include 的
  文档树，再对展开后的树做 XSD 校验、补全与诊断——与 BAB 编译时把整个 Mod 合并成
  一份大 XML 的行为一致。展开树需携带**来源追溯**（错误/跳转仍定位到原始文件），
  并处理 xpointer 子集解析与 include 循环。当前仅做到：目标文件可索引、可导航、
  缺失可诊断；`xi:include` 本身不参与 XSD 校验（第五轮）。
  该功能也是“GameObject 内模块 id 局部作用域解析”（第四轮遗留）的地基。
  详细设计备忘见下一节。

## 六、include 展开设计备忘（2026-08-01，待实施）

> 目的：集中记录 include 处理相关的现状、结论与设计，下次遇到 include 问题时从这里继续，
> 并在实施后把结果回写本节。

### 1. 现状（截至第五轮，已实现）

| 能力 | 状态 |
|---|---|
| `<Include type="all">` / `instance` 递归索引（顶层资产、流、Define） | 已实现（indexer `walk`） |
| `reference` → builtmods manifest 解析 / 缺失回退占位 XML | 已实现 |
| 嵌套 `xi:include`（任意层级）：目标可索引、缺失报 `include-not-found`、Ctrl+点击跳转、`href` hover 解析目标 | 已实现（第二轮 + 第五轮） |
| `xi:include` 及其属性不参与 XSD 校验（外来命名空间守卫 `isXsdElementName` / `isXsdAttributeName`） | 已实现（第五轮） |
| include 目标内容“虚拟合并”进父文档的逻辑树 | **未实现**（本文档主题） |

### 2. 已确认的方向

先展开成不含 include 的文档树（类比 C++ 宏展开），再对展开后的树做 mod XML 解析。
BAB（`defaultscript.cs`）编译时正是这样把整个 Mod 合并成一份大 XML 的。

### 3. 关键设计决策：逻辑树拼接，不做文本拼接

- **不要**把 include 目标展开成文本再整体重新解析：源码偏移会断裂，诊断 / 跳转 / hover /
  补全全部无法映射回原始文件。
- **要做**的是：解析器逐文件解析（现状不变）；展开器把目标文件选中节点按 `xpointer`
  子集挂进父元素，节点保留各自的源文件与原始偏移（来源追溯）。后续分析跑在逻辑树上，
  范围映射按节点 `sourceFile` 回到对应文件的 lineMap。
- 现有 `parseXml` 已记录标签 / 属性 / 值的起止偏移，`XmlElement` 结构可直接复用；拼接时
  用浅拷贝节点壳并重建 parent 链，避免破坏目标文件缓存树自身的 parent 指针。

### 4. 展开范围

| 构造 | 拼入逻辑树 | 理由 |
|---|---|---|
| `xi:include` | ✅ | 内容并入父元素（HeadlightDraw2 场景） |
| EA `<Include type="all">` | ✅ | BAB“内容合并”，等价于复制进来 |
| `type="instance"` | ❌ | 只影响编译可见性；拼树会把 BaseVehicle 的顶层资产错误塞进当前文档 |
| `type="reference"` | ❌ | manifest 编译产物，无文本内容 |
| `inheritFrom` + `xai:joinAction` | 单独一轮 | 元素级继承深合并（Replace/Remove），不是宏展开 |

### 5. 落地位置与接入点

- 新纯模块（与编辑器解耦，呼应 P1）：输入 `(parse 树, resolveSource 回调, readDocument 回调)`，
  输出逻辑树（root + elements 扁平列表，沿用 diagnostics 的遍历形态）。
- 接入：diagnostics / hover / navigation / completion 目前各自 `parseXml(text)`；
  改为 parse 后过 expander 取逻辑树；范围映射按节点 `sourceFile` 选对应文件的 lineMap。
- 按需展开（当前打开文档）+ 按文件缓存（复用 indexer `readDocument` 的 LRU）；
  环 / 深度守卫复用现有 `visitedAll` 与深度限制思路（建议最大深度 64）。
- `xpointer`：仅支持 mod 实际使用的 `xmlns(n=...) xpointer(/n:Name/child::*)` 子集
  （现有 `findXPointerContainer` 正则已覆盖）；完整 XPath 暂不支持，遇到新形式先记录到本节。

### 6. 后续收益（承接第四 / 五轮遗留）

- **GameObject 内模块 id 局部作用域**：展开后 include 进来的兄弟模块（HeadlightDraw2）
  与本体模块同树，`AttachModuleId` / `ModuleId` / `AutoResolveBody` 等 Poid 引用
  才能静态解析与诊断（第四轮遗留）；
- 跨 include 的上下文类型解析与结构校验；
- 顶层 `type="all"` 合并后，当前文档视角的重复 id / 引用诊断更接近 BAB 结果。

### 7. 风险与边界

- 大文件性能（Corona 约 7500 文件 / 38MB）：只展开当前文档的可达链，不全局展开；
- include 环 / 深度：visited 集合 + 最大深度；
- 被包含内容的诊断上报位置：建议按节点源文件 URI 上报（与偏移一致），包含点的 `href`
  上只报“缺失 / 无法解析 / 环”类问题；
- `inheritFrom` 深合并（`xai:joinAction` 的 Replace/Remove 语义）单独设计，别与宏展开混在一轮。

### 8. 下次遇到 include 问题的检查清单

1. 现象发生在哪一层：索引（indexer）、诊断（diagnostics）、导航 / hover、还是补全？
2. 现状能力是否已覆盖（见第 1 节表格）；
3. 涉及内容是否跨文件（需要逻辑树）还是本文件内（当前解析树即可）；
4. 若要展开：先实现第 5 节的纯模块与单测（fixture 增加 HeadlightDraw2 场景），再接入 feature；
5. 把新结论回写本节与 `docs/analysis-issues.md`。
