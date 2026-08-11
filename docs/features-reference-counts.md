# 功能设计：引用计数、语义 Find All References 与未引用资产

> 状态：已实现（v0.1.16 起）。本文档记录需求分析结论、语义定义、数据流与
> 已知边界；问题排查记录仍放在 `docs/analysis-issues.md`，功能设计单独成文。

## 一、需求与结论

原始需求：

1. 在每个顶部 asset 上显示它被引用了多少次，点击后直接打开“查找所有引用”，
   而不是必须通过右键菜单；
2. 能查找“某一种类型中所有没被引用的顶部 asset”。

调研结论（2026-08-05）：

- XSD 模型层面，292 个有模型类型的顶层资产中：73 个有类型化引用指向它们，
  28 个只能被 `inheritFrom` 指向，**191 个在模型里根本没有任何引用指向**
  （设置类、地图元数据、w3x 子结构等）。对这些类型，“0 引用”是唯一正常状态。
- AttachTest 实测：625 个项目定义中 29% 是 0 引用、48% 是 1 引用。
  因此“所有资产一律显示计数”会制造大量噪音，也会让用户误以为资产是孤儿。
- 结论：**计数按类型过滤**——只在“设计上应该被引用”的类型上显示
  （0 也显示，因为对 GameObject 这类类型 0 是有效信号）；自动注册/结构类
  类型不显示。
- 旧版 Find All References 是全文搜索（正则匹配 `"id"` / `>id<`），会把
  `id="X"` 定义本身、`EditorName="X"` 等非引用属性也算进去。计数如果和它
  同源，必然误导；如果不同源，点击后的结果又对不上。因此本轮把 FAR 一起
  升级为语义引用索引，计数与点击结果共用同一数据源。

## 二、语义定义：什么算一次“引用”

与补全 / hover / 跳转 / 诊断完全一致（`refs.ts` 是唯一判定来源）：

- 带 `xas:refType` 的属性值（如 `CommandSet` → `LogicCommandSet`）；
- 带 `xas:refType` 的 simple-content 文本（如 `<CreateObject>ID</CreateObject>`）；
- `inheritFrom`（按元素自身类型过滤）；
- 无 `refType` 的 `isRef` 属性（按同名 ID 匹配任意声明类型）。

不算引用：

- 元素自己的 `id` 定义点（除非是 `RoadObject@id→Road` 这类跨类型 id 引用）；
- Poid 管线局部引用（`ModuleId`、`AttachModuleId`、`SoundRef` 等）；
- `$DEFINE` / `=` 常量值；
- 枚举、文件路径、`Include@source` / `xi:include href`；
- w3x 内部父子结构关系（`W3DMesh` 等靠结构归属，不走全局引用）。

引用索引按“类型 + id + 定义位置”精确归属，同名 ID 的不同类型定义互不串扰
（`WeaponTemplate:X` 的引用不会计到 `GameObject:X` 头上）。

## 三、数据流

```
parse DOM
   │  records.ts  extractIndexRecords(parse, lineMap, text)
   ▼
IndexRecords.references[]       每文件紧凑记录（refType / selfType / value /
   │                            行号 / 起止偏移），随 records 缓存跨重建复用，
   │                            并持久化到磁盘缓存（缓存版本 v3，full XML
   │                            附带内容哈希；快照另发布每文件 records 哈希）
   ▼
indexer.ts  buildReferences()   只解算本次 build 触及的文件，防止陈旧缓存泄漏
   │  referenceIndex.ts  buildReferenceIndex()
   ▼
ModIndex.references             Map<定义 key, ReferenceSite[]>
   ├── CodeLens 计数（O(1) 查表）
   ├── 语义 Find All References（返回精确位置）
   └── 未引用资产报告（0 引用 = 不在反向索引中）
```

