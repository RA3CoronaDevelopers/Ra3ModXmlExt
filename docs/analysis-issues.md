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

---

## 九、问题分析（第四轮，2026-08-01）：模块 `id` 被误报为未解析引用

### 问题：`id="ModuleTag_Draw"` 误报 `Unresolved reference`

**现象**：AttachTest `Allied Vehicle\Guardian Tank\GameObject.xml` 第 45 行

```xml
<TruckDraw
    id="ModuleTag_Draw"
    ...>
```

报 `Unresolved reference "ModuleTag_Draw" (not found in the current index)`，
hover 同时显示 `No matching definition of the expected declared type...`。
但该 id 是 TruckDraw（GameObject 模块）自身的标识，只在所属 `<GameObject />` 内部有效，
此处就是定义处，全局资产索引中不存在（也不应存在）它的定义。

**根因（两层叠加）**：

1. **模型生成器丢失属性级 `xas:refType`**：`ModuleData@id` 在 XSD 中声明为

   ```xml
   <xs:complexType name="ModuleData" xas:isPolymorphic="true">
     <xs:attribute name="id" type="Poid" xas:refType="ModuleData" />
   </xs:complexType>
   ```

   refType 写在 `<xs:attribute>` 节点上，而 `tools/xsd-to-model.mjs` 只从 simple type
   描述符读取 refType，属性级声明被丢弃。`Poid` 本身带 `xas:isWeakRef="true"`（“管线对象
   ID”），于是该 id 在模型里变成 `{ type: "Poid", refType: null, isRef: true }`——一个
   “无类型引用”，导致**所有继承自 ModuleData 的模块类型（以及 ObjectFilter、MapObject、
   GameScript、AIStateTactic 等共 430 个类型）的 `id` 都被当作全局引用检查**。

2. **`id` 的语义是“定义点”而非“引用”**：即便 refType 正确，嵌套元素（模块、nugget、
   地图对象）的 `id` 也只是其局部标识，检查全局 unresolved 必然误报。反过来，XSD 里确有一类
   真正引用其他资产类型的 `id`（如 `RoadObject@id` 为 `AssetReference` + `xas:refType="Road"`），
   这类检查必须保留。

**验证**：

- 用未修改的生成器对当前 SDK XSD 重新生成模型，与仓库内模型逐字段一致（0 差异），
  证明修复后重新生成的 diff 只落在属性级 refType 上，无无关噪音。
- 修复后 `W3DTruckDrawModuleData@id` → `refType: ModuleData`；
  `isReferenceAttributeOfType(...) === false`；空索引下 `TruckDraw@id` 不再产生诊断；
  全文件扫描 0 个 `id` 误报，61 处真实引用属性（`inheritFrom`、`CommandSet`、`Side`、
  `Locomotor`、`TrackMarks` 等）行为不变。

**修复**：

1. **生成器**（`tools/xsd-to-model.mjs`）：`collectAttributes` 改为
   `attr["@_refType"] ?? desc?.refType`（属性级优先、simple type 兜底），重新生成
   `schema-model.json`——共恢复 444 处 refType（含继承传播），`isRef` 与其他字段零变化。
   附带收益：`Locomotor → LocomotorTemplate`、`Armor → ArmorTemplate`、
   `ThingTemplate → GameObject` 等此前被当作“无类型引用”的属性恢复真实类型
   （第三轮中 Locomotor“无 refType”的结论实为该生成器 bug 的误判）。
2. **局部引用规则**（`src/indexer/refs.ts` 新增 `isLocalReferenceAttribute`）：
   - `id`：无 refType，或 refType 与元素自身类型兼容（`isAssignableTo`，如
     `W3DTruckDrawModuleData → ModuleData`）→ 定义点，不做全局引用检查；
     refType 指向不同类型（`RoadObject@id → Road`）→ 保留真实引用检查；
   - 非 `id` 且类型为 `Poid` 的属性（`ModuleId`、`AutoResolveBody`、`SoundRef`、
     `AttachModuleId`…）→ 管线局部引用，全局索引无法判定，不检查。
   `isReferenceAttributeOfType` 与 `resolveReferenceTargetsForType` 同步使用该守卫，
   诊断 / hover / 跳转 / 补全行为一致。
