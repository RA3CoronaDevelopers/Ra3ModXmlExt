# 问题分析：AttachTest 高亮异常与误报诊断

> 日期：2026-08-01。基于在 AttachTest `Data/Mod.xml` 上复现的问题。
> 本文件只做分析，**代码尚未修改**，修复方案见文末，待审阅后实施。

## 一、现象

1. **语法高亮异常**：
   - `<?xml version="1.0" encoding="UTF-8"?>` 显示为纯文本颜色；
   - `<Includes` 之后的 `>` 无高亮；
   - `<Include type="reference" ...>` 中 `Include` 之后的内容全部无高亮；
   - 整体表现为"只有少量标签名被着色，其余按纯文本处理"。
2. **误报诊断**：
   - `<Include type="reference">` 的 `type` 值报 `Unresolved reference "reference"`；
   - `<Include source="DATA:Static.xml">` 的 `source` 值报 `Unresolved reference`；
   - 同一处 hover 显示解析结果为 `C:\Apps\RA3-MODSDK-X\SageXml\Static.xml`，但实际应按编译参数解析到 SDK 根目录 `C:\Apps\RA3-MODSDK-X\Static.xml`。

## 二、实测证据

用当前构建代码对 AttachTest 索引后验证：

```
[resolve] DATA:Static.xml -> C:\Apps\RA3-MODSDK-X\Static.xml     ← 解析器结果正确
[candidate] 精确匹配      -> C:\Apps\RA3-MODSDK-X\SageXml\Static.xml  ← hover 用的是这条
[model] Include@type  refType: null  enum: [reference, instance, all]
[model] Include@source refType: null  type: anyURI
[diag]  Include@type='reference' targets: 0
```

三个问题均稳定复现。

## 三、根因分析

### 1. 高亮异常：grammar 注册方式覆盖了内置 XML 语法

`package.json` 中的 grammar 贡献写法：

```json
{
  "language": "xml",
  "scopeName": "source.ra3modxml",
  "injectTo": ["source.xml"]
}
```

同时填写 `language` 与 `injectTo` 时，VS Code 会把该 grammar 注册为 **`xml` 语言的主 grammar**（替换内置 XML 语法），而不仅是注入。结果是：

- 内置 `source.xml` 的完整 token 化规则不再生效；
- 我的语法只有几个领域关键词模式，没有 XML 声明、标签括号、属性名/值的规则；
- 于是 `<?xml ...?>`、`>`、属性区全部退化为纯文本，只有 `$DEFINE`、`inheritFrom`、结构标签名等被我的模式着色——与现象完全吻合。

正确的做法是注入式 grammar 不声明 `language`（VS Code 官方注入语法示例即省略该字段）。

### 2. 误报 `Unresolved reference`：诊断把所有属性值都当成"引用"检查

诊断代码在 `checkValueReferences` 中先调用 `resolveReferenceTargets(...)`，并以其返回空数组作为"未解析"依据。而 `resolveReferenceTargets` 对**非引用属性**（如 `Include@type` 枚举、`Include@source` 的 `anyURI`）也返回空数组——两者无法区分。

这是早期实现回归：最初代码有 `isRef`（检查 `refType` 或 `inheritFrom`）守卫，重构为共享函数后丢失了该守卫。

同理，hover 对非引用属性值也会走到"未找到匹配定义"分支，显示误导性文案。

### 3. `DATA:Static.xml` hover 路径错误：候选表优先于解析器，且候选表大小写不统一

- 解析器 `resolveSource` 按搜索路径正确解析到 SDK 根 `Static.xml`；
- 但 hover/定义跳转/文档链接都是**先查 `idx.sourceCandidates` 精确匹配**；
- 候选表里同一 source 字符串 `DATA:Static.xml` 出现两条：一条来自 `SageXml\Static.xml`（扫描更早、排在前面），一条来自 SDK 根目录浅扫描；
- `find` 精确匹配返回第一条 → 显示 SageXml 路径，而按 BAB 顺序应先命中 SDK 根目录。

修复方向相应调整为：**候选表只服务补全**；hover/跳转/链接一律先走 `resolveSource`（按 BAB 顺序校验文件存在）。候选表本身也按 source 去重并让 SDK 根目录条目排前。

另外，当前搜索路径来自 `check_duplicate_ids.py` 的简版（`[SDK根, 项目Data, Mods, SDK/SageXml]`），与 BAB 编译参数不完全一致，缺少 `modGranParent` 与 `SDK\Mods` 两个条目。`defaultscript.cs` 的 `getIncludePaths()` 实际参数为：