引用记录在解析期就把 `refType` / `selfType` 固化下来，反向索引构建时不需要
再解析 DOM、也不需要上下文类型解析；只需对 `assetsById` 做一次查找并按类型
过滤。快照发布时（XML 阶段 + art 阶段）各构建一次反向索引，Corona 规模下
开销远小于 include 遍历。

反向索引只从**本次构建的 walk 实际消费的 records**（`ModIndexer.buildRecords`）
构建，不读共享 recordsCache：中途 watcher 失效、或 feature 通过 `readDom`
重读文件，都不会让“资产在但引用缺失”的快照出现。打开文档时 CodeLens / FAR
还会比较当前文本的 records 哈希与快照，不一致就定向 invalidate 并触发
`records-desync` 重建自愈（仅对已保存文档，未保存编辑不触发）。

## 四、CodeLens 规则

- 只对根级（`AssetDeclaration` 直接子元素）带 `id` 的资产显示；
- 只对 `isReferenceTargetType()` 为真的类型显示（类型化引用目标 +
  `inheritFrom` 可继承类型；见 `refs.ts` 的 `referenceTargetTypes()`）；
- 0 也显示：`0 references` / `1 reference` / `N references`；
- 点击执行 `ra3modxml.showReferences` → `editor.action.showReferences`
  打开 references peek，结果与计数完全一致（不含定义本身）；
- 计数除了当前定义自己的反向索引桶，还并入“manifestSource 可解析到当前
  文件”的 manifest 定义桶：`manifestSource` 按 vanilla-only 搜索路径
  （SDK 根 + `SageXml`）解析，mod 同名 DATA 路径不会被视为源码；manifest
  资产有对应 SageXml 源码时，引用直接视作 SageXml 源码对该 asset 的引用
  （Go to Definition 同样把 manifest 定义映射到 SageXml 源码）；
- 索引重建完成后自动 `editor.action.codeLens.refresh`，计数不会停留在旧值。

## 五、未引用资产

- 主入口：命令面板 `RA3 Mod XML: Find unreferenced assets…`
  第一步 QuickPick 选类型（只列“设计上应被引用”的类型，显示每种未引用数量），
  第二步列出资产（`id — 相对路径:行号`），点击跳转到定义；
- 加速入口：编辑器右键菜单
  `RA3 Mod XML: Find unreferenced assets of this type`
  （仅 `editorLangId == xml && ra3modxml.active` 时显示），光标在顶部资产上
  时直接预选该类型，否则回退到类型选择；
- 语义：只统计 `origin === "project"` 且非 `viaInstance` 的定义；
  manifest / SDK 定义永远不参与；如果某个 id 覆盖了原版资产，来自原版/其他
  流的引用同样计入（否则会把覆盖件误报成未使用）。

## 六、已知边界与后续

- 当前文档局部作用域（不在任何全局流里的文件）的引用不在全局反向索引中：
  这类文件打开后 CodeLens / FAR 只反映全局流；局部链内的引用暂不计数。
- Find All References 不返回定义行本身（即使 VS Code 传入
  `includeDeclaration`），因此结果数量与 CodeLens 计数严格一致。
- `AssetIdList` 等“任意资产 ID 列表”的引用语义仍未建模：整个属性值按一条
  引用记录处理，与现有补全/诊断保持一致（已知缺口，后续可在 records 层扩展）。
- w3x 文件本身不提取引用记录（浅扫描无 DOM）；对 w3x 资产的引用从引用它的
  XML 文件捕获。
- manifest 二进制里包含 BAB 编译后的完整引用图（`AssetReferenceOffset/Count` +
  8 字节 `TypeId+InstanceId` 条目），目前仍跳过。将来可解析它给原版/manifest
  资产提供“编译器权威”计数；mod 源码资产在编译前没有 manifest，仍需源码级
  引用索引。
- 未引用资产目前是命令 + QuickPick 的“查询”形态；如果之后想要常驻浏览，
  可以再加 Tree View（更重，暂不计划）。