3. **补全**（`src/features/completion.ts`）：`id` 与 Poid 属性不再按 refType 提供
   全局资产补全（模块 id 是局部的，全局资产列表是错误建议）。

**测试（31 → 37，全部通过）**：

- `refs.test.mjs`：TruckDraw 实景结构（GameObject → Draws → TruckDraw）下 `id` 不再是
  引用且不解析；`RoadObject@id` 仍是引用并能解析到 Road；`AttachModuleId` 等 Poid 属性
  不误报；Locomotor 改为严格类型引用（同名 GameObject 不再匹配）；
- `schemaModel.test.mjs`：`ModuleData@id` / `MapObject@id` / `ThingTemplate` /
  `RoadObject@id` / `AttachModuleId` 的属性级 refType 断言；
- 回归：原有 31 个用例全部保持通过。

> **后续可做**：GameObject 内模块 id 的“局部作用域”解析——`AttachModuleId`、
> `ModuleId` 等模块引用指向同一 GameObject 内的兄弟模块，但部分引用（如武器上的
> `AttachModuleId`）目标 GameObject 跨文件无法静态确定，本轮先统一不检查；待局部
> 作用域建模落地后再启用这些引用的解析与诊断。

---

## 十、问题分析（第五轮，2026-08-01）：`xi:include` 的 `href`/`xpointer` 误报未知属性

### 问题

AttachTest `Allied Vehicle\Guardian Tank\GameObject.xml` 第 249 行附近：

```xml
<xi:include
    href="DATA:Includes/HeadlightDraw2.xml"
    xpointer="xmlns(n=uri:ea.com:eala:asset) xpointer(/n:HeadlightDraw2/child::*)"/>
```

报两条 `Unknown attribute "href" / "xpointer" for <include>`（`unknown-attribute`），
hover 同时显示 `Unknown attribute for this element.`。

这个元素属于 **W3C XInclude 命名空间**（`xmlns:xi="http://www.w3.org/2001/XInclude"`），
并不是 EA `uri:ea.com:eala:asset` XSD 的一部分。同一行在第二轮“问题 C”处理过
（嵌套 `xi:include` 的索引与导航），但那轮没有覆盖 unknown-attribute 诊断，属于遗留缺口。

### 根因

诊断的属性校验没有像元素校验那样排除外来命名空间：

- 元素校验已有 `!el.name.startsWith("xi:")` 守卫（所以 `<include>` 本身不报 unknown element）；
- 属性校验只跳过 `xmlns*` / `xai:` / `xi:` 前缀的属性名，而 `href`、`xpointer` 是不带
  前缀的普通属性名；
- `<xi:include>` 解析类型为 null（XSD 模型不含该元素），knownAttrs 为空 → 任何属性
  都被判为 unknown。

### 修复

1. `schemaModel` 新增两个纯函数：
   - `isXsdElementName`：`xi:` 前缀元素不属于 EA XSD 模型；
   - `isXsdAttributeName`：EA XSD 属性不带命名空间前缀，带前缀（`xai:`、`xi:`、
     `xlink:`、`xml:`、`xsi:`、`xmlns:*`）的都是命名空间机制，不做 schema 校验。
2. `diagnostics`：`xi:` 前缀元素整体跳过 schema 校验（元素与属性都不再误报）；
   前缀属性名统一跳过。
3. `hover`：`xi:include` 元素/属性给出 XInclude 说明；`href` 值悬停像
   `<Include source>` 一样解析目标文件（Ctrl+点击跳转此前已可用）。

### 验证

- 真实文件全量扫描：0 未知元素、0 未知属性（修复前 `href`/`xpointer` 两条必现）；
- 新增测试：`isXsdElementName` / `isXsdAttributeName` 断言；`xi:include` 解析类型为
  null 且不参与校验；全量 39/39 通过。

### 后续（架构方向，待确认）

用户提出“先展开 `xi:include`（类比 C++ 宏展开），再处理 mod XML 解析”。该方向与第二轮
遗留的“虚拟合并”开放项一致，设计要点：