```
/data:  ".;{modGranParent};{0}\Data;.\Mods;{1};.\SageXml"
/art:   ".;{modGranParent};{0}\Art1;{0}\Art;.\Mods;{1};.\Art"
/audio: ".;{modGranParent};{0}\Audio1;{0}\Audio;.\Mods;{1};.\Audio"
其中 {0}=ModPath, {1}=modParentPath, {2}=modGranParent, "." = SDK 根目录（编译时 cd 到 SDK）
```

展开后（以 AttachTest 为例）：

| 前缀 | 搜索路径（BAB 顺序） |
|---|---|
| DATA | SDK根 → modGranParent → Mod\Data → SDK\Mods → modParentPath → SDK\SageXml |
| ART | SDK根 → modGranParent → Mod\Art1 → Mod\Art → SDK\Mods → modParentPath → SDK\Art |
| AUDIO | SDK根 → modGranParent → Mod\Audio1 → Mod\Audio → SDK\Mods → modParentPath → SDK\Audio |

`DATA:Static.xml` 在 BAB 顺序下首先命中 SDK 根的占位文件（与用户预期一致）。

## 四、修复方案

### 4.1 语法高亮（P0）

- `package.json` 的 `grammars` 条目**移除 `"language": "xml"`**，只保留 `scopeName`、`path`、`injectTo`，使其成为纯粹的注入语法，叠加在内置 XML 语法之上。
- 精简 `syntaxes/ra3modxml.tmLanguage.json`：保留不冲突的模式（`$DEFINE` 常量、`inheritFrom`、`xai:joinAction`、TODO 注释、结构标签名）；删除对 `Replace`/`Remove` 的裸词匹配（避免误染普通内容）。
- 验证方式：扩展开发宿主中打开 `Data/Mod.xml`，确认 XML 声明、标签、属性恢复完整高亮且领域关键词仍有专属颜色。

### 4.2 诊断与 hover 的引用判断（P0）

- 恢复"是否引用属性"守卫：仅当属性为 `inheritFrom` 或模型中有 `refType` 时才进入未解析引用检查；`Include@type`、`Include@source` 等不再误报。
- hover 同步加守卫：非引用属性值不再显示"未找到匹配定义"文案；`Include@source` 走专门的"Include 源文件"分支。

### 4.3 Include 源解析（P0）

- hover / 定义跳转 / 文档链接统一改为**优先调用 `resolveSource`**（按 BAB 顺序、校验文件存在），候选表只作为兜底与补全来源。
- `buildSearchPaths` 对齐 BAB 编译参数：DATA/ART/AUDIO 各补上 `modGranParent` 与 `SDK\Mods` 两个搜索条目，顺序与 `defaultscript.cs` 一致。
- 候选表去重改为大小写不敏感（按 `source.toLowerCase()` 去重），避免同一文件因大小写不同出现两条候选。

### 4.4 测试补充

- 新增/更新单测：
  - 非引用属性（`Include@type`、`Include@source`）不会产生 unresolved-reference 目标；
  - `DATA:Static.xml` 按 BAB 顺序解析到 SDK 根目录而非 SageXml；
  - `buildSearchPaths` 展开结果与 BAB 参数一致（构造 SDK 内/外两种项目布局断言顺序）。
- 回归验证：AttachTest / GenEvoTest / Corona 各索引一次，确认 0 误报、补全/跳转正常。

### 4.5 不在本次范围

- P1 搜索与索引复用设计；
- manifest 深度解析（资产类型不匹配提示的进一步细化）。

## 五、风险与影响

- grammar 改动只影响高亮层，不影响索引与诊断逻辑；
- 搜索路径顺序变化可能影响个别 include 的解析结果（更接近 BAB 真实行为），需在三个真实项目上回归；
- 候选表去重策略变化理论上减少补全条目重复，不影响条目正确性。

## 六、实施结果（2026-08-01）

已按上述方案完成修复并验证：

1. **grammar 改为纯注入**：`package.json` 的 `grammars` 条目移除 `"language": "xml"`，内置 XML 语法恢复为主语法，领域关键词以注入方式叠加。
2. **引用属性守卫恢复**：新增 `isReferenceAttribute()` 纯函数，诊断与 hover 仅对 `inheritFrom` / 带 `refType` 的属性做未解析引用检查；`Include@type`、`Include@source` 不再误报。
3. **Include 源解析优先 `resolveSource`**：hover / 定义跳转 / 文档链接统一先按 BAB 顺序解析；候选表仅作补全来源并按 source 去重、SDK 根目录条目排前。
4. **搜索路径对齐 BAB 参数**：`buildSearchPaths` 的 DATA/ART/AUDIO 各补入 `modGranParent` 与 `SDK\Mods`，顺序与 `defaultscript.cs` 的 `/data /art /audio` 一致。

实测（AttachTest，C: 盘）：

