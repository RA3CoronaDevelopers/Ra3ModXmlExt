# 调研结论与实施计划（已按最新代码同步更新）

> 说明：本文档随实现演进持续同步。最近一次同步（2026-08-11）对齐了实现过程中新增的模块与设计变更：BAB 精确搜索路径、manifest 类型/ID 推导、上下文感知元素类型、属性级 refType / Poid 局部引用（`id` 定义点）、精确跳转范围、嵌套 `xi:include`、注入式语法高亮、bit-flag 列表补全（空格触发 / 排除已用 / 追加模式）、simple-content 元素文本引用（补全 / hover / 跳转 / 诊断 / Find All References）、语义引用索引 / CodeLens 引用计数 / 未引用资产命令、属性补全换行判定与按 id 去重、manifest 源地址按 vanilla-only 解析（避免 mod 同名 DATA 路径遮蔽）、`assetsById` 保留同 id 的不同类型 manifest 定义等。

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
  projectRoot.ts       项目根发现（向上 / 容器向下 / 单文件，Data/Mod.xml、
                       mapmetadata_*.xml、*.babproj 标记，纯 TS 可单测）
  workspace.ts         多项目状态（按文档就近选项目、惰性索引、全局串行构建队列、
                       共享缓存、按项目磁盘缓存、watchers、状态栏、重建防抖）
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
    includeResolver.ts Include 路径解析（纯 TS，BAB /data /art /audio 顺序）+
                       manifest 源 vanilla-only 解析（SDK 根 + SageXml）
    existence.ts       文件集存在性快照（目录枚举 Set，替代逐路径 statSync）
    manifestParser.ts  .manifest 二进制解析 + 类型/ID 推导（纯 TS）
    fileScanner.ts     目录遍历缓存 + Include source 候选收集
    refs.ts            引用目标解析（属性 + 元素文本内容，按 refType / isRef /
                       inheritFrom 过滤，纯 TS）+ “设计上可被引用类型”判定
    referenceIndex.ts  引用记录 → 反向引用索引（定义 → 引用位置）+ 未引用报告
    shallowScan.ts     大体积美术资产（.w3x 等）顶层浅扫描（纯 TS，不建 DOM）
    records.ts         每文件紧凑索引记录（资产/Define/Include/xi/引用 + 行号偏移）
    caches.ts          跨重建持久缓存（DocumentCache / IndexRecordsCache /
                       IncludeResolveCache）+ 失效纪元 InvalidationsEpoch
    diskCache.ts       跨会话磁盘缓存（gzip JSON、原子写、多信号 stat 校验）
    indexer.ts         工作区索引器（资产/Define/流/manifest/w3x 合并，
                       分阶段：XML → art，中间快照可发布）
    types.ts           共享类型
  features/
    completion.ts      补全 provider（元素/属性/值，上下文感知；xs:list 多值按当前段过滤）
    hover.ts           hover provider
    navigation.ts      定义/引用/文档链接/大纲
    references.ts      语义 FAR / 引用上下文 / CodeLens 命令共享逻辑
    codeLens.ts        CodeLens 引用计数（类型过滤，0 也显示，点击开 references peek）
    unreferenced.ts    未引用资产 QuickPick 命令 + 右键菜单入口
    diagnostics.ts     实时诊断
    semanticTokens.ts  语义 token provider（文档有解析错误时接管着色）
syntaxes/
  ra3modxml.tmLanguage.json   注入 source.xml 的领域高亮（纯注入，不替换 XML 主语法）
tools/
  xsd-to-model.mjs       XSD → schema-model.json（含 xs:list：继承 item 枚举/引用语义，isList 标记）
  extract-asset-types.mjs OpenSAGE AssetType.cs → asset-types.json
test/
  fixtures/minimod      样例 Mod（include 各种情形、同名 ID、嵌套 xi:include、manifest 回退）
  *.test.mjs            16 个测试文件（xmlParser / context / completion / semanticTokens /
                        includeResolver / manifestParser / indexer / schemaModel / refs /
                        typeContext / manifestTypes / referenceIndex / codeLens /
                        referenceProvider / projectRoot / workspaceMulti）