- 构建**逻辑树**而非文本拼接：把目标文件选中内容（`xpointer` 子集）作为子节点拼入父
  元素，节点保留源文件与原始偏移，避免文本级拼接导致的偏移断裂；
- 展开范围：`xi:include` 与 EA `<Include type="all">`（内容合并）；`instance` /
  `reference` 是可见性 / 编译产物语义，不拼树；`inheritFrom` + `joinAction` 是属性级
  继承合并，不是宏展开；
- 收益：跨 include 的上下文类型解析、包含内容的结构校验、以及后续“GameObject 内模块
  id 局部作用域”（HeadlightDraw2 的模块也是该 GameObject 的模块）；
- 风险：include 环 / 深度限制、大文件性能、`xpointer` 仅支持现有子集形式
  （`/n:Name/child::*`）。

---

## 十、问题分析（第五轮，2026-08-01）：`xi:include` 的 `href` / `xpointer` 被误报为未知属性

### 问题

同一 GameObject.xml 第 246–249 行：

```xml
<!-- include Headlight draw module. -->
<xi:include
    href="DATA:Includes/HeadlightDraw2.xml"
    xpointer="xmlns(n=uri:ea.com:eala:asset) xpointer(/n:HeadlightDraw2/child::*)"/>
```

报两条 `Unknown attribute "href" / "xpointer" for <include>`（unknown-attribute），
hover 显示 `Unknown attribute for this element.`。

**与第二轮的关系**：第二轮“问题 C”处理的正是同一行的嵌套 `xi:include`——但那一轮修的是
**索引器**（嵌套 include 不再被静默忽略、缺失目标产生 include-not-found、目标内容进索引），
本轮这处 **unknown-attribute 诊断**是当时未覆盖的遗留问题。

### 根因

`xi:include` 属于 W3C XInclude 命名空间（`http://www.w3.org/2001/XInclude`），
**不是 RA3 XSD（`uri:ea.com:eala:asset`）定义的元素**：

- 未知元素检查已通过 `el.name.startsWith("xi:")` 跳过，所以没有 unknown-element 误报；
- 但属性检查没有同类守卫：`xi:include` 解析类型为 null → `knownAttrs` 为空 →
  `href`、`xpointer` 两个非 `xi:` 前缀的属性名全部落入 unknown-attribute 分支。

复现证据（真实文件）：

```
xi:include found: true | parent: Draws
resolved element type: null
known attribute names: (none)
attr href: known=false -> would flag unknown-attribute: true
```

### 修复

1. **模型层新增命名空间守卫**（`schemaModel.ts`）：
   - `isXsdElementName(name)`：`xi:` 前缀（XInclude）等外来命名空间元素不属于 XSD 模型；
   - `isXsdAttributeName(name)`：EA XSD 属性一律无前缀，带前缀的属性
     （`xai:`、`xi:`、`xlink:`、`xml:`、`xsi:`、`xmlns:*`）都是命名空间机制，不做未知属性校验。
2. **诊断**（`diagnostics.ts`）：外来命名空间元素的未知元素/未知属性检查整体跳过
   （`href`、`xpointer` 不再误报）；属性名带前缀的一律跳过校验（比原先只跳过
   `xmlns`/`xai:`/`xi:` 更完整）。
3. **hover**（`hover.ts`）：`xi:include` 的元素/属性悬停显示 XInclude 说明；
   `xi:include@href` 与 `Include@source` 一样显示解析后的目标文件（与第二轮已可用的
   Ctrl+点击跳转对齐）。

**测试（37 → 39，全部通过）**：

- `schemaModel.test.mjs`：`isXsdElementName` / `isXsdAttributeName` 判定
  （`xi:include` 非 XSD 元素；`href`/`xpointer` 是合法属性名形态；
  `xai:joinAction`、`xlink:href`、`xmlns:xi` 等带前缀属性不校验）；
- `refs.test.mjs`：GameObject → Draws → `xi:include` 实景结构解析类型为 null、
  元素被判定为外来命名空间，`href`/`xpointer` 不会进入未知属性分支；
- 实机复验：整份 GameObject.xml 0 个 unknown-attribute 残留。