```
DATA:Static.xml resolves to: C:\Apps\RA3-MODSDK-X\Static.xml   (OK，不再指向 SageXml)
DATA:static.xml candidates: 1 -> C:\Apps\RA3-MODSDK-X\Static.xml (去重生效)
isReferenceAttribute(Include,type)   = false
isReferenceAttribute(Include,source) = false
CommandSet 引用仍能解析到 LogicCommandSet 定义（无回归）
```

单元测试 24/24 通过（新增：BAB 搜索路径顺序、SDK 根优先于 SageXml、`isReferenceAttribute` 判定）。

> 注：本环境当前无法访问 `D:\Mods\CoronaMod`（D: 盘不可见），GenEvoTest / Corona 的实机回归待 D: 盘可用后补跑；相关逻辑已被 AttachTest 与单元测试覆盖。

---

## 七、问题分析（第二轮，2026-08-01）

用户在 AttachTest `Guardian Tank\GameObject.xml` 上报了三个新问题，均已修复并验证。

### 问题 A：`Side="Allies"` 误报"未被定义"

**现象**：`Side="Allies"` 报 unresolved reference，但 `global.manifest` 中存在 `PlayerTemplate:Allies`。

**根因**：`Side` 属性确实是引用（`PlayerTemplateWeakRef` → `PlayerTemplate`），但 manifest 解析器依赖 OpenSAGE `AssetType.cs` 的 TypeId 哈希表，而该表**不完整**（实测 `Global.manifest` 11268 个资产中有 2707 个哈希未知，`PlayerTemplate` 即缺失）。未知类型被记成 `#哈希`，无法与 `refType=PlayerTemplate` 匹配。

**修复**：manifest 资产名本身是 `类型名:ID` 格式（如 `PlayerTemplate:Allies`），新增 `deriveAssetType()`——哈希已知时用哈希；未知时从名称前缀推导类型（资产 ID 不允许含冒号，切分无歧义）。修复后 `Side="Allies"` 正确解析到 `PlayerTemplate@Global.manifest`。

### 问题 B：`<Weapon>` 报没有 `Ordering` 属性

**现象**：`WeaponSetUpdate → WeaponSlotTurret → Weapon` 链中 `<Weapon Ordering=...>` 报未知属性；XSD 里 `WeaponSlot_WeaponData` 确实有 `Ordering`。

**根因**：模型用"元素名→类型"的**全局单映射**，同名元素（如 `<Weapon>` 出现在武器槽、慢速死亡、引用等许多上下文）以"先到先得"注册。`Weapon` 被注册成 `WeaponRef`，因此按全局映射查不到 `Ordering`。这是典型的**上下文相关类型**问题。

**修复**：新增上下文感知类型解析：
- `childTypeOf(父类型, 子元素名)` / `elementTypeIn(父元素, 子元素名)` / `attributesOfType(类型)`；
- `resolveElementType(元素)` 沿解析树向上逐层用父类型的子元素声明解析真实类型，失败时回退全局映射。

修复后 `Weapon`（在 `WeaponSlotTurret` 下）解析为 `WeaponSlot_WeaponData`，`Ordering` 合法；且 `Ordering` 本身不是引用，不再被误判。

### 问题 C：嵌套 `xi:include`（第 248 行）未处理

**现象**：`<xi:include href="DATA:Includes/HeadlightDraw2.xml" xpointer="...">` 位于元素内部（非 `AssetDeclaration` 直接子级），原实现只处理根级 `xi:include`，嵌套的一律静默忽略。

**根因**：索引器 `walk()` 只遍历根的直接子元素处理 `xi:include`。

**修复**：解析后遍历文档全部元素，对**任意层级**的 `xi:include`：解析 `href`（按 BAB 搜索路径）；目标缺失时产生 `include-not-found` 诊断（不再静默）；目标存在时记录并 walk 目标文件，使其内容/资产进入索引。`href` 的文档链接（Ctrl+点击）此前已可用。

### 举一反三的测试

- `test/typeContext.test.mjs`：用真实结构（GameObject → BehaviorModules → WeaponSetUpdate → WeaponSlotTurret → Weapon）验证上下文类型解析；`childTypeOf` 原语断言。
- `test/manifestTypes.test.mjs`：`deriveAssetType` 前缀推导（含无冒号/前导冒号边界）；模拟 `PlayerTemplate:Allies` 后 `Side` 引用解析成功；`isReferenceAttributeOfType` 判定。
- `test/indexer.test.mjs`：新增嵌套 `xi:include` 断言——目标文件被索引、目标资产可用、缺失目标产生诊断。
- AttachTest 实机验证：`Side="Allies"` → `PlayerTemplate@Global.manifest`；`Weapon` 类型 → `WeaponSlot_WeaponData`（含 `Ordering`）；`HeadlightDraw2.xml` 进入索引、无相关诊断。