```

### 关键设计决策

1. **语言激活范围与项目检测**：不劫持 `*.xml`。激活条件含 `onLanguage:xml`、
   `workspaceContains:Mod.xml`、`additionalmaps/mapmetadata_*.xml`、
   `**/Data/Mod.xml`、`**/Data/additionalmaps/mapmetadata_*.xml`、`**/*.babproj`；
   语法高亮为**纯注入** grammar（不声明 `language`，避免覆盖内置 XML 语法）。
   项目根通过 `src/projectRoot.ts` 发现：工作区文件夹向上最多 12 层、容器文件夹
   向下浅扫最多 3 层（跳过 Data/Art/builtmods/.git 等）、打开的 XML 文件向上，
   任一 `Data/Mod.xml`、`Data/additionalmaps/mapmetadata_*.xml`、`*.babproj`
   标记命中即算项目根（大小写不敏感、最近命中者优先）。多项目按文档就近选择：
   单个项目打开时立即建索引；容器/多项目时惰性建索引（活动文档所属项目先建，
   其他在文档打开/首次请求时建），构建经全局串行队列避免并发写共享缓存。
2. **索引范围与默认值**：索引“项目 Data + additionalmaps + 沿 include 可达的 SageXml 原版源码”；SDK 路径默认 `C:\Apps\RA3-MODSDK-X`（可配置）。`reference` include 解析为 `builtmods` 下对应 manifest（惰性解析、按文件缓存），manifest 缺失/无效时回退到占位 XML。
   **美术资产（.w3x）**：`<Include type="all">` / `ART:` 指向的 `.w3x`（及内容嗅探为
   XML 的未知扩展名文件）按其顶层资产入库（`W3DContainer` / `W3DMesh` /
   `W3DHierarchy` / `W3DCollisionBox` 等），使 `Model@Name`、`Hierarchy`、`Mesh`
   等引用可解析；大模型文件**浅扫描**（不建 DOM），结果缓存在 workspace 级、
   跨重建复用（详见设计决策 14）。
3. **manifest 资产建模**：类型优先用哈希表，未知时从名称前缀推导；可引用 ID 取最后冒号段；类型名统一走大小写规范化（`W3dContainer` ↔ `W3DContainer`），类型匹配严格遵循 XSD 继承链。`assetsById` 按 id 汇总**全部类型**的定义，去重身份为 `(type, file, line)`，同一 manifest 中同名但不同类型的美术资产（如 `W3DHierarchy:AUMCV_HOVER` 与 `W3DContainer:AUMCV_HOVER`）必须全部保留，避免 `Model@Name` 这类 `BaseRenderAssetType` 引用因先到的非渲染类型而被误判为未解析。
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
    支持 `Surfaces="GROUND ` 之后继续输入 `W` 提示 `WATER`。第十三轮（2026-08-04）
    补全触发与编辑体验：空格注册为触发字符；列表过滤排除已出现的 flag；当前段已是
    完整枚举值且没有更长变体时进入“追加模式”（零宽 range + `insertText=" FLAG"`，
    可直接在闭合值末尾/中间追加）；替换范围止于光标，中间插入不会删除尾部 flag。
12. **未闭合引号的行尾恢复**：起始标签扫描到 EOF 且引号未闭合时，在第一个换行处截断
    标签并继续解析，未闭合只影响当前行（仍上报 `Unterminated start tag`），后续元素
    的补全 / hover / 诊断不中断。第十三轮补充：恢复出的元素带 `recoveredStartTag`
    标记并补挂父链；补全上下文对“光标在恢复元素内但越过 `startTagEnd`”的情况按
    `text.slice(tagStart, cursor)` 重新解析部分标签，使多行书写的未闭合属性
    （如 `Disposition="`）仍可获得 attribute-value 补全，且不影响全局解析。
13. **语义 token 兜底高亮**：TextMate 对未闭合引号会把后续内容当字符串吞掉（任何
    XML 编辑器皆然）；扩展注册 `DocumentSemanticTokensProvider`，仅当解析报错时用
    语义 token 覆盖标签名 / 属性名 / 属性值（标准 token 类型 `type` / `property` /
    `string`，主题自带配色）。合法文件返回空，观感与纯 TextMate 完全一致。
14. **大体积美术资产浅扫描 + 跨重建持久缓存**（第八轮，2026-08-02）：
    - 实测 Corona：3788 个 w3x / 2.64 GB，163 个超过 4 MB，最大 22.8 MB；大文件是
      `W3DHierarchy` + 若干 `W3DMesh`（`Vertices/V`、`Triangles/T` 等 unbounded 数值
      载荷），顶层记录通常只有几个到二十几个。
    - 全量解析内存放大约 17 倍（6.3 MB 文本 → +109 MB DOM），不可接受；`scanXmlShallow`
      单次线性扫描只提取顶层 `name+id`、`<Includes>`、`<xi:include>`、`<Defines>`，
      22 MB 文件 ~600 ms、保留内存≈0。
    - 索引按扩展名三分：`.xml` 全量解析（4 MB 上限不变）；`.w3x` 浅扫描；
      未知扩展名嗅探文件头（`<` 开头、无 NUL）决定按 XML 浅扫描或二进制登记
      （manifest 是 `*.manifest` 二进制，不存在 `.manifestxml` 源码格式）。
    - `DocumentCache` / `ShallowScanCache` 由 `ModWorkspace` 持有，每次重建传入新的
      `ModIndexer`；按 `mtimeMs + size` 校验，未变化不重读。Corona 第二次构建
      w3x 重扫数为 0（4,829 次缓存命中）。
    - 读取整个文件不可避免（顶层边界需要全量扫描），但建 DOM 不是；优化的是
      "不分配子节点对象"与"跨重建不重读"，两者叠加后方案可行。
15. **重建零 stat + 记录驱动索引**（第九轮，2026-08-02，v0.1.1）：
    - 插桩发现每次重建（含信任重建）都有约 11 万次同步 `statSync`
      （`resolveSource` 的 include 存在性检查），机械盘上占 10-20s；
      `IncludeResolveCache` 按（目录 + source）缓存解析结果，内容编辑不清、
      创建/删除文件与强制 reindex 才清。信任重建 statSync 降到 0。
    - `IndexRecordsCache` 缓存每文件紧凑索引记录（顶层资产 / Define / Include /
      xi:include + 1-based 行号），信任重建完全不接触 DOM；`DocumentCache`
      双重淘汰（条数 LRU + 元素预算，超预算先淘汰最大树）把 DOM 常驻内存封顶。
    - w3x 缓存不再保留 LineMap（Corona 全量约 700MB），浅扫描直接产出带行号的记录。
    - 实测：Corona 信任二次构建 21s → **2.0s**（statSync 0）；首建后 2.5GB
      堆保留确认为构建期可回收垃圾，常驻 ~100MB；强制 reindex ~5-25s。
    - 候选目录扫描并行化；`stats` 新增 `candidatesMs` / `walkMs` / `resolveCalls` /
      `resolveCacheHits` 供索引报告定位耗时。
16. **分阶段索引与部分可用性**（第十轮，2026-08-03）：索引分两阶段发布——
    阶段 A（xml）只走 XML + manifest include 链，w3x 只登记进待扫队列；
    阶段 B（art）浅扫描队列并继续走 w3x 内的 include。阶段 A 结束即发布
    不可变快照（`snapshotIndex` 深拷贝嵌套 Map/数组），XML/枚举/语法类功能
    在首建早期即可用；引用类诊断在 `!complete || stale` 时“显示但标注”
    （code 为 `*-indexing`，消息注明 index incomplete）。快照携带
    `complete` / `phase` / `stale`，状态栏显示阶段。
17. **构建中失效与 stale 标记**（第十轮）：watcher 的 change / create /
    delete 均触发防抖重建；`InvalidationsEpoch` 记录失效次数，快照发布时若
    期间有失效则标记 stale，由 dirty 机制随后重建收敛；构建失败保留上一个
    快照而非清空索引。
18. **多信号文件 stamp**（第十轮）：`IndexedFile.stat` 扩展为
    `{ size, mtimeMs, birthtimeMs, ctimeMs }`，任一不匹配即重读，为磁盘
    持久化缓存铺路（FAT32 mtime 2s 粒度、工具保留 mtime 等场景）。
19. **文件集快照替代 statSync**（第十一轮，2026-08-03）：`ExistenceSnapshot`
    用**惰性按目录 readdir**（只读查询到的父目录，按目录缓存）回答 include
    存在性，覆盖根之外才 statSync 回退；盘符根不枚举。首版全量递归枚举使
    XML 阶段从 27s 涨到 45s，已改为惰性模式（复测 24.0s）。
    `stats.snapshotHits / snapshotFallbacks` 入报告；Corona 首建 75,926 次
    查询全部由快照回答、0 回退。
20. **磁盘持久化缓存**（第十一轮）：`DiskRecordsCache` 持久化 records 缓存
    （gzip JSON、原子写、identity key）；启动时并发 stat 多信号校验，不匹配
    丢弃重读；构建后异步回写。Corona 缓存仅 651 KB，冷启动约 11s（原
    ~2.5 分钟）。
21. **缓存命令**（第十一轮）：`ra3modxml.clearCache`（清内存 + 磁盘 +
    强制重建）、`ra3modxml.showCacheReport`（路径/大小/校验统计/命中数）。
22. **重建插桩**（第十一轮补充）：`buildCount` / `lastBuildTrigger`
    （initial、save、watcher-*、config、reindex、clear-cache、
    dirty-followup）进入索引/缓存报告；“RA3 Mod XML” 输出通道记录每次构建
    的触发原因、phase A 发布时间与完成耗时，用于定位“首建后又重建一次”
    之类的现象。
23. **watcher 噪声过滤与 URI 日志**（第十一轮补充）：watcher 事件把触发
    URI 写入输出通道；路径含 `.git` 段的事件直接忽略（后台 fetch /
    maintenance 会周期性触碰 `.git`，不应触发重建或 stale 标记）。
24. **watcher 内容白名单**（第十一轮补充）：临时文件命名模式
    （`.git`/`.tmp`/`.lock`/`~`/`.swp`/`.bak`/`.orig` 后缀、`.#`/`.~`
    前缀）全部忽略；`onDidChange` 只响应扩展名白名单（`.xml` / `.w3x`，
    RA3 合理文本格式为 xml/w3x/lua，lua 暂未索引、manifest 为二进制）或已在
    索引中的文件；创建/删除仍响应所有真实文件（影响 include 存在性）。
25. **当前文档局部链 + 逻辑树展开（第十二轮，T1）**：新增 `xpointer.ts` /
    `logicalTree.ts` / `localScope.ts`。打开文件时按当前文本建立局部 overlay
    （自身资产 / `$DEFINE` / include 链），并生成展开 `xi:include` 的逻辑树；
    features 经 `ws.getScope(document)` 拿到 overlay-aware 索引。Poid 引用
    （`AttachModuleId` / `ModuleId` / `AutoResolveBody` 等）在最近 GameObject
    子树内解析；未命中不新增诊断（保守策略，避免跨文件误报）。
    顶层 `<Include type="all">` 暂不并入逻辑树（保留为后续扩展）。
26. **属性补全的插入布局与类型化默认值（第十四轮，2026-08-04）**：
    `attributeInsertLayout` 按临近属性的排版决定插入方式——贴引号时补空格、
    一行一个属性时补换行 + 缩进、已在新行时用临近缩进替换当前行空白、
    inline 风格的手动换行保留用户缩进；`attributeValuePlaceholder` 对引用/
    枚举/list/布尔等建议类属性保留 `$1` + 自动触发，对标量属性填 XSD 默认值
    或类型示例（`0d` / `0s` / `100%` / `0.0` / `0`），具体默认值不再弹空
    suggest。
    第十五轮（2026-08-04）最终结论：VS Code 插入含换行的补全文本时会把当前
    行基础缩进与文本内嵌缩进相加（3+3=6、6+3=9…），因此换行前缀只插入 `\n`、
    缩进交给编辑器；同时半截属性名（`hasValue=false`）不再作为缩进锚点，改用
    第一个独占一行的完整属性作为规范缩进，插入换行时顺带吞掉触发补全留下的
    尾随空格；属性名补全改用 `SnippetString`（`$1` 成为真正占位符），并新增
    输出通道调试日志。
27. **simple-content 元素文本引用（第十六轮，2026-08-04）**：simple type
    子元素（如 `ObjectCreationList` 内嵌套 `<CreateObject>`，类型
    `GameObjectWeakRef`）的**标签间文本**就是资产引用。内容区补全现在区分
    “复杂元素 → 子元素名”与“简单元素 → 值补全”；用户已输入 `<` 时替换范围从
    `<` 开始，杜绝 `<<`；simple type 元素片段固定为 `<Name>$1</Name>`（可填
    值）并自动触发值补全。hover / Ctrl 跳转 / 诊断 / Find All References
    均增加内容 token 分支。只有**带 `xas:refType`** 的 simple 内容按全局引用
    处理（291 处子元素声明）；无类型 `AssetReference`
    （`FXShaderConstantTexture@Value`、`RenderSubObjectReference@Mesh` 等
    真实数据是贴图/子对象名）与 `Poid` 不参与全局解析，避免误报。
    补充：真实文件中 `<` 后还有 `</…>` 时，`findTagEnd` 曾把闭合标签的 `>` 误
    当成残缺开始标签的结束，生成空名/半截名伪元素，补全走 element-name 分支
    导致 `<<`。修复为引号外遇到 `<` 即视为未闭合（行尾恢复），且
    `elementNameItems` 的替换范围包含 `<`。实机再回归：范围含 `<` 会让 VS Code
    用 `<` 做过滤前缀导致菜单为空——改为保留已输入的 `<`、range 从 `<` 之后
    开始、插入文本不带开括号；`textContentTokenAt` 对未闭合元素用 `el.end`
    作内容边界。
28. **语义引用索引 + CodeLens 计数 + 未引用资产（第十八轮，2026-08-05）**：
    - 动机与结论：292 个有模型类型的顶层资产中 191 个在 XSD 中没有任何
      类型化引用指向（设置/地图元数据/w3x 子结构等自动注册类型），
      AttachTest 实测 29% 项目定义 0 引用、48% 恰好 1 引用。因此 CodeLens
      计数只显示在 `isReferenceTargetType()` 为真的类型上（类型化引用目标 +
      `inheritFrom` 可继承类型），0 也显示；未引用报告默认也只列这些类型。
    - 数据：`IndexRecords` 增加 `references[]`
      （`kind / refType / selfType / value / line / start / end`），解析期固化
      引用上下文，反向索引构建零 DOM、零上下文重解析；`ModIndex.references`
      为“定义 key → 引用位置”的反向表，快照发布时构建；磁盘缓存版本
      v1 → v2（`index-records-v2.json.gz`），v3 起附加内容/records 哈希。
    - FAR 从全文搜索改为语义索引：不再把 `id="X"` 定义行、`EditorName="X"`
      等非引用属性计为引用；CodeLens 显示的计数与点击打开的 references peek
      严格一致；`includeDeclaration` 时才附加定义位置。
    - 未引用资产：命令面板 `Find unreferenced assets…` + 编辑器右键菜单
      `Find unreferenced assets of this type`；只统计 `origin === "project"`
      且非 `viaInstance` 的定义；覆盖原版 id 时来自原版/其他流的引用计入。
    - 边界：局部 scope（不在全局流里的文件）的引用不入全局反向索引；
      `AssetIdList` 等列表引用按整值记录；w3x 不提取引用记录（对 w3x 资产的
      引用从引用它的 XML 捕获）；manifest 编译期引用图（AssetReference 缓冲）
      留作后续。设计文档：`docs/features-reference-counts.md`。

## 三、实施步骤

1. [x] 调研（Include 规则、XSD、示例项目、规模、工具链）——见本文档第一部分。
2. [x] 脚手架：`package.json`、`tsconfig.json`、esbuild、`.vscodeignore`、README。
3. [x] 生成模型：`schema-model.json`（XSD，295 顶层元素 / 1851 类型）与 `asset-types.json`（79 个 AssetType 哈希）。
4. [x] 纯 TS 核心：include 解析、manifest 解析、XML 解析封装、索引器、引用解析。
5. [x] 功能层：补全、hover、导航、诊断、大纲、高亮 grammar。
6. [x] 单测（fixture Mod，73 个用例全绿：含 xs:list 枚举、未闭合引号恢复、list 多值
   分段、带 vscode stub 的补全集成、语义 token 兜底）+ 编译 + `vsce package` 打包
   （ra3-mod-xml-0.1.1.vsix，约 499KB）。
7. [x] 在 AttachTest / GenEvoTest / Corona 上做冒烟验证，并按真实项目反馈修复问题（详见 `docs/analysis-issues.md` 八轮分析）。
8. [x] w3x 美术资产索引（第八轮）：新增 `shallowScan.ts` / `caches.ts`，w3x 与内容嗅探
   XML 走浅扫描，Include source 补全候选加入 w3x，BOM 剥离，缓存跨重建持久化；
   AttachTest 报错场景（`AUGunship_SKN`）修复，Corona 首次/二次构建实测验证。
9. [x] Corona 性能与内存优化（第九轮，v0.1.1）：`records.ts` 记录驱动索引、
   `IncludeResolveCache` 零 stat 重建、DOM 元素预算淘汰、w3x LineMap 移除、
   候选并行扫描、阶段计时；Corona 信任重建 2.0s；确认首建 2.5GB 为可回收垃圾。
10. [x] 部分可用性 + 分阶段索引（第十轮，2026-08-03）：T0 解耦（语法/模型
    诊断、枚举/子元素补全、Include 链接无索引可用）、A/B 分阶段发布、watcher
    触发重建 + 失效纪元 stale 标记、stat 多信号扩展；测试 73 → 79。
11. [x] 冷启动提速（第十一轮，2026-08-03）：文件集快照替代 statSync、
    磁盘持久化缓存（多信号校验、原子写）、clearCache/showCacheReport 命令；
    测试 79 → 90；Corona 冷启动 ~11s。
12. [x] 惰性存在性快照 + 重建插桩（第十一轮补充，2026-08-03）：全量目录枚举
    改为惰性按目录 readdir（phase A 45s → 24.0s）；新增 buildCount /
    lastBuildTrigger 与输出通道日志；索引/缓存报告显示构建序号与触发原因。
13. [x] watcher 噪声过滤 + URI 日志（第十一轮补充，2026-08-03）：输出通道
    记录 `[watcher-*] <path>`；`.git` 段路径忽略；测试 90 → 91。
14. [x] watcher 内容白名单（第十一轮补充，2026-08-03）：临时文件命名模式
    过滤 + 内容变更扩展名白名单 + `isIndexedFile` 兜底；测试 91 → 92。
15. [x] T1 当前文档局部链 + include 展开（第十二轮，2026-08-03）：局部
    overlay（不在任何流里的文件也能解析自身引用）+ `xi:include` 逻辑树展开
    + Poid 局部作用域补全/悬停/跳转；测试 92 → 98。2026-08-04 补充构建期
    闸门：`getScope` 在重建进行中只返回 parse-only scope，避免与 indexer
    抢盘（版本 0.1.9）。
16. [x] bit-flag 列表补全修复（第十三轮，2026-08-04）：空格触发字符、多行
    未闭合标签的部分标签重解析（`recoveredStartTag` 标记 + 恢复元素父链）、
    闭合值内追加模式与中间插入范围修复；测试 98 → 107（版本 0.1.10）。
17. [x] 属性补全插入体验（第十四轮，2026-08-04）：闭合引号后自动补空格、
    临近属性缩进对齐、标量属性类型化默认值；测试 107 → 111（版本 0.1.11）。
18. [x] 属性补全缩进叠加修复（第十五轮，2026-08-04）：换行前缀只插入 `\n`
    （编辑器自动补基础缩进，避免 3+3=6 式叠加）、完整属性锚点 + 首个独占一行
    属性为规范缩进、`$1` 改为 SnippetString 占位符、输出通道调试日志、尾随
    空格吞除；测试 111 → 113（版本 0.1.12–0.1.13）。
19. [x] simple-content 文本引用修复（第十六轮，2026-08-04）：`<` 后补全范围
    覆盖 `<`、simple type 元素片段 `<Name>$1</Name>`、简单元素内容值补全、
    `refs.ts` 新增 `isReferenceContentType` / `resolveContentReferenceTargets`、
    hover / 定义跳转 / 诊断 / Find All References 内容分支；
    测试 113 → 121（版本 0.1.14）。实机回归补充：`findTagEnd` 引号外遇 `<`
    视为未闭合 + 插入文本不带开括号（range 从 `<` 之后开始）；测试 121 → 125，
    再回归 125 → 128（未闭合元素内容 token）。
20. [x] simple-content 零宽边界与大列表补全（第十七轮，2026-08-04）：
    `>` 后光标归入内容区、已闭合元素 `end` 改为开区间；超过 400 条的
    id/define/local/include 候选返回 `isIncomplete` 让 VS Code 随输入重请求；
    当前文档 local 资产优先、候选 top-N 用堆避免全量排序、Include source
    先排序再截断；测试 128 → 136。
21. [x] 语义引用索引 + CodeLens + 未引用资产（第十八轮，2026-08-05）：
    records 引用记录提取、`referenceIndex.ts` 反向索引、语义 FAR（替换全文
    搜索）、CodeLens 引用计数（类型过滤、0 也显示、点击开 references peek）、
    `findUnreferencedAssets` 命令 + 右键菜单、磁盘缓存 v2；
    测试 136 → 146；设计文档 `docs/features-reference-counts.md`。
22. [x] FAR 定义行排除 + manifest 源引用归并（2026-08-05 修复轮）：
    FAR 不再因 `includeDeclaration` 附加定义行（消除“自引用”观感）；
    `referenceSitesForDefinition` 把 manifestSource 可解析到当前文件的
    manifest 定义站点并入 CodeLens 计数（AttachTest 326 个 manifest 定义
    受益）；测试 146 → 147；版本 0.1.17；分析见
    `docs/analysis-issues.md` 二十三。
23. [x] 引用索引与缓存同步加固（2026-08-06）：反向索引改为从**构建期本地
    records**（`buildRecords`）构建，不再读共享 recordsCache——中途失效、
    feature `readDom` 重读都不再造成“资产在但引用缺失”；构建中 `readDom`
    不再被定义跳转调用（避免污染进行中的构建）；force 重建（Re-index）
    对 stat 匹配的 full XML 做内容哈希校验；打开文档时比较 records 哈希，
    不一致则定向 invalidate + `records-desync` 重建自愈；磁盘缓存 v2 → v3；
    测试 147 → 151；分析见 `docs/analysis-issues.md` 二十四。
24. [x] 多项目支持（2026-08-07）：新增纯模块 `src/projectRoot.ts`（向上 12 层 /
    容器向下 3 层 / 单文件向上，`Data/Mod.xml`、`mapmetadata_*.xml`、`*.babproj`
    标记，大小写不敏感、最近优先、跳过 Data/Art/builtmods/.git 等目录）；
    `ModWorkspace` 改为多项目状态——按文档就近选项目、单项目立即索引 /
    多项目惰性索引（活动文档所属项目先建）、全局串行构建队列保护共享缓存、
    磁盘缓存按项目分文件、watcher 事件按路径归属调度、workspace 文件夹变化
    重检、激活事件补 mapmetadata 与打开 Data 文件夹场景；测试 151 → 168。
25. [x] 属性补全换行判定与值补全去重（2026-08-07）：`attributeInsertLayout`
     只按光标之前的完整属性判断“是否已在新行”，one-per-line 标签中间插入或
     首属性新行补全不再多插换行，同一行第二个属性仍按原规则换行；
     `assetIdItems` 按 id 去重（局部 overlay / 全局索引 / manifest 同一 ID
     只给一项，其余定义列入文档说明），`defineItems` 同步按名去重；
     测试 168 → 173；版本 0.1.20；分析见 `docs/analysis-issues.md` 二十五。
26. [x] 磁盘缓存可观测性、分阶段校验与进度显示（2026-08-08）：
     `DiskRecordsCache` 拆为 `load()`（读 + gunzip + JSON）与 `validate()`（逐文件
     stat，带进度回调）；冷启动**先校验 XML/full 记录再构建**，美术/shallow
     记录先以 `validated:false` 预播种（phase A 只登记不消费，避免 stat 2.6GB
     模型），在 phase A 发布后的回调里校验并进入 phase B——phase A 可用时间
     从 ~34s 提前到 ~16s，且不牺牲“未校验缓存不可信”的正确性（曾尝试构建后
     后台校验，既有 I/O 争用又无法事后发现 stat 不可见变化，已放弃）；
     校验进度写入状态栏（`validating cache N/M…`）并每 1000 条输出一行日志；
     `DiskCacheLoadStats` 增加 `loadMs` / `validateMs`，输出通道新增
     `[disk-cache] loaded / validated / saved` 计时与 `[build] wall time`
     （含缓存加载的总耗时），cacheReport 与状态栏 tooltip 展示校验耗时；
     输出通道所有日志行自动加本地 `HH:mm:ss.mmm` 时间戳（`ModWorkspace.log`）；
     修复构建完成后状态栏仍显示 indexing（`building` 置 false 后补一次
     `updateStatusBar()`）；测试 173 → 175；分析见
     `docs/analysis-issues.md` 二十六。
27. [x] CodeLens 与 FAR 使用同一套定义合并路径（2026-08-10）：CodeLens
     改为通过 `getScope(document)` 取 merged index，并用
     `definitionsForReference`（文档 local overlay + 全局同名定义）+ 
     `collectReferenceSites` 计算计数，与 Find All References 严格一致；
     点击 lens 打开的 references peek（`showReferencesForDef`）同步改为
     同一逻辑，修复“FAR 有引用但 WeaponTemplate 等 CodeLens 不显示/为 0”
     的 standalone / 未进全局流文件场景；`scheduleRebuildIfRecordsDesync`
     在 CodeLens 中也改用 `recordsSyncSurfaceFor(document)`（按文档所属
     项目自愈）。补充：CodeLens 改用轻量 `getCodeLensScope`（只解析当前
     文档 + 挂全局索引，不展开 include 链），快照发布后计数即时刷新；
     仅在尚无全局快照（`stats.indexedFiles === 0`）时不渲染 CodeLens，
     快照存在后“0 references”仍按设计显示；新增 `onDidChangeCodeLenses`
     事件在每次快照发布时主动通知 VS Code 重新查询（不再只依赖 refresh
     命令）；输出通道增加 `[codelens] refresh`（快照发布时低频记录）、
     `[codelens] suppressed`（首个快照前每个文档只记一次）、scope 异常与
     超过 250ms 的慢调用记录；另加**全局重试定时器**：构建期间每 2s 重新
     fire 一次 CodeLens 刷新（`onBuildStart` 启动、`!isBuilding` 停止），
     避免 VS Code 合并/漏掉单次 refresh 事件导致 phase A 计数迟迟不出现；
     定时器只在构建期存在，构建结束即清除；测试 175 → 178；分析见
     `docs/analysis-issues.md` 二十七。
28. [x] manifest 源地址按 vanilla-only 解析（2026-08-10）：新增
     `buildVanillaSearchPaths(sdkDir)`，`manifestSource` 只按
     `[SDK根, SDK\SageXml]`（ART/AUDIO 同理）解析，不再使用当前项目 BAB
     顺序；修复 mod 同名 `DATA:globaldata/weapon.xml` 遮蔽导致 manifest
     定义跳不到 SageXml 的问题；`referenceIndex` 的 manifest 源归并同步
     修正；SageXml 源缺失时保持 manifest-only，文件存在但 id 被删时降级
     到文件顶部；测试 178 → 184；分析见 `docs/analysis-issues.md`
     二十八。

## 四、验证结果（实测）

| 项目 | 规模 | 索引耗时 | 资产数 | 说明 |
|---|---|---|---|---|
| AttachTest | 88 文件 | ~1.2s | 35,607（manifest 35,322，w3x 浅扫 62） | 2 个流（static + mapmetadata）；二次构建 354ms / 62 缓存命中 |
| GenEvoTest | 66 文件 | 首次 ~2.6s / 二次 ~0.4s | 35,502（manifest 35,322，w3x 浅扫 38） | 2 个流、73 个 Define；二次构建 0 重扫 / 38 缓存命中 |
| Corona | 8,976 文件 | 首次 ~250s / 信任二次 ~2s / 强制 ~5-25s | 64,868（manifest 35,322，w3x 浅扫 4,829） | 3 个流、183 个 Define、0 诊断；二次构建 statSync 0、resolveHits 15,333 |

单元测试覆盖：XML 解析（自闭合/容错/偏移/未闭合引号行尾恢复 + recovered
标记）、补全上下文（未闭合引号仍为 attribute-value、多行未闭合引号、list 多值
分段、闭合引号后为 attribute-name）、补全集成（vscode stub 下
    `LocomotorTemplate@Surfaces` 未闭合引号枚举补全、空格后第二段过滤与替换范围、
    空格后排除已用 flag、中间插入范围止于光标、闭合值末尾追加模式、`CAN_ATTACK`
    前缀保护、多行未闭合 `Disposition` 完整链路、闭合引号后补空格、一行一个属性
    换行缩进、新行缩进对齐、标量类型化默认值）、语义 token（标签/属性/值范围、
    合法文档返回空、malformed 返回兜底 token）、include 解析（BAB 顺序、SDK 根
    优先于 SageXml；manifest 源 vanilla-only：mod 同名遮蔽仍命中 SageXml、
    源缺失保持 manifest-only、id 被删降级文件顶部）、manifest 二进制解析
    （合成 v5 样本、类型/ID 推导）、索引器
    （资产/Define/流/缺失 include/嵌套 xi:include）、XSD 模型（上下文类型、
    `childTypeOf`、大小写规范化、属性级 refType、外来命名空间判定、`xs:list`
    枚举继承与 `isList` 标记）、引用过滤（`Weapon="X"` 只跳 `WeaponTemplate`、
    模块 `id` 定义点、Poid 局部引用、`xi:include` 不校验、`Side="Allies"` 命中
    manifest 的 `PlayerTemplate`）、simple-content 文本引用（`<` 后补全不产生
    `<<`、`<CreateObject>$1</CreateObject>` 片段、内容值按 refType 过滤、
    内容 hover / Ctrl 跳转 / 诊断）、引用索引（records 引用提取：attr/content/
    inheritFrom、排除 id/Poid/`$DEFINE`/枚举；`buildReferenceIndex` 严格类型过滤
    不串同名 ID；minimod 集成：`CommandSet` / `inheritFrom` 反向命中；未引用过滤
    只含 project 非 viaInstance；CodeLens 类型过滤与 0 显示；语义 FAR 排除定义
    行与非引用属性）。

> 注：D: 盘移动硬盘已恢复连接；Corona 已在第八 / 九轮按上述新数据回归。

## 五、假设与开放问题

- 假设 SDK 路径默认 `C:\Apps\RA3-MODSDK-X`（与 prompts 一致），可在设置中修改。
- 假设补全/导航以“文本语义分析”为主，不做完整 XSD 校验（BAB 才是权威校验器）。
- 开放：是否发布到 VS Code Marketplace（需要 publisher）——本期先保证本地 `vsce package` 可安装。
- 开放：**“宏展开”式虚拟合并**（用户提议，方向已确认）：`xi:include` 已按逻辑树
  展开（第十二轮，见第六节）；顶层 `<Include type="all">` 与 `inheritFrom` +
  `xai:joinAction` 的深合并仍未实现，后续如需要“当前文档视角的全量合并诊断”再继续。

## 六、include 展开设计备忘（2026-08-01；xi:include 部分已实施于第十二轮，无 xpointer 语义与片段诊断见第二十八轮）

> 目的：集中记录 include 处理相关的现状、结论与设计，下次遇到 include 问题时从这里继续，
> 并在实施后把结果回写本节。

### 1. 现状（截至第五轮，已实现）

| 能力 | 状态 |
|---|---|
| `<Include type="all">` / `instance` 递归索引（顶层资产、流、Define） | 已实现（indexer `walk`） |
| `reference` → builtmods manifest 解析 / 缺失回退占位 XML | 已实现 |
| 嵌套 `xi:include`（任意层级）：目标可索引、缺失报 `include-not-found`、Ctrl+点击跳转、`href` hover 解析目标 | 已实现（第二轮 + 第五轮） |
| `xi:include` 及其属性不参与 XSD 校验（外来命名空间守卫 `isXsdElementName` / `isXsdAttributeName`） | 已实现（第五轮） |
| include 目标内容“虚拟合并”进父文档的逻辑树 | 已实现 `xi:include`（第十二轮）；**无 `xpointer` 时整体包含目标根元素**（第二十八轮修正）；顶层 `<Include type="all">` 仍不展开 |
| 片段文件（根非 `AssetDeclaration`）的诊断 | 已实现 P0（第二十八轮）：跳过顶层 id/重复/引用/define 检查；根为已知 XSD 元素时仍校验子树；根未知时只报语法与 include 缺失 |

### 2. 已确认的方向

先展开成不含 include 的文档树（类比 C++ 宏展开），再对展开后的树做 mod XML 解析。
BAB（`defaultscript.cs`）编译时正是这样把整个 Mod 合并成一份大 XML 的。

### 3. 关键设计决策：逻辑树拼接，不做文本拼接

- **不要**把 include 目标展开成文本再整体重新解析：源码偏移会断裂，诊断 / 跳转 / hover /
  补全全部无法映射回原始文件。
- **要做**的是：解析器逐文件解析（现状不变）；展开器把目标文件选中节点挂进父元素——
  有 `xpointer` 时取 `/n:Name/child::*` 选中 children，无 `xpointer` 时按 XInclude 语义
  整体包含目标根元素（RA3 片段如 `CreateObjectDie` 依赖这一行为）；节点保留各自的源文件
  与原始偏移（来源追溯）。后续分析跑在逻辑树上，范围映射按节点 `sourceFile` 回到对应
  文件的 lineMap。
- 现有 `parseXml` 已记录标签 / 属性 / 值的起止偏移，`XmlElement` 结构可直接复用；拼接时
  用浅拷贝节点壳并重建 parent 链，避免破坏目标文件缓存树自身的 parent 指针。

### 4. 展开范围

| 构造 | 拼入逻辑树 | 理由 |
|---|---|---|
| `xi:include` | ✅ | 有 `xpointer`：选中容器 children；无 `xpointer`：整体包含目标根元素（CreateObjectDie / TechUpgradeReceiver 等片段场景） |
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