> **架构讨论（用户提议）**：把 XML 先“宏展开”成不含 `xi:include` 的版本再解析。
> 这与 BAB 编译时的实际行为一致（`defaultscript.cs` 把整个 Mod 合并成一份大 XML），
> 也是实现“GameObject 内模块 id 局部作用域解析”（第四轮遗留）的正确地基——展开后一个
> GameObject 连同 include 进来的兄弟模块都在同一棵树里，`AttachModuleId` 等模块引用才能
> 静态判定。设计备忘（现状 / 逻辑树方案 / 展开范围 / 落地点 / 检查清单）已整理在
> `docs/plan.md` 第六节，等待确认后作为下一阶段实现。

---

## 十一、问题分析（第六轮，2026-08-01）：`Surfaces="` 未闭合引号导致枚举补全失效

### 现象

在 `<Locomotor ...>` 的起始标签里输入 `Surfaces="`（引号尚未闭合）时：

1. 光标处不出 `LocomotorSurfaceBitFlags` 的枚举补全（GROUND、WATER 等）；
2. 整个文件高亮退化（XML 变成“不合法”的观感），直到补上第二个引号才恢复。

### 根因（两个独立缺陷叠加）

**A. 上下文分析不认未闭合的引号（`src/language/context.ts`）**

复现证据（编译产物直接执行）：

```
闭合引号:  <Locomotor id="x" Surfaces="GROUND">…
ctx.kind = attribute-value, attr = Surfaces, valuePrefix = "GROUND"

未闭合引号: <Locomotor id="x" Surfaces="GROUND>…
Surfaces: quoteStart=27, quoteEnd=-1   ← 解析器吞掉整个文件
ctx.kind = attribute-name              ← 补全走错分支
```

`analyzeStartTag` 判断属性值上下文的条件是 `offset >= quoteStart && offset <= quoteEnd`，
未闭合时 `quoteEnd = -1` 永远不成立，于是回退成 attribute-name。

**B. 模型生成器不支持 `xs:list`（`tools/xsd-to-model.mjs`）**

XSD 中 `LocomotorSurfaceBitFlags` 是：

```xml
<xs:simpleType name="LocomotorSurfaceBitFlags">
  <xs:list itemType="Surface"></xs:list>
</xs:simpleType>
```

而 `Surface` 才是真正带 11 个枚举值（GROUND、WATER、CLIFF、AIR…）的类型。生成器
只读取 `restriction.enumeration`，list 层把枚举全部丢掉——所以**即使引号闭合，模型里
该属性也没有任何候选值**。影响面：SDK XSD 共 79 个 `xs:list` 简单类型、317 处属性
声明使用它们（`KindOfBitFlags`、`ObjectStatusBitFlags`、`WeaponFlagsBitFlags`、
`ModelConditionBitFlags`、`BuildPlacementTypeBitFlags` 等），展开到继承后的模型条目
共 890 个属性受影响。

### 关于高亮丢失

这是 TextMate XML 语法对“未闭合字符串”的正常行为：后续内容被当作字符串吞掉，直到
遇到下一个引号或 EOF。与插件注入语法无关（注入部分只有 `$DEFINE`、`inheritFrom` 等
少量规则），**即使改成 LSP 也不会自动消失**。真正的解法是语义 token
（`DocumentSemanticTokensProvider`），本次未实施，列为可选后续。

### 修复（第 1–4 项）

1. **解析器行尾恢复**（`src/language/xmlParser.ts`）：起始标签扫描到 EOF 且引号仍未
   闭合时，把标签在第一个换行处截断并继续解析主循环。未闭合引号只影响当前行，后面
   的元素照常进入解析树，补全 / hover / 诊断不中断；解析错误仍照常上报
   （`Unterminated start tag`）。
2. **未闭合引号上下文**（`src/language/context.ts`）：`quoteEnd < 0` 时，
   `offset >= quoteStart` 即视为 attribute-value 上下文，`valuePrefix` 照常取引号后
   到光标处文本。