单元测试 28/28 通过，`.vsix` 已重新打包。

---

## 八、问题分析（第三轮，2026-08-01）

用户在 AttachTest `Guardian Tank\GameObject.xml` 上报了三个问题，均已修复并验证。

### 问题 A：`Locomotor="..."` 误报 "has no definition of type true"

**现象**：`LocomotorSet/@Locomotor` 引用报错，且类型显示为 **`true`**。

**根因**：模型生成器把简单类型的 `xas:isRef="true"` 当成了 `refType` 值。`Locomotor` 的类型是 `AssetReference`（只有 `xas:isRef="true"`、没有 `refType`），于是 refType 被写成字符串 `"true"`，导致任何类型匹配都失败。这是生成器 `refType` 取值逻辑的 bug。

**修复**：
- 生成器只从 `xas:refType` 取 refType，`xas:isRef` 只作为布尔标记 `isRef`（属性条目新增该字段）；
- `isReferenceAttributeOfType` 对 `refType` 或 `isRef` 都视为引用；
- `resolveReferenceTargetsForType` 对**无类型引用**（isRef 且无 refType）不做类型过滤，直接匹配同名 id——正是 `Locomotor` 这类"引用任意已声明资产"的语义。

修复后 `Locomotor="AlliedAntiVehicleVehicleTech1Locomotor"` 正确解析到 mod 的 `LocomotorTemplate`（以及 static.manifest 中的同名原版资产）。

### 问题 B：`Name="AUAntiVehicleVehicleTech1_SKN"` 误报 BaseRenderAssetType 未定义

**现象**：W3D 模型名引用报"no definition of type BaseRenderAssetType"，但资产确实存在于 static.manifest。

**根因**：两个叠加原因：
1. manifest 名格式是 `类型:子类型:文件名`（如 `W3dContainer:W3DContainer:AUANTIVEHICLEVEHICLETECH1_SKN`），旧的 id 提取只切掉第一个前缀，得到 `W3DContainer:AUANTIVEHICLEVEHICLETECH1_SKN`，无法匹配 XML 里的 `AUAntiVehicleVehicleTech1_SKN`；
2. manifest 哈希表里的类型名是 `W3dContainer`（小写 d），而 XSD 类型名是 `W3DContainer`，大小写不一致导致继承链匹配失败。

**修复**：
- `deriveAssetId` 改为取**最后一个冒号段**（资产 ID 不允许含冒号），兼容 `PlayerTemplate:Allies` 与 `W3dContainer:W3DContainer:...` 两种格式；
- `canonicalTypeName` 大小写不敏感规范化，`typeChain` / `isAssignableTo` / 属性查询统一走规范化；manifest 资产入库时类型名也规范化。

类型匹配严格遵循 XSD 继承链：`W3DContainer` / `W3DMesh` → `BaseRenderAssetType` ✓；`W3DHierarchy` → `BaseAssetType`（**不是** BaseRenderAssetType）✗。实测 `_SKN` 只解析出 `W3DContainer@Static.manifest` 一个候选，碰撞盒（id 带 `.OBBOX` 后缀）与层级自然排除。

### 问题 C：跳转候选"只能打开文件、不能精确定位"

**现象**：`Template="AlliedAntiVehicleVehicleTech1Cannon"` 有两个候选——mod 定义和 `SageXml\globaldata\weapon.xml`（由 manifest 的 `manifestSource` 映射而来）。后者只打开文件、不定位。

**修复**：
- 所有 XML 定义的跳转改为**精确范围**：用 `id` 属性值的起止偏移构造 Range（找不到时回退到元素起始标签），mod 与 SageXml 一致；
- manifest 定义映射到源码文件时，同样在源码文件内查找同名 id 并精确定位（实测定位到 `weapon.xml:2357`）；
- 新增配置 `ra3modxml.definitionMode`：`all`（默认，mod + 原版全部列出，mod 优先）或 `project-only`（项目内已定义时只跳 mod 定义）。

### 举一反三的测试（31/31 通过）

- `test/manifestTypes.test.mjs`：`deriveAssetId` 最后一段提取（含 W3D/纹理双前缀、无冒号边界）；大小写规范化后的 `isAssignableTo`（`W3dContainer`→`BaseRenderAssetType` 为真、`W3dHierarchy` 为假）。
- `test/refs.test.mjs`：无类型引用（`LocomotorSet/@Locomotor`）解析到任意声明类型的同名 id；非引用属性仍返回空。
- AttachTest 实机：三个原始场景全部按预期（Locomotor 命中 LocomotorTemplate、_SKN 命中 W3DContainer、cannon 双候选均可精确定位）。

`.vsix` 已重新打包（13:33）。D 盘恢复后照旧可补跑 GenEvoTest / Corona 回归。