3. **模型支持 `xs:list`**（`tools/xsd-to-model.mjs`）：`resolveTypeDescriptor` 解析
   `xs:list` 的 `itemType`（属性形式或内联 simpleType），继承其枚举值 / refType /
   isRef / allowsDefine，新增 `isList` 标记；重新生成 `schema-model.json`
   （`LocomotorSurfaceBitFlags` 恢复 11 个枚举值，`ModelConditionBitFlags` 457 个
   值与 XSD 一致）。`AttributeInfo` / `SimpleTypeInfo` 接口同步新增 `isList`。
4. **多值补全按“最后一段”过滤**（`src/features/completion.ts` +
   `context.splitListValuePrefix`）：list 属性只取当前空格段做前缀过滤，替换范围只
   覆盖该段——`Surfaces="GROUND ` 之后输入 `W` 也能提示 WATER / WALL_RAILING，而不是
   用整段前缀匹配失败。

### 验证

- 未闭合引号复现场景：仅报 1 条 `Unterminated start tag`，`<Other/>` 等后续元素仍被
  解析；`ctx.kind = attribute-value`、`attr = Surfaces`、`valuePrefix = "GROUND"`。
- 模拟补全过滤：前缀 `G` → `GROUND`；前缀 `W` → `WATER, WALL_RAILING`；
  `GROUND ` 后输入 `W` → `WATER, WALL_RAILING`。
- `GameObject@KindOf`：`isList=true`、284 个枚举值。
- 单元测试 **39 → 50 全部通过**（新增 `test/context.test.mjs` 与带 vscode stub 的
  `test/completion.test.mjs` 集成用例；xmlParser 新增未闭合引号恢复 / EOF 用例；
  schemaModel 新增 list 枚举与 `isList` 用例）。
- `tsc` / `esbuild` 构建通过。

> 补充：真实文件中该场景的元素名是 `<LocomotorTemplate ...>`（AttachTest
> `Locomotor.xml` 实测，`Surfaces="GROUND CRUSHABLE_OBSTACLE"` 正是多值 list）；
> SDK XSD 中没有名为 `Locomotor` 的元素，补全集成测试按真实写法夹具。

### 后续可做（未列入本次）

- `AssetIdList` 等“任意资产 ID 列表”的引用语义建模（list 补全框架已就绪，但这类
  属性在 XSD 里没有 refType，需要另行定义过滤规则）。

> 语义 token 兜底高亮已在第七轮实现（见下节）。

---

## 十二、问题分析（第七轮，2026-08-01）：语义 token 兜底高亮

### 目标

未闭合引号期间 TextMate 把后续内容当字符串吞掉、整个文件高亮退化，这是 XML 语法
固有的行为（任何 XML 编辑器皆然），也无法靠注入 grammar 修复。本轮的解法是语义
token：文档出现解析错误时，由插件用自己的容错解析树继续给标签 / 属性 / 值着色。

### 设计

- **纯 TS 核心**（`src/language/semanticTokens.ts`）：`buildSemanticTokenRanges(doc, text)`
  把解析树转换成按位置排序的 `{ line, startChar, length, tokenType }`；token 类型只用
  标准 `type` / `property` / `string`，所有主题自带配色，无需额外贡献样式。
  - 元素名：起始标签与闭合标签各一个 `type` token；
  - 属性名：`property` token；
  - 属性值：`string` token，闭合时含两端引号，未闭合时从开引号到行尾恢复点
    （如 `"GROUND>`）。
- **provider**（`src/features/semanticTokens.ts`）：`parseXml` 后若
  `doc.errors.length === 0` 直接返回空——合法文件观感与纯 TextMate 完全一致；
  有解析错误时才用 `SemanticTokensBuilder` 编码输出。
- **注册**：`extension.ts` 对 `xml` 语言注册 `DocumentSemanticTokensProvider`，
  legend 与 provider 共用同一实例。

### 验证

- malformed（`Surfaces="GROUND>` 未闭合）：`AssetDeclaration` / `LocomotorTemplate` /
  `<Other/>` 标签名、`id` / `Surfaces` 属性名、`"x"` 与 `"GROUND>` 值均有 token，
  且按位置升序排列；
- 合法文档：返回空 token 数组；
- 单元测试 **50 → 53 全部通过**（新增 `test/semanticTokens.test.mjs`，纯函数 + vscode
  stub 的 provider 集成）；`tsc` 通过。

### 边界与取舍

- 语义 token 只在解析报错时启用，且使用主题对 `type` / `property` / `string` 的默认
  配色，可能与 TextMate XML 配色略有差异——只在打字过程中出现，可接受；
- 未实现 `provideDocumentSemanticTokensEdits`（delta 版本），每次全量计算；单文件
  解析在 KB 级，开销可忽略。

---

## 十三、问题分析（第八轮，2026-08-02）：`.w3x` 美术资产未被索引（AUGunship_SKN）

### 问题

AttachTest `Harbinger Gunship\GameObject.xml` 中 `<Model Name="AUGunship_SKN"/>`
报两条错误：

1. Problems 面板诊断：`Unresolved reference "AUGunship_SKN" (not found in the current index)`
   （`unresolved-reference`，来自 `features/diagnostics.ts`）；
2. 悬停提示：`No matching definition of type BaseRenderAssetType in the current index
   (may exist in a compiled manifest or vanilla data).`（来自 `features/hover.ts`）。

两条是同一缺失定义的两种呈现（诊断 + hover），不是两个独立 bug。
`W3DContainer:AUGunship_SKN` 确实由 mod 定义——但定义在
`Harbinger Gunship\W3X\AUGUNSHIP_SKN.w3x` 里，而索引器只解析 `.xml` / `.manifestxml`。

### 关键事实（实测）

1. **`.w3x` 是文本 XML**：文件头即 `<?xml ...?>` + `<AssetDeclaration>`，内容为
   `<W3DContainer id="AUGUNSHIP_SKN" Hierarchy="AUGUNSHIP_SKL">` + `<SubObject>` 子树。
   附带 UTF-8 BOM（抽样 292 个 Corona w3x：0 个 UTF-16，40 个带 BOM）。
2. **w3x 通过 `<Include type="all">` 链进索引**：`Mod.xml → … → W3X.xml → W3X/*.w3x`，
   也常用 `ART:xxx.w3x`（SDK 根、项目 `Art` 等搜索路径）。索引器此前只把 w3x 登记为
   文件（`stream.files`），从不解析，因此其顶层资产不在 `assetsById` 中。
3. **类型匹配本来是对的**：`Model@Name` 的 refType 是 `BaseRenderAssetType`，
   `W3DContainer → BaseRenderAssetType` 可赋值（`isAssignableTo` = true）。缺的只是定义。
4. **manifest / SageXml 支持早已存在**（第二轮/第三轮），但该资产是 mod 自己的 w3x，
   不在 `builtmods/*.manifest` 也不在 SageXml——hover 的 "may exist in a compiled manifest
   or vanilla data" 只是通用兜底文案。

### 规模调查（Corona，D: 盘已连接）

- **3788 个 w3x，共 2.64 GB**；最大 22.8 MB；163 个超过原 4 MB 解析上限，11 个超 10 MB。
- 大文件结构符合"建模软件导出"模式：顶层是少量固定 W3D 资产
  （`W3DHierarchy` + 若干 `W3DMesh` / `W3DContainer` / `W3DCollisionBox`，
  有的还带 `<Includes>` 引用 `ART:*.xml`）；体积大头是 `W3DMesh` 内的
  `Vertices/V`、`Normals/N`、`TexCoords/T`、`Triangles/T` 等 `maxOccurs="unbounded"`
  数值元素。例如 21.7 MB 的 `CBRefinery_BLD.W3X` 只有 22 个顶层记录，
  Vertices+Triangles 块占约 12 MB（55%）。
- 全量建 DOM 的代价（实测 6.3 MB Aegis 文件）：407 ms、193,651 个元素、
  **堆内存 +109 MB（约 17 倍文本体积）**；22 MB 文件外推约 1.5 s + ~380 MB/份。
  浅扫描（只取顶层记录）：6.3 MB ~200 ms、22 MB ~600 ms，保留内存近似为零。
- **读整个文件不可避免，但建树不是**：浅扫描仍然是线性扫描全文（要知道顶层元素边界
  就必须扫完），只是不分配子节点对象——所以"事后优化"完全有意义，且是必要项。

### 修复

1. **新增浅扫描模块** `src/indexer/shallowScan.ts`（纯 TS）：
   单次线性扫描，只提取顶层元素 `name + id`（含精确 offset）、顶层 `<Includes>`
   的 `Include@type/source`、任意层级 `<xi:include>` 的 `href/xpointer`、`<Defines>`
   常量；注释 / CDATA / DOCTYPE / PI 整体跳过；属性解析兼容引号内 `>` 与 `/`。
2. **索引模式三分**：`.xml`/`.manifestxml` 全量解析（4 MB 上限不变）；
   `.w3x` 一律浅扫描；未知扩展名先嗅探文件头（512 字节，BOM/空白后以 `<` 开头且无
   NUL 字节 → 按 XML 浅扫描，否则按二进制仅登记）。w3x 自身的 `<Includes>` 与
   嵌套 `xi:include` 会继续被 walk（BAB 语义）。
3. **持久缓存**：`DocumentCache` / `ShallowScanCache` 移到 `src/indexer/caches.ts`，
   由 `ModWorkspace` 持有并传入每次新建的 `ModIndexer`；读取时按 `mtimeMs + size`
   校验，未变化不重读。这是 w3x 方案在 Corona 上可用的前提（否则每次保存都重读 2.6 GB）。
4. **BOM 剥离**：`xmlParser` 新增 `stripBom()`，全量解析与浅扫描前统一剥离，
   保证第一行偏移与编辑器一致。
5. **Include source 补全候选**：DATA 目录与项目相对路径候选加入 `.w3x`
   （`fileScanner`），`W3X/xxx.w3x`、`ART/xxx.w3x` 可补全。
6. 索引报告/状态栏新增 `shallowScannedFiles` / `shallowCacheHits` 统计。

### 验证

- 单元测试 **53 → 63 全绿**：新增 `test/shallowScan.test.mjs`（顶层资产 / Includes /
  xi:include / Defines / 引号内 `>` / CDATA / 未闭合标签 / 数值载荷不产生记录）；
  indexer 新增 w3x 链、`.w3d` 嗅探、二进制 `.dds` 跳过、跨重建缓存命中、
  BOM 偏移断言；xmlParser 新增 `stripBom` 用例。
- AttachTest 实机：
  - 首次构建 1.2 s，浅扫 62 个文件；`Model@Name=AUGunship_SKN` →
    `W3DContainer @ …\W3X\AUGUNSHIP_SKN.w3x:3`；`Hierarchy=AUGunship_SKL`、
    `AUGunship_FP` 同样解析；资产数 35,546 → 35,607。
  - 第二次构建 354 ms，0 次重扫，62 次缓存命中。
- Corona 实机（D: 盘）：
  - 首次构建 241 s：8,976 个文件、**浅扫 4,829 个**、资产 64,868
    （manifest 35,322）、3 个流、183 个 Define。
  - 第二次构建 38 s：0 次重扫、4,829 次缓存命中、资产数一致。
  - `CBREFINERY_BLD` 正确解析到 `W3DHierarchy @ cb/CBRefinery_BLD.w3x:16` 与
    `W3DContainer @ …:776412`。

### 边界与后续

- 首次建索引较慢（Corona ~4 分钟，机械盘）：读 2.6 GB 是下限，浅扫描本身 ~30-90 s；
  后续可做并行扫描或把 w3x 顶层记录做成独立小缓存文件。
- 第二次构建仍有 ~38 s（主要是对 ~9k 文件逐文件 stat + 重建 Map，机械盘随机读）；
  后续可做"文件清单 + stat 快照"级缓存。
- 浅扫描对 w3x 不做 XSD 校验（编辑器特性不注册 w3x 语言）；若用户手动把 `*.w3x`
  关联为 xml，完整解析仍会发生在打开的文档上（VS Code 自身行为）。
- UTF-16 XML 的 w3x 会被嗅探判定为二进制（文件头含 NUL）；实测生态中不存在，
  如遇可再扩展解码。
