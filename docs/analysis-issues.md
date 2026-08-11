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
`Harbinger Gunship\W3X\AUGUNSHIP_SKN.w3x` 里，而索引器只解析 `.xml`
（manifest 是 `*.manifest` 二进制，不存在 `.manifestxml` 源码格式）。

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
2. **索引模式三分**：`.xml` 全量解析（4 MB 上限不变）；
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
  indexer 新增 w3x 链、未知扩展名 XML 嗅探（fixture 用 `.dat`）、二进制 `.dds`
  跳过、跨重建缓存命中、
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

---

## 十四、问题分析（第九轮，2026-08-02）：Corona 重建性能与内存

### 目标与基线

第八轮后 Corona 的实测基线：

| 场景 | 耗时 |
|---|---|
| 首次全量建索引 | ~180-290s（机械盘波动） |
| 信任二次构建（保存触发） | 8-21s |
| 强制 reindex | 26-38s |
| 首建后保留堆 | ~2.5GB（原因不明） |

### 调查 1：二次构建为何仍有 8-21s

插桩 `fs.statSync` 后发现：**每次构建（含信任重建）都会执行约 11 万次同步 statSync**，
全部来自 `resolveSource` 的 include 目标存在性检查（BAB 搜索路径逐 base `statSync`）。
机械盘上这就是 10-20s 的来源——即使文件内容全部命中缓存，include 解析仍在逐路径 stat。

修复：新增 `IncludeResolveCache`（workspace 级、跨重建复用）：
- 键 = 当前文件目录 + source 字符串；命中直接返回，不 stat；
- 内容编辑不影响"文件是否存在"，因此保存触发的重建**不清除**解析缓存；
- 文件创建/删除（watcher `onDidCreate` / `onDidDelete`）与 `ra3modxml.reindex`
  （强制校验）清除缓存；
- `reference` 的 manifest 查找（`builtmods/*.manifest` 存在性）同样缓存；
- 配置变更（搜索路径 / builtmods 目录）时清除。

### 调查 2：首建后保留堆 2.5GB 是什么

逐级清空测量（构建 → 清 DOM 缓存 → 清 records → 清 walker → 清索引 Map）：

- `DocumentCache`（元素预算 1M、64 条）：实际只保留 64 条 / 1788 个元素 ≈ 1MB；
- `IndexRecordsCache`（8976 个文件的紧凑记录）：约 11MB；
- 目录 walker：约 4MB；
- 全部索引 Map（manifests + assets + assetsById + defines + files + streams +
  candidates + diagnostics）：约 75MB；
- 全部清空并强制 GC 后，堆回到基线（0MB 保留）。

结论：2.5GB 是**构建期可回收垃圾**（60MB XML 的 DOM 瞬态 + 2.6GB w3x 扫描文本/行映射
的分配压力），不是常驻泄漏；VSCode 正常 GC 压力下会回收。扩展常驻内存约为
基线 + ~100MB。顺带修复了一个潜在常驻风险：w3x 的 `LineMap`（Corona 全量约 700MB）
不再随 `ShallowScanCache` 保留，浅扫描结果以"带行号的紧凑记录"形式缓存。

### 其他改动

1. **`IndexRecordsCache` 取代 DOM 依赖的重建**：新增 `src/indexer/records.ts`，
   每个文件解析时提取紧凑索引记录（顶层资产 / Define / Include / xi:include +
   1-based 行号），跨重建缓存；信任重建完全不接触 DOM。
2. **`DocumentCache` 双重淘汰**：条数（LRU）+ 元素预算（超预算先淘汰最大树），
   把 DOM 常驻内存封顶；DOM 只服务于按需特性（跳转精确范围等）。
3. **候选目录扫描并行化**（`collectSourceCandidates` 各目录 `Promise.all`）。
4. **阶段计时**：`stats.candidatesMs` / `stats.walkMs` / `stats.resolveCalls` /
   `stats.resolveCacheHits` 进入索引报告，便于后续定位耗时。
5. 版本 0.1.0 → **0.1.1**。

### 实测（Corona，D: 机械盘）

| 场景 | 优化前 | 优化后 |
|---|---|---|
| 首次全量建索引 | ~180-290s | ~250s（含 2.6GB w3x 读取+浅扫描、~7.6 万次冷 statSync） |
| 信任二次构建 | 8-21s | **2.0s**（statSync 0 次，resolveHits 15,333） |
| 强制 reindex | 26-38s | ~5s（保留解析缓存时）；显式命令会清解析缓存，约 15-25s |
| 首建后保留堆 | ~2.5GB（疑为泄漏） | 确认是可回收垃圾；常驻 ~100MB |

单元测试 **63 → 73 全绿**：新增 `records.test.mjs`（DOM→记录提取、浅扫描→记录）、
`caches.test.mjs`（元素预算淘汰、LRU、records/resolve 缓存），indexer 测试补充
resolve 缓存命中与"信任重建 0 次重解析"断言。

### 遗留

- 首次全量建索引仍受限于机械盘读 2.6GB + 冷 statSync（~4 分钟）；后续可考虑
  并行浅扫描（worker）或把 w3x 顶层记录持久化到磁盘缓存。
- `ra3modxml.reindex` 出于正确性会清空解析缓存（可能 ~15-25s）；如接受 watcher
  可靠性可改为保留。

---

## 十五、问题分析（第十轮，2026-08-03）：索引未完成时的部分可用性与分阶段索引

### 目标

第九轮遗留：Corona 首次全量建索引约 4 分钟（2.6GB w3x 读取 + 冷 statSync），
期间插件所有功能被整体关闭（`ws.index == null`）。本轮让插件在索引完成前
分层可用，并把最耗时的 w3x 扫描放到后台阶段。

### 现状证据

- `diagnostics.update` 无索引时直接清空诊断：连 XML 语法错误、未知元素、缺 id
  这类不依赖索引的检查也被关闭；
- 补全的 `attribute-value` / `content` 分支无索引直接返回空，但枚举 / 布尔 /
  Include type / 子元素补全并不需要索引（`contentItems` 甚至没用 idx）；
- hover / 文档链接的 Include 解析只依赖搜索路径（settings），不需要索引；
- Find All References 完全不使用索引。

### 设计

1. **索引状态模型**：`ModIndex` 增加 `complete` / `phase`（`"xml" | "art"`）/
   `stale`；`stats` 增加 `phase` / `complete` / `deferredArtFiles` /
   `artScanMs`。
2. **分阶段索引**：
   - 阶段 A（xml）：walk include 链时只**登记** w3x / 嗅探 XML 文件
     （`readDocument` 的 `deferArt` 模式），不读内容；manifest、项目 XML、
     mapmetadata 全部正常索引；结束后发布不可变快照；
   - 阶段 B（art）：按队列浅扫描 w3x、应用资产记录，并继续走 w3x 内的
     Include / xi:include（此时新遇到的美术文件立即扫描，不再入队）；
   - 快照不可变性的关键：`addAsset` 在阶段 B 仍会向数组 push，所以阶段 A
     发布时必须复制 `assets` / `assetsById` / `defines` / `streams.files` /
     `diagnostics`（`snapshotIndex` 深拷贝嵌套 Map/数组）。
3. **部分可用性（T0 解耦）**：
   - 诊断：语法错误、未知元素/属性、缺 id、同文件重复 ID、Include 目标存在性
     不再依赖索引；引用 / `$DEFINE` / 跨文件重复在索引未完成或 stale 时
     “显示但标注”：code 变为 `unresolved-reference-indexing` /
     `undefined-define-indexing`，消息追加 `(index incomplete — may be a
     false positive)`；跨文件重复追加 `(based on a partial index)`；
   - 补全：枚举 / 布尔 / Include type / `xai:joinAction` / 子元素（content）
     在无索引时可用；资产 ID / define / include source 仍需索引；
   - hover / 文档链接：Include source / `xi:include href` 用 settings 搜索路径
     即可解析；无索引时引用值 hover 提示 “Index is still building”。
4. **构建中文件被修改**：
   - watcher 的 change / create / delete 现在都会 `scheduleRebuild()`（此前
     只 `invalidate`，外部修改后没有任何东西触发重建）；
   - 新增 `InvalidationsEpoch`：`invalidate` / `invalidateExistence` 递增；
     构建开始时记录 epoch，发布每个快照（含最终）时若 epoch 变化则标记
     `stale`（状态栏显示 `(stale)`）；dirty 机制保证构建结束后立即再重建收敛；
   - 构建失败时保留上一个可用快照并标记 stale，不再清空索引。
5. **stat 结构扩展**：`IndexedFile.stat` 从 `{ mtimeMs, size }` 变为
   `{ mtimeMs, size, birthtimeMs, ctimeMs }`，为磁盘持久化缓存铺路
   （FAT32 的 mtime 只有 2 秒粒度，多信号可捕捉“保留 mtime 的整体替换写入”）。

### 验证

- 单元测试 **73 → 79 全绿**：
  - indexer：phase-A 快照发布（XML/manifest 资产可用、美术资产缺席）、快照
    不可变性、`deferredArtFiles` 统计、`artScanMs`、mtime 变更强制重读；
  - caches：`InvalidationsEpoch` 递增 / 快照语义；
  - completion：无索引时枚举 / 元素名 / 属性名 / 子元素补全仍工作。
- `tsc` + esbuild 构建通过。

### 实机复现与补充修复（2026-08-03）

在 Corona 上实测新版索引器：

- 阶段 A（xml）**27.0s** 发布：54,283 资产（含 manifest 35,322）、8,399 文件、
  4,797 个 w3x 待扫；最终 **118.0s**：64,868 资产、8,976 文件、4,829 浅扫
  （artScanMs ≈ 91s，walkMs ≈ 26s）。
- `OnSeaUnitCrate.xml` 中的引用在阶段 A 即可解析（`Locomotor=JapanEggLocomotor`
  、`CommandSet=EmptyCommandSet` 均有候选）；`LocomotorSet@Condition` 是
  19 个枚举值的模型属性，无索引时即可补全。

由此确认两个真实体验问题并修复：

1. **状态栏初始不显示 indexing**：`workspaceContains` 激活事件在大目录上扫描
   较慢，打开工作区后扩展尚未激活，看起来“没有任何功能”。`activationEvents`
   增加 `onLanguage:xml`，打开任意 XML 文件即激活；同时各 provider 增加
   `isRa3Workspace()` 守卫，避免在非 RA3 工作区误补全/误诊断。
2. 索引构建中执行 “Show index report” 提示 “no index available” 有误导 →
   新增 `ws.isBuilding`，构建中改为提示 “index is still building”。

版本 **0.1.1 → 0.1.2**（重新打包 `ra3-mod-xml-0.1.2.vsix`）。

---

## 十六、问题分析（第十一轮，2026-08-03）：冷启动磁盘缓存与首建 statSync 消除

### 目标

第十轮后 Corona 首次建索引仍需 ~2 分钟，且每次新会话（重启 VS Code）都要
重来一遍。本轮做两件事：

1. **文件集快照替代 statSync**：`resolveSource` 的逐 base `statSync` 存在性
   检查（Corona 首建约 11 万次）改为目录枚举建立的 `Set` 查询；
2. **磁盘持久化缓存**：records 缓存（含 w3x 浅扫记录）跨会话落盘，冷启动
   只做 stat 校验，不再重读 2.6GB 美术资产。

### 设计

1. **ExistenceSnapshot**（`src/indexer/existence.ts`）：
   - **惰性按目录 readdir**：只在实际查询某个候选路径时读取它的父目录
     （`readdirSync` + `withFileTypes`，不 stat 单个文件），结果按目录缓存；
     不做首建前的全量递归枚举（该方案曾让 XML 阶段从 27s 涨到 45s）；
   - 覆盖根判定：候选父目录落在根内 → 目录条目 Set 查询（`hits`）；落在
     根外 → `statSync` 回退（`fallbacks`）；
   - 盘符根（`C:\` 等）与不存在的根不枚举，避免遍历整个磁盘；
   - 子根被更宽的根覆盖时跳过（如 `sdkDir` 覆盖 `sdkDir/SageXml`）。
2. **DiskRecordsCache**（`src/indexer/diskCache.ts`）：
   - gzip JSON，原子写（tmp + rename），版本号 + identity key
     （项目/SDK/设置哈希，配置变化自动忽略旧缓存）；
   - 每条记录保存多信号 stamp `{ size, mtimeMs, birthtimeMs, ctimeMs }`；
   - 加载时并发（32）stat 校验，不匹配/缺失丢弃，构建时重读；
   - 缺失/损坏/身份不符 → 空结果，不报错。
3. **workspace 集成**：
   - 构建前若内存 records 缓存为空，从磁盘加载并校验（状态栏显示
     “validating cache…”）；构建成功后异步回写（entries 先快照，避免与
     下一次构建竞争）；
   - 新命令 `ra3modxml.clearCache`（清内存 + 删磁盘文件 + 强制重建）与
     `ra3modxml.showCacheReport`（缓存路径/大小/加载校验统计/命中数）。

### 实测（Corona）

| 场景 | 结果 |
|---|---|
| 首次构建 | 118.7s（phaseA **24.0s**）；snapshotHits **75,926**、fallbacks **0**、resolveCalls 11,061 |
| 保存缓存 | 0.1s；gzip 后 **651 KB** |
| 加载 + stat 校验 | 0.2s（8,976 条全部校验通过） |
| 新会话二次构建 | **10.9s**（w3x 重扫 0、shallowCacheHits 4,829、recordsCacheHits 4,166） |

冷启动（加载 + 校验 + 构建）约 **11s**，对比之前每次 ~2.5 分钟。

### 测试与验证

- 单元测试 **79 → 90 全绿**：
  - `existence.test.mjs`：覆盖/未覆盖判定、hits/fallbacks、盘符根识别、
    搜索 base 枚举、`resolveSource` 快照命中与 statSync 回退；
  - `diskCache.test.mjs`：roundtrip、原子写无残留 tmp、stat 变更丢弃、
    identity 不符忽略、损坏文件空结果、clear、key 稳定性；
  - `caches.test.mjs` 增加 `entries()`；indexer 统计断言 snapshotHits。
- `tsc` + esbuild + `vsce package` 通过。

### 遗留

- 首次构建 phase A 现在包含快照目录枚举成本（Corona 实测约 +10-17s，后续
  构建由 walker 缓存吸收）；如 SDK 根目录特别大可再优化根覆盖策略。
- w3x 并行/流水线浅扫描仍未做（HDD 收益存疑，SSD 再做）。

### 补充（用户实测反馈，2026-08-03）

用户在 0.1.3 上删除 workspace storage 缓存后实测：

- XML 阶段约 45s（比之前 27s 多）→ 根因是磁盘缓存轮实现的**全量目录枚举
  快照**在首建前递归枚举 SDK 根等搜索根。已改为惰性按目录 readdir，复测
  phase A **24.0s**，statSync 消除效果不变（75,926 次快照命中、0 回退）。
- “show index report 显示 Indexed in 1.1s、0 浅扫、8995 缓存命中”与观察
  不一致 → 首建完成后又发生了一次信任重建（follow-up）。为定位触发源，
  新增**重建插桩**：`buildCount` / `lastBuildTrigger`（initial、save、
  watcher-create/change/delete、config、reindex-command、clear-cache、
  dirty-followup）+ “RA3 Mod XML” 输出通道（每次构建记录 trigger、phase A
  发布时间、完成耗时）；索引报告与缓存报告均显示构建序号与触发原因。

### 补充 2（0.1.4 日志复现，2026-08-03）

0.1.4 输出通道日志：

- build #1：phase A 31.4s、done 120.1s、**stale=true**；
- build #2：`dirty-followup (initial)`，0.6s（报告计时不一致的直接来源）；
- build #3/#4/#5：每 ~35s 一次 `watcher-change`，每次 0.5s 重建。

build #1 的 stale=true 与周期性 watcher-change 均不符合预期：说明有后台进程
在周期性触碰被监视目录（最可疑是 `.git` 内部文件，如后台 fetch/maintenance）。
处理：

1. watcher 事件现在把**触发 URI 写入输出通道**（`[watcher-change] <path>`），
   可直接定位是哪个文件/目录在变化；
2. 新增 `isWatcherNoisePath`：路径含 `.git` 段的事件直接忽略（不 invalidate、
   不标记 stale、不触发重建）；单元测试 90 → 91。

版本 **0.1.4 → 0.1.5**。

### 补充 3（0.1.5 日志复现，2026-08-03）

0.1.5 日志中周期性重建已消失，但首建期间仍有一次：

```
[watcher-change] d:\...\corona\Data\Neutral\Crate\UnitCrate.xml.git
```

该文件**并不存在**（疑似其他 VSCode 扩展产生的瞬时临时文件），且它是
`*.xml.git` 文件名，不是 `.git` 目录段，绕过了上一轮过滤；它也导致 build #1
stale=true 并触发 follow-up。处理（按用户建议的扩展名白名单思路）：

1. `isWatcherNoisePath` 增加临时文件命名模式：`.git` / `.tmp` / `.lock` /
   `~` / `.swp` / `.bak` / `.orig` 后缀，以及 `.#` / `.~` 前缀；
2. `onDidChange` 只响应**内容相关**文件：扩展名白名单（`.xml` / `.w3x`；
   领域修正：RA3 合理文本格式为 xml/w3x/lua，lua 暂未索引，manifest 为
   `*.manifest` 二进制，不存在 `.manifestxml`）或已在当前索引中的文件
   （`ModIndexer.isIndexedFile`，覆盖被嗅探为 XML 的未知扩展名）；纹理等
   二进制内容变更不触发重建；
3. 创建/删除仍对所有真实文件响应（影响 include 存在性），临时文件模式除外。

测试 91 → 92；版本 **0.1.5 → 0.1.6**。

### 遗留（此处的磁盘缓存与文件集快照已在第十一轮完成，T1 已在第十二轮完成）

- w3x 文件名启发式定向扫描（按约定后续再做）。
- `AssetIdList` 等“任意资产 ID 列表”的引用语义建模。
- Find All References 已改为语义引用索引（第十八轮，2026-08-05，见
  `docs/features-reference-counts.md`）；通用内容搜索与索引复用仍属 P1 远期。

---

## 十七、问题分析（第十二轮，2026-08-03）：当前文档局部链与 include 逻辑树展开（T1）

### 目标

上一轮遗留的 T1：让**不在任何全局流里的文件**也能解析自身引用，并为 GameObject
内模块 `id` 的局部作用域（`AttachModuleId` / `ModuleId` / `AutoResolveBody` 等）
铺路。两件事一起做：

1. **T1a 文档局部 overlay**：当前打开的文档（含未保存文本）自身资产 / `$DEFINE`
   及其 include 链进入一个轻量局部索引，与全局索引叠加使用；
2. **T1b 逻辑树展开**：`xi:include` 按现有 `xpointer` 子集拼入当前文档的逻辑树，
   使 include 进来的内容获得正确的父上下文，并让 Poid 引用能在同一 GameObject
   子树内解析。

### 现状证据

- 全局索引只从 `Data/Mod.xml` 与 `additionalmaps/mapmetadata_*.xml` 出发；
  `Data/Standalone.xml` 这类未进流的文件，其自身 `GameObject` / `$DEFINE` 不会
  出现在 `ws.index`，`inheritFrom`、`CommandSet` 全部无法解析；
- `xi:include` 此前只做到“目标文件可索引 / 缺失可诊断”，没有拼入当前文档树；
  include 进来的 `TruckDraw` 等模块拿不到 `Draws` 子元素的上下文类型；
- `isLocalReferenceAttribute` 对所有 Poid 属性一律“不检查、不解析”，导致
  同一 GameObject 内完全可静态判断的模块引用也没有 hover / 跳转 / 补全。

### 设计

1. **共享 `xpointer.ts`**：`localName` / `findXPointerContainer` 从 indexer 迁出，
   全局索引与局部展开共用同一份 xpointer 子集实现。
2. **`logicalTree.ts`**：
   - 按解析器扁平元素表预建逻辑节点壳（保留原始 `sourceFile` 与偏移），再按
     真实根 + 容错孤儿根遍历，重建 parent/child 链；
   - `xi:include` 解析 href → `readDom` 目标 → 按 `xpointer` 选择容器子节点 →
     拼入逻辑父元素；目标缺失 / 环 / 超深时跳过（环与深度用 visited + 64）；
   - 保留 xi 节点本身在 `elements` 中，hover 仍可解释 XInclude。
3. **`localScope.ts`**：
   - `buildDocumentScope` 返回原始 parse、逻辑树、per-source LineMap、局部
     overlay 与 overlay-aware merged index；
   - overlay 沿 `<Include type="all/instance">` 与 `xi:include` 递归收集资产 /
     Define；`reference` 指向 manifest，资产由全局索引提供，不重复解析；
   - `withLocalOverlay` 不复制全局 Map（Corona ~65k 资产），只把 overlay 挂到
     `ModIndex.local`，查询函数“局部优先、全局兜底”。
4. **workspace 集成**：`getScope(document)` 按 URI + 文档 version + 全局索引
   代次缓存；全局索引发布 / 文件关闭时失效；首个 indexer 创建前的兜底读取走
   `fallbackRead`（小 XML 直接解析）。
5. **features 接入**：
   - diagnostics / hover / navigation / completion 改从 `getScope` 取逻辑树与
     merged index；诊断只上报 `sourceFile === 当前文件` 的节点；
   - 引用解析 / 补全 / Define 查询支持 `idx.local` 优先；
   - Poid 属性：`AttachModuleId` / `ModuleId` / `UpdateModuleId` 等可在最近
     GameObject 子树内补全、hover、跳转；未命中**不新增诊断**（保守，避免
     “武器引用另一 GameObject 模块”这类跨文件语义误报）；
   - 导航对当前未保存文件优先用编辑器文本定位，再回退磁盘 DOM。

### 验证

- 单元测试 **92 → 98 全绿**：
  - `localScope.test.mjs`：未进流文件 overlay（自身资产 / Define / instance
    include 链）、inheritFrom 局部解析、xi:include 展开后模块上下文类型、
    Poid 引用找到 include 进来的兄弟模块、局部定义优先于全局同名定义、
    xi:include 环终止；
  - `completion.test.mjs`：Poid 属性只补全所在 GameObject 子树内的 id。
- `tsc` / `esbuild` 构建通过（打包验证见版本发布步骤）。

### 边界与后续

- 顶层 `<Include type="all">` 仍**不**并入逻辑树：它通常是独立整文件或大体积
  w3x，展开收益与风险不成比例；如需要“当前文档视角的全量合并诊断”再单独做。
- `AttachModuleId` 若出现在独立 `WeaponTemplate`（不在 GameObject 子树内），
  本轮仍不解析；等真实样本确认跨文件语义后再扩展。
- 未命中 Poid 不报诊断是刻意保守，后续可加配置项开启。

版本 **0.1.7 → 0.1.8**。

### 补充：构建期局部作用域闸门（2026-08-04）

用户清空缓存后在 Corona 上测得 phase A **101.2s** / 完成 **254.6s**，明显高于
第十一轮冷建基线（phase A 约 24s / 总约 118s）。代码审查确认 T1 没有改动 indexer
的构建路径（`localScope` / `logicalTree` 不参与 `build()`），但自动诊断在构建中
会触发 `getScope()`，可能和 indexer 抢磁盘 / CPU。

修复：`getScope()` 在 `building === true` 时返回 **parse-only 轻量 scope**
（只解析当前文件，不沿 include 链读盘、不展开逻辑树）；构建完全结束后再刷新
全量局部 scope。这样首建期间诊断 / 补全仍可用，但不会拖慢索引。索引报告与
输出通道同步增加 `walk / candidates / art` 耗时分解，便于下次直接定位慢在哪一段。

版本 **0.1.8 → 0.1.9**。

---

## 十八、问题分析（第十三轮，2026-08-04）：bit-flag 列表补全的三层问题

### 现象

对 `xs:list` 枚举（bit flag，如 `CreateObject@Disposition`、
`LocomotorTemplate@Surfaces`）：

1. 刚打开引号时（`Disposition="`）能补全；
2. 输入第一项后再输入空格，**不触发**补全；
3. 已经闭合的 `Disposition="RANDOM_FORCE RELATIVE_ANGLE"` 想在中间插入或末尾
   追加 flag，**不触发**补全。

### 根因（三个独立问题）

**1. 空格没有注册为补全触发字符**

`extension.ts` 注册 provider 时只传了 `< " = : . /`。VS Code 只在输入 word
字符或已注册触发字符时自动弹出补全；空格两者都不是，所以“打 flag → 空格”
永远不会自动弹出。刚打开引号能补全正是因为 `"` 已注册。

**2. 多行未闭合引号下，解析恢复丢失后续行属性**

解析器对未闭合开始标签的恢复策略是“截到第一个换行”（`xmlParser.ts`），因此
像用户示例这样属性逐行书写的标签，`<CreateObject` 之后各行的 `Options` /
`Disposition` 全部丢失，`startTagEnd` 停在 `<CreateObject` 行尾。光标在后续
行时 `analyzeContext` 走 `content` 分支——实测 `kind: content, attrs: []`。
也就是说，**按用户贴出的原文状态，当前代码其实并不会补全 Disposition**；
观察到“能补全”的编辑状态里引号/`>` 多半已闭合。另外恢复分支没有把恢复出的
元素挂到父元素下（`parent = null`），即使补上上下文分析，类型解析也会退回
全局映射（`CreateObject` → `GameObjectWeakRef`）而找不到 `Disposition`。

**3. 闭合引号内“插入/追加 flag”的体验与范围问题**

- 光标在完整值末尾（`...RELATIVE_ANGLE|"`）时，当前 token 恰好等于完整枚举
  值，`startsWith` 过滤只剩它自己 → 看起来“没有补全”；
- 替换范围 bug：引号闭合时 `endOffset` 固定取整个值的末尾而不是光标位置。
  实测光标在 `RANDOM_FORCE | RELATIVE_ANGLE` 中间时 range 为 `(28..42)`，
  选中任意 flag 会删掉 `RELATIVE_ANGLE` 及之后的内容；
- 光标恰好贴在闭合引号后面（`"|`）时，`offset <= quoteEnd` 把引号算进
  prefix（`RELATIVE_ANGLE"`），返回 0 项。

### 修复

1. **触发字符**：`registerCompletionItemProvider` 增加 `" "`（空格）。副作用：
   属性之间按空格会弹属性名补全（加分项），文本内容按空格会弹子元素补全。
2. **多行未闭合标签的补全**：
   - 解析器给恢复出的元素打 `recoveredStartTag` 标记，并**补挂父链**
     （与正常分支一致，`parent.children.push` + `el.parent = parent`）；
   - `analyzeContext` 在光标越过 `startTagEnd` 且元素带标记时，把
     `text.slice(tagStart, cursor)` 作为部分标签重新 `parseTag` 一次，
     再走同一套 start-tag 分类。全局解析恢复策略不变，后续文档解析/诊断
     不受影响。
   - 引号判定从 `offset <= quoteEnd` 改为 `offset < quoteEnd`：光标在闭合
     引号之后进入 attribute-name 上下文。
3. **list 补全范围与过滤**（`completion.ts`）：
   - list 值替换范围改为 `min(cursor, valueEnd)`，只覆盖当前段；非 list
     保持整值替换；
   - 排除列表中已出现的 flag（空格后只推荐剩余项）；
   - 追加模式：当前段已是完整枚举值且没有其它枚举以它为前缀时，给出零宽
     range、`insertText = " FLAG"`，可直接在闭合值末尾/列表中间追加；
     前缀保护是必要的——实测 820 个 list 枚举里有 10569 对严格前缀关系
     （如 `CAN_ATTACK` → `CAN_ATTACK_WALLS`）。

### 举一反三的测试（98 → 107 全绿）

- `xmlParser.test.mjs`：恢复元素带 `recoveredStartTag` 标记、正常元素不带；
- `context.test.mjs`：用户示例的多行未闭合引号（`Disposition="`）仍为
  attribute-value 且 prefix 正确；输入 flag + 空格后 prefix 含完整值；闭合
  引号之后为 attribute-name；
- `completion.test.mjs`：
  - 空格后只推荐未使用的 flag（10 项，不含 GROUND），range 零宽在光标处；
  - 列表中间插入不会删掉尾部 flag（range 止于光标）；
  - 闭合值末尾完整 flag → 追加模式（`insertText: " WATER"`）；
  - `CAN_ATTACK` 有更长变体时保持前缀过滤，不进入追加模式；
  - 多行未闭合 `Disposition="RANDOM_FORCE ` 经完整 provider 链路返回剩余
    flag（不含 RANDOM_FORCE）。

版本 **0.1.9 → 0.1.10**。

---

## 十九、问题分析（第十四轮，2026-08-04）：属性补全的插入体验

### 现象

写完一个属性值并关闭引号后，会立刻触发下一个属性的补全菜单（由 `"` 触发字符
带来，方便）。但按 Enter 接受补全时不会补空格，结果属性与上一个属性的闭合
引号贴在一起：

```xml
Disposition="RANDOM_FORCE RELATIVE_ANGLE"Count="$1"
```

连续接受会变成 `...RELATIVE_ANGLE"Count="$1"CreateFX="$1"DestinationPlayer="$1"`。

另外提出两个功能请求：

1. 新属性自动参考临近属性的缩进（很多 XML 的属性统一换行缩进）；
2. 补全的 `$1` 占位符在允许时变成更有意义的值（数字 → 数字、角度 → 角度、
   时间 → 时间），顺带提示值的格式。

### 修复

**1. 插入布局（`completion.ts` 新增 `attributeInsertLayout`）**

- 光标紧贴上一个属性的闭合引号时，插入文本前补一个空格（inline 布局）；
- 临近属性是“一行一个”布局（相邻属性之间的原文含换行）时，插入
  `\n + 上一个属性的缩进`；
- 用户已经回车换行时，用临近缩进替换当前行已有的空白（对齐）；
- inline 风格的文件里用户手动换行，则保留用户自己打的缩进，不强改；
- `xai:joinAction` / `xmlns:xai` 辅助项同样享受前缀与触发。

**2. 类型化默认值（`completion.ts` 新增 `attributeValuePlaceholder`）**

- 引用 / 枚举 / list / 布尔 / `inheritFrom` / `Include@source` / `id` 保留
  `$1` 占位并自动触发值补全（这些值靠候选选择，不能瞎猜）；
- 标量属性优先用 XSD `default`（如 `Count="1"`），没有默认值时按类型给示例：
  `Angle → 0d`、`Time → 0s`、`Percentage → 100%`、`Velocity → 0.0`、
  `SageReal/float → 0.0`、`SageInt/unsigned → 0`；
- 填了具体默认值后不再弹空的 suggest 窗口；`allowsDefine` 的数值属性现在也
  直接给数值示例（`$DEFINE` 仍可在值内手动触发补全）。

### 举一反三的测试（107 → 111 全绿）

- 闭合引号后接受属性 → ` Count="1"`（空格），range 零宽在光标处；
- 一行一个属性 → `\n      Count="1"`（换行 + 缩进）；
- 已在新行 → range 覆盖当前行空白，插入 `      Count="1"` 对齐；
- 标量默认值：`Count="1"`（XSD 默认）、`FadeTime="0s"`、`DispositionAngle="0d"`；
- 建议类属性：`CreateFX="$1"`、`Options="$1"`、`DisabledWhileBusy="$1"` 均带
  trigger 命令；具体默认值不带。

版本 **0.1.10 → 0.1.11**。

---

## 二十、问题分析（第十五轮，2026-08-04）：属性补全的缩进叠加与 `$1` 占位符

### 现象

连续接受属性补全时，缩进不是稳定对齐，而是逐行递增。用户分步实测（0.1.12）：

- 关闭引号 → 属性候选菜单 → 直接 Enter：第一次补全 `Count="1"` 就落在
  6 个 Tab（`Disposition` 是 3 个 Tab）；
- 按空格再次触发 → Enter：`CreateFX="$1"` 落在 9 个 Tab；
- 再 Enter（CreateFX 带触发命令，菜单自动重开）：`DestinationPlayer="$1"`
  落在 12 个 Tab。

```xml
		<CreateObject
			Options="IGNORE_ALL_OBJECTS"
			Disposition="RANDOM_FORCE RELATIVE_ANGLE ABSOLUTE_ANGLE"
						Count="1"
									CreateFX="$1"
												DestinationPlayer="$1"
```

### 根因

VS Code 在插入**含换行的补全文本**时，会给新行套用当前行的基础缩进，并与
补全文本里嵌入的缩进**相加**（而不是替换）：

```text
我们插入 \n + 3 Tab → 落盘 = 当前行 3 Tab + 我们 3 Tab = 6 Tab
下一行：当前行 6 Tab + 我们 3 Tab = 9 Tab
再下一行：9 + 3 = 12 Tab
```

与实测的 6 / 9 / 12 完全一致。关键证据是**第一次补全就已多缩进**：0.1.12
第一次只插入 `\n` + 3 个 Tab（锚点是首个独占一行的 `Options`），落盘却是
6 个——问题不在我们读取了谁的缩进，而在于补全文本自带的缩进被编辑器叠加。

排查过程中还发现一个放大因素并已修复：`attributeInsertLayout` 原先以
“最后一个被解析出的属性”为锚点，用户在自动缩进的新行上输入的半截属性名
（`C`、`D`…，`hasValue = false`）也会被当成锚点，把编辑器自动缩进抄进补全
行；即使叠加根因修掉，这个因素也会让缩进更容易跑偏。

### 修复（0.1.13）

1. **换行时只插入 `\n`，不再嵌入缩进**：编辑器自动补当前行的基础缩进
   （3 Tab），叠加量为 0，后续行稳定在 3 Tab；已在新行时仍显式替换为规范
   缩进（该路径不插入换行，不受叠加影响）。
2. **锚点只用完整属性**（`hasValue` 为真），并优先取**第一个独占一行的完整
   属性**作为规范缩进；半截属性名不参与缩进计算，整行内联时才回退到最后一个
   完整属性。
3. **`$1` 改为真正的 snippet 占位符**：属性名补全统一用 `SnippetString`，
   文档中不再出现字面 `$1`；接受补全后光标落在引号内的占位处，弹出的也是值
   补全菜单。`Count="1"` 这类具体默认值同样用 snippet（无占位符，光标落在
   闭合引号后）。
4. **尾随空格**：插入换行时，若上一个属性与光标之间只有空白（例如为触发补全
   按的空格），把这段空白一并纳入替换范围，不再残留尾随空格。
5. **调试日志**：`ModWorkspace.log()` 输出到 “RA3 Mod XML” 输出通道；
   attribute-name 补全每次记录 `existing / range / prefix`（JSON 转义），用于
   对比“我们插入的内容”与“落盘的内容”，定位编辑器侧改写。

### 测试环境说明

当前单测（node + vscode stub）**不能复现 VS Code 的 suggest 弹窗、snippet
缩进与 auto-indent 行为**，这类问题只能靠实机 + 输出通道日志确认。后续若要
自动化，需要引入 `@vscode/test-electron` 做扩展宿主集成测试（本期未做，记录
为候选）。

### 测试（111 → 113 全绿）

- 新行上输入半截属性名（行缩进 20 个空格）→ 补全仍用规范缩进，range 覆盖
  整段自动缩进与已输入字符；
- 为触发补全按的空格被新行替换吞掉，不再残留尾随空格；
- 属性名补全断言改为 `insertText.value`（SnippetString），换行插入断言为
  `\nCount="1"`（缩进由编辑器提供）。

版本 **0.1.11 → 0.1.13**（0.1.12 为中间版本，仅含锚点与尾随空格修复，
未解决叠加；0.1.13 为最终修复）。

---

## 二十一、问题分析（第十六轮，2026-08-04）：元素文本内容（simple content）引用与 `<<` 补全

### 现象

用户样例（`ObjectCreationList` → `CreateObject` 内输入 `<`）：

1. 补全菜单出现 `CreateObject`，接受后变成 `<<CreateObject />`——两个尖括号
   非法 XML；
2. 嵌套 `<CreateObject>` 被补全成自闭合 `<CreateObject />`，无法在标签内填
   单位的 id；正确写法应是 `<CreateObject>CrateDebris_01</CreateObject>`
   （原版 `SageXml\GlobalData\ObjectCreationLists.xml` 与 AttachTest
   `ObjectCreationList.xml` 均为此形态）；
3. 手动改成 `<CreateObject>C</CreateObject>` 后，内容区不出现 C 开头的
   GameObject id 补全；
4. 对 `<CreateObject>CrateDebris_01</CreateObject>` 的文本 hover 与
   Ctrl+点击导航均无效。

### 根因（三个独立缺陷叠加）

**A. 内容区补全没有处理“用户已输入 `<`”**

`<` 是补全触发字符（`extension.ts`）。`completion.ts` 的 `contentItems`
返回子元素候选时既不设置 `range`，`insertText` 又是完整的 `<Name…>`，VS Code
就把完整标签**追加**在已输入的 `<` 后面 → `<<Name />`。影响所有内容区子元素
补全（`Offset`、`RequiredUpgrade` 等同样中招），不只 `CreateObject`。

**B. `elementSnippet` 不知道“simple type 元素要填文本”**

XSD 中 `CreateObjectNugget` 明确声明
`<xs:element name="CreateObject" type="GameObjectWeakRef"/>`；`GameObjectWeakRef`
是 simple type，标签内容是 GameObject id。`elementSnippet` 只区分顶层 / 有子
元素的复杂类型 / 其他，simple type 落入 `<Name />` 分支，于是生成了永远填不了
值的自闭合标签。

**C. 所有 feature 都只认属性值，不认元素文本内容**

- `contentItems` 对 simple type 元素查“子元素列表”得到空 → 内容区无补全；
- `hover` 只检查属性名/属性值/元素名，文本区间不返回任何结果；
- `provideDefinition` 找不到属性直接 `return null`；
- `checkValueReferences` 只对属性做未解析引用检查；
- Find All References 的正则只匹配 `["']id["']`。

### 类似情况盘点（模型统计）

XSD 模型中共 **371 处“子元素是 simple type”的声明（149 个不同元素名）**：

| 类别 | 数量 | 例子 |
|---|---|---|
| 带 `xas:refType` 的引用内容 | 291 | `CreateObject`→GameObject、`RequiredUpgrade`/`ForbiddenUpgrade`→UpgradeTemplate、`SpawnTemplate`→GameObject、`Filename`→AudioFile、`RequiredObject`→GameObject |
| 无类型 `AssetReference`（isRef 无 refType） | 9 | `FXShaderConstantTexture@Value`、`RenderSubObjectReference@Mesh/CollisionBox` |
| 枚举内容 | 22 | `SourceMustNotHaveBeenDisabledThisFrameByType` 等 |
| 允许 `$DEFINE` 的内容 | 22 | 各类数值内容 |
| 普通字符串 | 27 | `DisplayName` 等 |

关键取证：`FXShaderConstantTexture@Value` 在真实 XML 里填的是**贴图名、数值、
布尔**（如 `AUMCV`、`1.000000`、`false`），`RenderSubObjectReference@Mesh`
在 w3x 里填的是**同一模型文件内的子对象名**——它们虽然被 XSD 标成
`AssetReference`（isRef），却不是全局资产 ID。因此**只有带 refType 的 simple
内容**才按全局引用处理；无类型 `AssetReference` 与 `Poid` 一律不参与全局
补全 / hover / 跳转 / 诊断，避免误报。

### 修复

1. **内容区 `<` 处理**（`completion.ts`）：`contentChildItems` 检测光标前是否
   已有 `<`（可带半截名字），有则把替换范围起点设为该 `<`，接受完整
   `<Name…>` 片段时是“替换”而非“追加”，从根上消灭 `<<`；`</` 输入不触发子元素
   补全。
2. **simple type 元素片段**：`elementSnippet` 对 simple type 返回
   `<Name>$1</Name>`（带占位符），引用/枚举/define 内容在插入后自动弹值补全
   （`editor.action.triggerSuggest`）。
3. **内容值补全**：`contentItems` 增加 simple-content 分支——元素自身类型是
   simple 时按“值”补全：refType 资产 ID（严格按类型过滤）、枚举、`$DEFINE`；
   替换范围只覆盖当前文本 token（`xmlParser.textContentTokenAt`）。
4. **引用层纯函数**（`refs.ts`）：新增 `isReferenceContentType(typeName)`
   （simple + refType + 排除 Poid）与 `resolveContentReferenceTargets(...)`，
   复用属性引用的类型过滤/评分逻辑。
5. **hover / 定义跳转 / 诊断 / Find All References**：均增加元素文本 token
   分支；Find All References 的搜索模式扩展为同时匹配属性值（`"id"`）与
   内容引用（`>id<`），并把结果范围裁剪到 id 本身。

### 举一反三的测试（113 → 121 全绿）

- `xmlParser.test.mjs`：`textContentTokenAt` 返回内容 token、边界与空白内容
  返回 null；
- `refs.test.mjs`：`GameObjectWeakRef` 内容只解析到 GameObject（同名
  WeaponTemplate 排除）；`AssetReference` / `Poid` / `string` 不是全局内容
  引用；
- `completion.test.mjs`：用户原始场景——`<` 后接受 CreateObject 的 range 覆盖
  `<`、`insertText` 为 `<CreateObject>$1</CreateObject>`、应用后不含 `<<`；
  `<CreateObject>C</CreateObject>` 内只补 C 开头的 GameObject（类型过滤 +
  token range）；
- `contentFeatures.test.mjs`（新增）：hover 显示内容引用定义、Ctrl+点击跳到
  同文件精确定位、诊断只报“带 refType 的内容引用”且不误报 WeakReference
  内容。

版本 **0.1.13 → 0.1.14**。

### 补充（0.1.14 实机回归，2026-08-04）：真实文件里 `<` 后仍有闭合标签

单元测试最初只覆盖了“文件在 `<` 处结束”的形态，用户实机复测时 `<` 后面还有
`</CreateObject>`，`<<` 依然出现（这次是 `<<Tag>（光标在中间）</Tag>`）。

**第二层根因**：解析器的 `findTagEnd` 扫描残缺开始标签时会一直找到**后面闭合
标签的 `>`**，把它当成这个开始标签的结束，于是生成一个空名/半截名的伪元素
（如 name 为 `""` 或 `"Cr"`）。光标落在该伪元素的 start tag 内 → 补全走
`element-name` 分支，而该分支的替换范围只从 `<` **之后**开始，插入完整的
`<Name>…</Name>` 片段就变成 `<<Name>`。

**修复**（两层）：

1. `findTagEnd` 在引号外遇到 `<`（在找到 `>` 之前）直接视为“未闭合开始标签”，
   走原有的行尾恢复路径：`<` 单独出现时不再产生伪元素，内容区保持 content
   上下文；`<Cr` 半截名则恢复为 `recoveredStartTag` 元素壳，仍由内容分支补全
   （该分支的 range 已包含 `<`）。
2. `elementNameItems` 的替换范围改为从元素 `start`（即 `<`）开始，即使后续
   解析仍产生伪元素，也不会再 `<<`。

测试补 121 → 125：`<` 后跟闭合标签不吞掉闭合标签、半截名恢复为元素壳、真实
文件形态（`<` 后有多行属性与闭合标签）接受 CreateObject 后不含 `<<`、半截名
`<Cr` 同样不含 `<<`。

### 补充 2（0.1.14 实机回归）：`<<` 修掉后补全菜单反而消失

把 `<` 纳入替换范围后，单测直接调用 provider 全部通过，但 VS Code 实机里
`<` 后**不再弹出任何补全**；`<CreateObject>C`（尚未输入闭合标签）也不触发，
必须补上 `</CreateObject>` 才有候选。

**根因**：VS Code 用“替换范围内的文本”作为过滤前缀。范围包含 `<` 时，前缀
就是 `<`，所有标签名都不匹配 → 菜单为空；范围为零宽且元素未闭合时，
`textContentTokenAt` 因 `closeTagStart < 0` 返回 null，range 落在光标处、
没有覆盖已输入的 `C`，同样过滤不到。

**修复**（回到标准补全模式）：

1. **已输入的 `<` 保留，不放进替换范围**：`contentChildItems` /
   `elementNameItems` 的 range 从 `<` **之后**开始，插入文本**不再带开括号**
   （`CreateObject>$1</CreateObject>`），应用结果仍是单个 `<`；没有输入 `<`
   （Ctrl+Space 内容补全）时才插入完整 `<Name>…</Name>`。这样过滤前缀是
   `""` / `Cr`，菜单正常显示。
2. **未闭合元素也能提取内容 token**：`textContentTokenAt` 在
   `closeTagStart < 0` 时用 `el.end` 作为内容边界，`<CreateObject>C`（EOF）
   也能覆盖已输入的 `C` 并给出前缀过滤。

测试 125 → 128：三个真实形态（孤立 `<`、`<Cr` 半截名、未闭合
`<CreateObject>C`）均断言插入文本不带开括号、range 覆盖正确文本、应用结果
无 `<<`，并新增“未输入 `<` 时插入完整标签”用例。

---

## 二十二、问题分析（第十七轮，2026-08-04）：simple-content 补全变成属性补全；大列表截断后 CrateDebris 消失

### 现象

1. 接受 `<CreateObject>$1</CreateObject>` 片段后，弹出的不是 GameObject id
   补全，而是 `xai:joinAction` 与 `xmlns:xai` 两个属性名候选；
2. 不接受这两个候选，直接在标签间输入 `C`：菜单要等较久才出现，且包含大量
   C 开头的候选，但 **CrateDebris_01 不在其中**；继续输入 `r` / `D` / `e` /
   `b` / `r` 后候选反而越来越少直至消失；
3. 快速输入 `Cr`（不等第一次菜单）则 CrateDebris_01 正常出现。

### 根因（两个独立问题）

**A. `>` 之后的零宽光标被当成“还在 start tag 内”**

`analyzeContext` 原来用 `offset <= startTagEnd` 判定光标在开始标签内。补全
片段 `<CreateObject>$1</CreateObject>` 接受后，`$1` 恰好落在
`startTagEnd`（`>` 后一格）这个零宽位置，于是被分到 `attribute-name`，
返回的自然是 `xai:joinAction` / `xmlns:xai`。

同类边界还有：已闭合元素的 `end` 之前也用了 `<=`，导致光标刚越过
`</CreateObject>` 时仍被当作“在子元素内容里”，而不是父元素的内容区。

**B. 引用列表超过 400 条后被硬截断，且没有告诉 VS Code“列表不完整”**

`assetIdItems` 对匹配到的 id 排序后直接 `slice(0, 400)`。VS Code 收到列表后
会在客户端按已输入的字符继续过滤这 400 条，**不会再次调用 provider**。
于是：

- 输入 `C` 时 CrateDebris_01 若排在 400 名之后，它从一开始就不在列表里；
- 继续输入 `r` 只是在这 400 条里过滤，CrateDebris_01 永远不会出现；
- 快速输入 `Cr` 时第一次请求的前缀已经是 `Cr`，匹配数小于 400，所以能看到。

`includeSourceItems` 还有一个变体：先 `slice(0, 400)` 再排序，同样可能把
真正优先级高的候选切掉；`defineItems` / `localIdItems` 也有同类截断隐患。

### 修复

1. **开始标签边界语义修正**（`context.ts` / `xmlParser.ts`）：
   - `>` 之后（`offset === startTagEnd`）一律视为内容区，只有 `>` 尚未输入
     的残缺开始标签仍保持 `attribute-name`；
   - 新增 `elementContainsOffset`：已闭合 / 自闭合元素的 `end` 为开区间，
     光标在 `</Child>` 之后回到父元素内容；未闭合元素在 EOF 仍算在元素内。
2. **大列表标记 incomplete**（`completion.ts`）：`assetIdItems`、
   `includeSourceItems`、`defineItems`、`localIdItems` 一旦超过 400 条就返回
   `CompletionList(..., isIncomplete: true)`。VS Code 会在用户继续输入时重新
   请求 provider，窄前缀下 CrateDebris_01 这类“前 400 之外”的 id 不再丢失。
3. **局部优先 + 避免全量排序**：当前文档局部 overlay 的资产（`stream:
   "local"`）在评分中额外降 0.4，先于全局项目候选；`topScoredDefs` 用
   大小堆只保留前 400，不再对全部匹配 id 做 `sort`，降低大项目首键延迟。
4. **Include source 先排序再截断**：修掉“先 slice 后 sort”的顺序问题。

### 类似情况盘点

- 任何带 refType 的属性值 / `inheritFrom` / simple-content 引用，只要匹配数
  超过 400，都存在“越输越少但目标永不出现”的风险——本轮统一用 incomplete
  解决；
- 光标紧贴 `>` 后的零宽位置（简单元素片段 `$1`）与紧贴 `</Child>` 后的位置
  是同一类“边界误归属”，本轮一并修掉；
- `Include@source` 的“先截断后排序”是同一家族 bug，已修复。

### 举一反三的测试（128 → 136 全绿）

- `context.test.mjs`：`>` 后且有闭合标签 → content；`>` 后但闭合标签尚未
  输入 → content；`</Child>` 之后 → 父元素 content；
- `xmlParser.test.mjs`：已闭合 / 自闭合元素的 `end` 为开区间；未闭合元素
  EOF 仍属于该元素；
- `completion.test.mjs`：simple-content 片段 `$1` 位置返回值补全而不是
  `xai:joinAction` / `xmlns:xai`；450+ 候选时返回 incomplete 列表，窄前缀
  重请求后找到 CrateDebris_01；当前文件 local overlay 资产即使总数超过
  400 也保留在前 400。

版本 **0.1.14 → 0.1.15**。

### 遗留

若 Corona 上“输入 C 后菜单出现慢”仍然明显，下一个瓶颈大概率是
`getScope()` 每次文档版本变化都重建完整局部 include 链 / 逻辑树；本轮先把
候选截断与类型过滤造成的“列表错误”修掉，局部 scope 缓存优化留作独立一轮。

---

## 二十三、问题分析（2026-08-05）：FAR 把定义行算作“自引用”；CodeLens 漏掉 manifest 源引用

### 问题 1：Find All References 把 id 定义行也算进结果

**现象**：对任意资产执行 FAR，结果里包含它自己的 `id="..."` 定义行，看起来
像“自己引用自己”；CodeLens 计数没有这个问题。

**根因**：VS Code 的 FAR 默认带 `context.includeDeclaration = true`，旧实现
把定义位置附加进返回结果。语义反向索引本身不含 id 定义点（records 提取时
已排除），CodeLens 只读反向索引，所以两者不一致。

**修复**：`findReferenceLocations` 不再附加定义位置，无论 `includeDeclaration`
取值；FAR 结果与 CodeLens 计数严格一致。

### 问题 2：CodeLens 不显示 manifest 定义的引用，FAR 却显示

**现象**：打开 SageXml 原版源码时，CodeLens 显示 0 引用，但从该资产执行
FAR 能看到引用。

**根因**：反向索引的站点挂在“实际解析到的定义”上。当 SageXml 源码不在
include 遍历里时，引用只解析到 manifest 定义（如 `static.manifest` 条目），
站点挂在 manifest key；CodeLens 用“当前文档定义 key”精确查表所以是 0，
FAR 把同 id/同类型的 manifest 定义也合并进来所以能看到。

**修复**：新增 `referenceSitesForDefinition`：除了精确 key，还把
`manifestSource` 可解析到当前打开文件的 manifest 定义的站点并入计数——
语义上把“manifest 引用”视作“SageXml 源码对该 asset 的引用”
（Go to Definition 本来就会把 manifest 定义映射到 SageXml 源码）。

**验证**：AttachTest 中 326 个带引用的 manifest 定义此前全部没有对应
`origin: "sdk"` 定义（源码未遍历），现在打开对应 SageXml 源码即可看到计数
（如 `PlayerTemplate Allies` → 8 引用）。

### 举一反三的测试（146 → 147 全绿）

- `referenceProvider.test.mjs`：FAR 即使 `includeDeclaration = true` 也不返回
  定义行；从引用位置发起 FAR 结果一致；
- `referenceIndex.test.mjs`：`referenceSitesForDefinition` 把 manifest 源
  站点并入 SageXml 源码定义，其他文件不串；
- `codeLens.test.mjs`：打开 manifestSource 对应的源码文件时，CodeLens 显示
  manifest 定义上挂着的引用数。

版本 **0.1.16 → 0.1.17**。

---

## 二十四、问题分析（2026-08-06）：引用索引与 records 缓存不同步 / 竞争

### 现象

Corona `Data/GlobalData/Weapon/Weapon_Allied.xml` 中的
`AlliedCommandoDesertEaglesWarhead`（一个 WeaponTemplate）偶尔没有 CodeLens，
FAR 显示无引用；它实际被同文件 WeaponTemplate 的 `ProjectileNugget
WarheadTemplate="..."` 引用。该问题在移动硬盘重连 + 重新打开工作区 + 校验
磁盘缓存 + 重新 indexing 之后出现；在 ProjectileNugget 里 Ctrl+点击一次后恢复；
清缓存重载不复发。

### 调查

1. **模型核对**：`AlliedCommandoDesertEaglesWarhead` 的元素是
   `<WeaponTemplate>`，`ProjectileNuggetType@WarheadTemplate` 的 refType 是
   `WeaponTemplate`，语义匹配成立。
2. **真实文件验证**：直接对 Weapon_Allied.xml 做 records 提取 + 反向索引，
   引用记录（line 1332）能正确挂到定义（line 1341）——**新鲜构建没有问题**。
3. 因此问题不在提取/过滤逻辑，而在“引用索引与索引状态不同步”的缓存/竞争
   路径。

### 找到的不同步 / 竞争点

- **`buildReferences()` 读共享 recordsCache**（workspace 持有、跨重建复用），
  而不是 walk 实际消费的 records：
  - 外部盘重连 / 旧磁盘缓存条目“stat 全匹配但内容过时”（FAT32/exFAT 时间戳
    粒度 2s、同步工具保留 mtime、size 不变）→ 资产用旧 records 入库，而新
    引用缺失；watcher 事件在重连期间丢失时快照不会标 stale → 持久化问题；
  - 构建中途 watcher 失效、或 feature `readDom` 重写 recordsCache，都可能让
    快照的 references 与 assets 来自不同版本的 records。
- **feature 在构建中调用 `readDom`**（定义跳转的精确定位）会改写同一个
  indexer 的 `files` / `recordsCache`，污染进行中的构建。
- **force 重建（Re-index）之前只比 stat 信号**：stat 相同但内容不同的陈旧
  条目会被直接复用，只有清缓存才能修复。

### 修复

1. **构建期本地 records**：`ModIndexer.buildRecords` 记录本次 walk 实际消费的
   `{ file, records, recordsHash }`，`buildReferences()` 只从这里构建反向索引。
   中途失效 / feature 重读不再造成“资产在但引用缺失”。
2. **构建期 readDom 闸门**：`assetDefLocation` 在 `ws.isBuilding` 时退化为
   行级位置，避免定义跳转改写进行中的构建。
3. **force 重建内容校验**：full XML 的 records 缓存条目带 `contentHash`；
   `Re-index workspace` 对 stat 匹配的条目也读文件比对哈希，不一致才重解析
   （w3x 浅扫描不读，保持 2.6 GB 免读）。
4. **打开文档自愈**：快照发布每文件 `recordsHashes`；CodeLens / FAR 对**已保存**
   文档比较当前文本的 records 哈希，不一致则定向 `invalidate` +
   `scheduleRebuild("records-desync")`。records 哈希忽略行尾/空白差异，
   未保存编辑不触发，避免误报和循环。
5. **磁盘缓存 v2 → v3**：旧缓存没有哈希、无法校验/自愈，一次性重建后每文件
   都带哈希。

### 验证（147 → 151 全绿）

- 构建中途 invalidate 某文件的 recordsCache，最终快照仍保留该文件的引用；
- force 重建：stat 全匹配但 contentHash 不同的条目被重新解析（trusted 路径
  仍复用缓存不读盘）；
- 自愈：records 哈希不一致时只对干净文件触发 invalidate + records-desync；
- CodeLens 集成：打开文档与快照不同步时调度定向重建。

“Ctrl+点击后恢复”的精确时序无法在代码里复现；最可能是跳转前后恰好发生了一
次重建（watcher 事件 / dirty-followup）。自愈检查让这类问题不再依赖巧合：
只要文件被打开并触发 CodeLens / FAR，不一致就会被检测并定向修复。

版本 **0.1.17 → 0.1.18**。

---

## 二十五、问题分析（2026-08-07）：属性补全换行误判与补全项重复

### 现象

1. 属性名补全的“自动换行”在属性已经位于自己单独一行时仍会再插一个换行：
   例如在 one-per-line 标签中间插入新属性（光标行已有半截属性名，后面还有
   其他属性）时，接受补全会多出一个空行。正确规则是：只有“同一行上的第二个
   属性”才换行；光标已经在自己单独一行时不应换行。
2. 属性值补全出现两条完全相同的值，例如 `ProjectileNugget@WarheadTemplate`
   中 `AlliedCommandoDesertEaglesWarhead` 出现两遍。

### 根因

1. `attributeInsertLayout` 判断“是否已在新行”时用的是标签内**最后一个完整
   属性**的结束位置，而没考虑它是否位于光标之前。在 one-per-line 标签中间
   插入时，光标后面的属性会让 `alreadyOnNewLine` 误判为 false，于是再次插入
   `\n`。同理，在第一个属性之前的新行上补全也会因“面前没有完整属性”而误换行。
2. `assetIdItems` 只按 `(类型, id, 文件, 行)` 去重。同一个 ID 可以同时出现在
   当前文档局部 overlay（未保存文本的行号与磁盘不同）与全局索引中，也可以
   同时出现在项目 XML 与编译 manifest 中——不同文件/行号不会被去重，于是同一
   个值出现两条。

### 修复

1. **换行判定只看光标之前的属性**：`attributeInsertLayout` 先过滤出结束位置
   在光标之前的完整属性，再判断光标是否与它们同处一行；没有前置属性时，用
   元素名与光标之间是否有换行判断是否已在自己一行。已在新行时不再插入换行，
   one-per-line 风格下仍用规范缩进替换当前行空白；同一行第二个属性仍按原有
   规则换行；元素名同一行补首个属性时（文件为 one-per-line）仍保留换行行为。
2. **值补全按 id 去重**：`assetIdItems` 改为先按 `(类型, id, 文件, 行)` 去掉
   同一份定义，再按 id（大小写不敏感）合并为一个补全项，保留分数最高的定义
   （local > project > sdk/manifest），其余定义在文档说明中列出
   （“Also defined as …”）。`defineItems` 同步改为按 define 名去重，局部定义
   优先。

### 验证（169 → 173 全绿）

- one-per-line 标签中间插入：不再插入换行，range 覆盖当前行空白与半截属性名；
- 第一个属性之前的新行补全：不换行，按规范缩进对齐；
- 元素名同一行补首个属性（one-per-line 文件）：仍换行；
- 同一 ID 同时存在于局部 overlay / 全局索引 / manifest：只出现一个补全项，
  文档中列出其它定义位置。

版本 **0.1.19 → 0.1.20**。

---

## 二十六、问题分析（2026-08-08）：磁盘缓存校验阻塞与日志可观测性

### 现象

清缓存 / 冷启动时“validating cache”耗时很长，但输出通道只有构建开始和结束
两行，看不到校验花了多久；构建日志显示 `done in 1.6s`、索引已完整，但 VS Code
状态栏仍停留在“indexing”。

### 根因

1. `seedRecordsFromDisk` 在构建前 `await loadValidated()`，对全部 8,976 条缓存
   记录逐文件 stat（机械盘可达数十秒），且这段耗时没有任何日志；构建计时从
   `runBuild` 才开始，日志里自然看不到。
2. `publishIndex` 发布最终快照时 `state.building` 仍为 true，`updateStatusBar()`
   只会显示“indexing…”；`finally` 把 `building` 置 false 后没有再次刷新状态栏，
   于是状态栏一直停在 indexing。

### 修复

1. **校验仍是快速构建的前置条件**：`DiskRecordsCache` 拆为 `load()`（读 +
   gunzip + JSON，快）与 `validate()`（逐文件 stat）。冷启动**先校验后构建**：
   只有 stat 与当前磁盘一致的记录才播种进共享 recordsCache，过期条目在构建时
   重新读取。曾尝试“先快速构建、构建后后台校验”，但快速路径
   （`trustUnchanged=true`）会直接信任未校验的 recordsCache 条目，可能发布
   过期 index；后台校验只能事后发现 stat 可见的变化，stat 不可见变化（同
   size/mtime/ctime 的重写）无法事后发现。同时并发校验会与索引器抢机械盘
   I/O，实测把信任构建从 1.6s 拖到 25s（walk 17s / candidates 6.3s），因此
   该方案已放弃，恢复“校验通过才允许快速构建”的不变量。

   进一步优化为**分阶段校验**：full XML 记录先校验（约一半，~15s），构建随即
   开始并发布 phase A；shallow 美术记录先以 `validated:false` 预播种，phase A
   的 `readDocument` 只把它当“待扫描登记”用（不消费记录、不 stat 2.6GB 模型），
   在 phase A 发布回调里校验并标记 `validated:true`，phase B 直接命中缓存。
   结果：phase A 可用时间从 ~34s 降到 ~16s，最终完成时间基本不变，正确性不变。

2. **校验进度可视化**：`validate()` 增加 `onProgress` 回调，状态栏显示
   `validating cache N/M…` / `validating art cache N/M…`，输出通道每校验
   1000 条输出一行进度，避免长时间无反馈。
3. **日志补齐计时**：新增 `[disk-cache] loaded … in Xs`、
   `[disk-cache] validated … in Xs (dropped=N)`、`[disk-cache] saved … in Xs`
   以及 `[build] wall time …`（含缓存加载的总耗时）；`DiskCacheLoadStats`
   增加 `loadMs` / `validateMs`，cacheReport 与状态栏 tooltip 一并展示；
   输出通道所有日志行统一自动加本地 `HH:mm:ss.mmm` 时间戳，方便对照
   watcher / build / disk-cache 事件的先后顺序。
4. **状态栏修复**：`finally` 中 `building = false` 后调用 `updateStatusBar()`，
   构建完成后不再卡在 indexing；校验阶段状态栏直接显示
   `validating cache…` / `validating art cache…` 及计数。

### 验证（173 → 176 全绿）

- `load()` 不做 stat 校验，`validate()` 返回 `kept` / `invalidKeys` 与
  validated / dropped / validateMs 统计，`onProgress` 单调递增到总数；
- 变更 / 缺失条目被报告并触发重建，有效条目保留；
- 未校验的 shallow 条目在 phase A 只登记不消费，phase B stat 校验后命中缓存
  不再重扫；
- 全量 176 个测试通过，esbuild 产物已更新。

---

## 二十七、问题分析（2026-08-10）：CodeLens 与 FAR 定义合并路径不一致

### 现象

Corona 项目中 `WeaponTemplate` 不再显示 CodeLens 引用计数（或显示 0），但
右键菜单 Find All References 仍能查到引用。

### 根因

CodeLens 只查“全局 index 中当前文件这一条定义”的引用桶
（`referenceSitesForDefinition`），而 FAR 会把**当前文档的 local overlay** 与
全局同名定义合并后再收集引用（`definitionsForReference` +
`collectReferenceSites`）。当文件未进全局 include 流（standalone / 片段文件）
或定义只存在于 local overlay 时，FAR 能通过全局同名定义找到引用，CodeLens
却按本地文件 key 精确查表得到 0/空，表现就是“FAR 可用、CodeLens 消失”。

### 修复

1. `Ra3CodeLensProvider` 改为 async，通过 `ws.getCodeLensScope(document)` 取
   merged index（当前文档 local overlay + 全局 index），并用与 FAR 相同的
   `definitionsForReference` + `collectReferenceSites` 计算计数；
2. `showReferencesForDef`（点击 lens 打开的 references peek）同步改为同一
   逻辑，保证显示的数字与打开的 peek 严格一致；
3. CodeLens 的 records-desync 自愈改用 `recordsSyncSurfaceFor(document)`，
   与 FAR 一样按文档所属项目定向修复，而不是活动项目。

### 刷新体验与 0 显示

- CodeLens 使用轻量 `getCodeLensScope`（只解析当前文档 + 挂全局 index，不
  展开 include 链），快照发布后的 `editor.action.codeLens.refresh` 即时返回
  新计数；
- Provider 实现 `onDidChangeCodeLenses` 事件，`onIndexUpdate` 在每次快照
  发布时主动 fire，VS Code 立即重新查询（不依赖 refresh 命令是否生效）；
- **全局重试定时器**：`onBuildStart` 启动一个 2s 间隔的定时器，只要
  `ws.isBuilding()` 为 true 就重新 fire CodeLens 刷新；构建结束即停止。
  用于兜底 VS Code 对单次 refresh 事件的合并/延迟，保证 phase A 的计数
  不会等到 final 才上屏。定时器为全局单实例、仅构建期存在，不随文档数
  放大；
- 日志：每次快照发布记录 `[codelens] refresh (project/phase/assets/...)`；
  首个快照前每个文档只记一次 `[codelens] suppressed`；scope 异常和超过
  250ms 的慢 provider 调用也会记录。refresh 事件频率等于快照发布次数
  （低频），不会按每次 VS Code 查询记录，避免大项目刷屏；
- 在**第一个全局快照发布前**（`stats.indexedFiles === 0` 的本地-only index）
  不渲染任何 CodeLens，避免冷启动期间满屏误导性的 0 references；
- 一旦存在真实快照，“0 references”仍按设计显示（参考目标类型 0 也显示，
  点击可打开空 peek 作为“未引用”信号）。

### 重新评估（2026-08-10）

- **与 FAR 的一致性**：CodeLens 只渲染当前文档的顶层资产，cheap scope 的
  overlay 已覆盖这些资产；反向索引的引用站点挂在**每个匹配定义**上，因此
  当前文档定义 + 全局同名定义的并集与 FAR 的 full-scope 并集在计数上一致。
  仅存在于 include 链、且不在全局 index 中的定义没有反向引用桶，full scope
  也不会多出站点，故不构成计数差异。
- **0 显示语义**：按文档需求“参考目标类型 0 也显示”，隐藏逻辑收窄为
  “尚无全局快照”，避免小项目 phase A 后仍被隐藏。
- **已知边界**：CodeLens 计数与“从该 id 发起 FAR”完全一致，因此同名 id
  跨类型时会把各类型定义的反向站点合并计数——这是 FAR 既有语义，CodeLens
  与其保持一致，不再按类型收窄。

### 验证（175 → 178 全绿）

- CodeLens 与 FAR 共享定义合并路径后，standalone 文件中 WeaponTemplate
  的计数与 FAR 结果一致；
- 点击 lens 打开的 peek 与计数一致；
- 尚无全局快照时不渲染 CodeLens，快照存在后 0 references 仍显示；
- `onDidChangeCodeLenses` 在 refresh 时触发；测试 shim 不再提供
  `indexForDocument`/`activeIndex`，若实现回退到旧的 index 查找方式会直接
  测试失败；
- 原有 manifest 源引用归并、0 引用显示、desync 自愈测试全部保持。

---

## 二十八、问题分析（2026-08-10）：manifest 源地址被 mod 同名 DATA 路径遮蔽

### 现象

Corona `Data\Allied\Units\AlliedCommandoTech1.xml` 中
`Template="AlliedCommandoDesertEagles"` 的 Ctrl+点击有两个候选：

- mod 定义：正常；
- 原版 manifest 定义：`manifestSource` 是 `DATA:globaldata/weapon.xml`，
  但它没有跳到 `SageXml\globaldata\weapon.xml`，而是打开 mod 自己的
  `Data\globaldata\weapon.xml`（915 字节的 Include 汇总文件，不含该 id）。

### 根因

`manifestSource` 记录的是**原版 manifest 编译时该资产的源地址**，不是
“当前 mod 按 BAB Include 规则会命中哪个文件”。旧代码在
`src/features/navigation.ts` 的 `assetDefLocation()` 里用
`resolveSource(src, null, searchPathsFor(idx))` 解析它，而
`searchPathsFor(idx)` 是当前项目的 BAB 搜索顺序——项目 `Data` 在
`SageXml` 之前。于是只要 mod 同名遮蔽了 `DATA:globaldata/weapon.xml`，
manifest 候选就会被劫持到 mod 文件。

同一语义混淆也存在于 `src/indexer/referenceIndex.ts` 的
`referenceSitesForDefinition()`：它用当前项目搜索路径判断 manifest 定义
是否对应某个源码文件，同样会被遮蔽路径带偏。

### 实测证据

- `static.manifest` 中确有
  `WeaponTemplate:AlliedCommandoDesertEagles`，
  `sourceFileName = "DATA:globaldata/weapon.xml"`；
- `Data\globaldata\weapon.xml`（mod）与
  `SageXml\globaldata\weapon.xml`（原版）都存在，后者 277 KB，
  该 id 在第 1093 行；
- 当前 BAB 顺序解析返回 mod 文件；只按 `[SDK根, SDK\SageXml]` 解析则返回
  `SageXml\globaldata\weapon.xml`；
- 对 `static.manifest` 全部 DATA 源扫描：1874 个都存在于 `SageXml`，
  其中 172 个被 Corona `Data` 同名遮蔽。说明这是普遍现象，不是个别文件。

### 修复

1. `src/indexer/includeResolver.ts` 新增 `buildVanillaSearchPaths(sdkDir)`：
   DATA 只搜 `[SDK根, SDK\SageXml]`，ART / AUDIO 同理只搜 SDK 目录
   （当前 SDK 基本没有 art/audio 源码，保持“找不到就 manifest-only”）。
2. `src/features/navigation.ts` 的 manifest 定义跳转改用 vanilla-only 路径；
   普通 `<Include>` / `xi:include` 仍使用当前项目 BAB 顺序，不受影响。
3. `src/indexer/referenceIndex.ts` 的 manifest 源归并同步改用 vanilla-only
   路径，避免把 manifest 引用错误归并到 mod 同名文件。
4. 边界处理：
   - `SageXml` 源文件缺失（用户删除/改名）：manifest 候选保持
     manifest-only，不跳到 mod 遮蔽文件；
   - 源文件存在但 id 已被移除（用户修改 SageXml）：跳到该文件顶部，
     不做虚假的精确定位；
   - 只要 `SageXml` 中仍有该 id，就精确跳转（与既有问题 C 的行为一致）。
   - 当前实现不读取 `ra3modxml.indexSageXml`：manifest 导航始终尝试解析
     SageXml 源码（这只影响“跳到哪里”，不影响是否把 SageXml 纳入索引）；
     如需让导航也跟随该设置，可后续加开关。

### 测试（178 → 184 全绿）

- `includeResolver.test.mjs`：`buildVanillaSearchPaths` 结构断言；mod 同名
  遮蔽时普通 BAB 解析命中 mod、vanilla-only 命中 SageXml；vanilla 源缺失时
  即使 mod 遮蔽也返回 null；
- `referenceIndex.test.mjs`：manifest 源归并只命中 SageXml 文件，同名 mod
  文件不继承引用站点；
- `contentFeatures.test.mjs`：Ctrl+点击 manifest 定义命中 SageXml 而非 mod
  遮蔽文件；SageXml 源缺失时不跳 mod；文件存在但 id 被删时降到文件顶部。

> 备注：ART/AUDIO 源映射按用户意见不作为本轮目标；`buildVanillaSearchPaths`
> 已包含对应 SDK 目录，将来若有源码可直接复用。

---

## 二十九、问题分析（2026-08-11）：manifest 同名不同类型资产被 `assetsById` 去重丢弃

### 现象

Corona `Data\Allied\Units\AlliedMCV.xml` 的
`ScriptedModelDraw → ModelConditionState → Model Name="AUMCV_Hover"`
报 unresolved-reference：

```xml
<ScriptedModelDraw id="ModuleTag_Draw_Hover" OkToChangeModelColor="true">
  <ModelConditionState ParseCondStateType="PARSE_DEFAULT">
    <Model Name="AUMCV_Hover" />
  </ModelConditionState>
</ScriptedModelDraw>
```

提示为“没有类型为 `BaseRenderAssetType` 的定义（其他类型存在同名 id）”，
但 `Static.manifest` 中确实存在 `W3DContainer:AUMCV_HOVER`。

### 根因

`src/indexer/indexer.ts` 的 `addAsset()` 在维护两个索引时用了同一套去重：

- `assets`：`类型 -> id -> 定义`，按 `(file, line)` 去重；
- `assetsById`：`id -> 所有类型定义`，也按 `(file, line)` 去重。

XML 定义的行号各不相同，所以 `(file, line)` 足够；但 manifest 资产入库时
`line` 固定为 0，于是同一个 manifest 里 id 相同、类型不同的多个资产会被
当成同一条定义，只保留最先出现的类型。

`Static.manifest` 中 `AUMCV_HOVER` 的实际顺序是：

```text
W3DHierarchy:AUMCV_HOVER
W3DAnimation:AUMCV_HOVER
W3DContainer:AUMCV_HOVER
```

`W3DContainer` 因此被 `W3DHierarchy` 挤掉。`Model@Name` 的 `refType` 是
`BaseRenderAssetType`，`W3DHierarchy` 按 XSD 继承链不是渲染资产，所以
`assetsById` 里“有同名 id”但“没有匹配类型”，正好产生上述提示。

### 为什么以前没暴露 / 不是回归

第三轮修复的 `AUAntiVehicleVehicleTech1_SKN` 在 static.manifest 里只有一个
同名定义（`W3DContainer`），没有类型竞争，因此当时测不到该分支。git blame
显示 `addAsset` 的 `(file, line)` 去重从首个提交就存在，所以这是潜在缺陷被
新数据形态首次触发，不是近期改动造成的回归。

### 影响面（真实 manifest 扫描）

对 `Static / Global / Audio` 三个 manifest 模拟当前入库逻辑：

| 指标 | 数值 |
|---|---:|
| 同名 id 跨类型的 ID | 1318 |
| 被丢弃的类型定义 | 1470 |
| `W3DContainer` / `W3DMesh` 被丢弃的 id | 412 |

`Audio.manifest` 无此类碰撞。受影响的不止诊断和 hover：
`resolveReferenceTargetsForType`、语义 FAR / CodeLens 引用计数、未类型化补全
都经 `assetsById` 查找，因此 manifest 中的模型引用普遍可能误报或漏计。

### 修复

`assetsById` 是“按 id 汇总所有类型定义”的索引，去重身份必须包含类型：

1. `src/indexer/indexer.ts` 的 `addAsset()`：`assets` 与 `assetsById` 的去重
   都改为 `(type, file, line)`；
2. `src/indexer/localScope.ts` 的 `addAsset()`：同样的去重修正，避免局部
   overlay 未来遇到同构数据时重复踩坑。

`mergeLocalAndGlobalDefs`、`assetDefKey` 本来已按 `(type, id, file, line)`
区分定义，修复后三处语义一致。

### 测试（新增 1 个集成测试，全量 198 个通过）

`test/indexer.test.mjs` 新增自包含用例：

- 用最小 version-5 manifest 构造 `W3DHierarchy / W3DAnimation / W3DContainer`
  三个同 id 资产，顺序刻意让渲染类型排在最后；
- 再构造 `Texture:ABAirfield` 在前、`W3DContainer:ABAIRFIELD` 在后的常见形态；
- 断言 `assetsById` 保留全部类型；
- 断言 `Model@Name` 经 `resolveReferenceTargetsForType` 命中 `W3DContainer`；
- 断言反向引用索引把该引用记到 `W3DContainer` 名下。

### 文档同步

`docs/plan.md` 的 manifest 建模小节补充：`assetsById` 必须保留同 id 的不同
类型定义，去重身份为 `(type, file, line)`。

---

## 二十八、问题分析（2026-08-11）：xi:include 无 xpointer 语义与片段文件诊断（P0）

### 现象

`Data/Includes/GenericCelestialBuildingSuicide.xml` 这类被 `xi:include` 引用的
片段文件在独立打开时被报一串错误：`DieMuxData` 报 `missing-id`（“顶层资产需要
id”），wrapper 根不在 XSD 里的文件报 `unknown-element`，引用在完整索引下能解析
前还会报未解析引用。

### 根因

1. **无 `xpointer` 的展开语义错误**：`expandDocument` 把目标 `root.children`
   拼进父节点。按 XInclude 语义（也是 Corona 的实际用法），没有 `xpointer` 时应
   整体包含目标文档的根元素。`GenericCelestialBuildingSuicide.xml` 的根
   `CreateObjectDie` 本身就是要放进 GameObject 的模块；旧实现会丢掉它，只把
   `DieMuxData` 拼进去。
2. **诊断层把片段当完整文档**：`isTopLevel` 假定根一定是 `AssetDeclaration`，
   于是片段根的子元素被当成顶层资产要求 id；未知 wrapper 根也被当成未知元素。
3. **引用/define 与上下文耦合**：片段里的引用可能由 include 者（或 include 者
   的 include 链）提供，独立打开片段时无法可靠判定。

### 修复（P0，不猜测外部上下文）

1. `logicalTree.expandDocument`：无 `xpointer` 时 `handleChild(parse.root)`，
   整体包含目标根元素；有 `xpointer` 时保持 `/n:Name/child::*` 语义。
2. `diagnostics` 片段模式：根 localName 不是 `AssetDeclaration` 即为片段。
   - 一律跳过顶层 `missing-id` / 跨文件重复 id、未解析引用、未定义 `$DEFINE`；
   - 根是已知 XSD 元素时（如 `CreateObjectDie`），根自身提供类型上下文，整棵子树
     的未知元素 / 未知属性仍正常校验；
   - 根不在 XSD 中（wrapper/container，如 `CommonArmorDraws`）时，只报 XML 语法
     与片段内部 `xi:include` / `<Include>` 目标缺失，其余检查延后到上下文诊断。
3. 新增 `checkXiInclude`：`xi:include` 目标缺失在 Problems 中上报
   `include-not-found`（此前只在 indexer 内部诊断）。

### 测试（202 → 202 全绿）

- `localScope.test.mjs`：无 `xpointer` 的 `xi:include` 把目标根元素
  `CreateObjectDie` 整体拼入 `Behaviors`，`DieMuxData` 仍挂在它下面；
- `contentFeatures.test.mjs`：片段已知根不再报 `missing-id` / 未解析引用，但子树
  未知属性仍报；未知 wrapper 根不报元素/属性，片段内部缺失 `xi:include` 仍报；
  完整 `AssetDeclaration` 文档的顶层 id 检查不受影响。

### 边界与后续

- **P1 上下文诊断**：indexer 增加“反向 include 表”（`xi:include` 目标 →
  include 者列表），打开片段时用 include 者的逻辑树做真实上下文校验，再恢复引用 /
  define / 子元素结构检查。多上下文取并集去重。
- `<Include type="all|instance|reference">` 与 `xi:include` 语义不同：前者的目标
  是完整 `AssetDeclaration`，不进入片段模式；后者才允许片段文件。

---

## 三十、问题分析（2026-08-11）：`FXList inheritFrom` 误报未知属性与模型修正

### 现象

`GlobalData/FX_List.xml` 中：

```xml
<FXList id="FX_LargeEMCannonHitCrit" inheritFrom="FX_LargeEMCannonHit">
  <NuggetList>
    <ParticleSystem Particle="CritHit" OrientToObject="true" Ricochet="true"/>
  </NuggetList>
</FXList>
```

报 `Unknown attribute "inheritFrom" for <FXList>`。

### 根因（三个独立问题）

**A. `inheritFrom` 的 XSD 白名单落后于 BAB 实际语义**

- SDK 与 Corona 的 `AssetTypeFXList.xsd` 都写 `FXList extends BaseAssetType`；
- `BaseAssetType` 只有 `id` / `typeHashCode` / `buildRule`，`inheritFrom` 只挂在
  `BaseInheritableAsset` 上；
- 内置模型因此认为 `FXList` 没有 `inheritFrom`，diagnostics 的 unknown-attribute
  直接按模型属性表判断；
- 但引用 / hover / 跳转层早就把 `inheritFrom` 当作通用引用属性处理，只有“属性名
  合法性”这一层还在用 XSD 白名单，所以表现为局部不一致。

证据（用插件同一套解析器 + 模型扫描）：

| 类型 | 原版 SageXml 顶层使用 `inheritFrom` | Corona 顶层使用 |
|---|---|---|
| `AIMicroManagerData` | 233 | 128 |
| `FXList` | 142 | 10 |
| `AITargetingHeuristic` | 10 | 5 |
| `ObjectCreationList` | 2 | 0 |
| `OnDemandTextureImage` | 0 | 9 |

原版 `FXListSoviet.xml` / `FXListJapan.xml` 大量使用该写法，说明这是 BAB 接受的
真实语义，不是用户笔误。

**B. `simpleContent` 复杂类型的属性被生成器丢弃**

`xsd-to-model.mjs` 的 `expandComplexType` 只读 `complexContent/extension`，没有读
`simpleContent/extension`。因此：

- `AudioFileRefWithWeight`（XSD 有 `Weight` / `Volume`）在模型里属性为空；
- `MultisoundSubsoundRef`（XSD 有 `Weight` / `PitchShiftLow/High` / `Volume` /
  `PlayPercent` / `VolumeShift`）同样为空。

Corona 实测 `<Sound Weight="...">` 565 处、`<Subsound Weight="...">` 33 处会被误报。
simpleContent 复杂类型的**文本内容**引用语义（如 `<Sound>AudioFile</Sound>` 的补全 /
hover / 跳转 / 诊断 / FAR）在第三十一轮补齐，见下。

**C. 片段根元素仍受“元素名→类型”全局单映射影响**

`EvaEvent` 既是顶层资产，也是 `FXNuggetTypes` 的子元素
（`EvaEventFXNugget`）。全局 `elementTypeName("EvaEvent")` 取到的是先注册的
`EvaEventFXNugget`。完整 `AssetDeclaration` 文档有父上下文可以纠正；但
`additionalmaps/ALLC.xml` 这类根元素就是 `<EvaEvent>` 的片段没有父上下文，于是
`Priority`、`TimeBetweenEvents`、`ExpirationTime` 等合法属性被当成未知。

### 修复

1. **通用属性合法性集中到模型层**：`schemaModel.ts` 新增
   `isAssetType()`（`BaseAssetType` 及其后代）与通用 `inheritFrom` 属性；
   `attributesOfType()` 对资产类型统一返回它。诊断、属性补全、hover 自动一致。
2. **CodeLens / FAR 的“设计目标”判定保持窄口径**：`refs.ts` 的
   `referenceTargetTypes()` 仍只看 XSD 显式声明的 `inheritFrom` 与类型化引用，
   不会因为通用属性把全部 317 个资产类型变成计数目标。`isReferenceAttributeOfType`
   与 `resolveReferenceTargetsForType` 同步改为只对资产类型接受 `inheritFrom`。
3. **生成器支持 `simpleContent/extension`**：`expandComplexType` 现在同时读
   `complexContent` 与 `simpleContent` 的 extension，重新生成模型后
   `AudioFileRefWithWeight` / `MultisoundSubsoundRef` 属性齐全。
4. **片段根优先取顶层类型**：`schemaModel.topLevelElementType()` 从
   `AssetDeclaration` 的子元素声明解析类型；`resolveElementType()` 对文档根先用它，
   再回退全局映射；hover 的元素名展示也使用已解析类型。

### 测试（举一反三，全量 210 通过）

- `schemaModel.test.mjs`：`FXList` / `AIMicroManagerData` / `ObjectCreationList` /
  `OnDemandTextureImage` / `AITargetingHeuristic` 均接受 `inheritFrom`，
  `Include` 不接受；`AudioFileRefWithWeight` / `MultisoundSubsoundRef` 属性齐全；
- `refs.test.mjs`：`FXList inheritFrom` 是引用，`Include inheritFrom` 不是；
  `Credits` 接受通用 `inheritFrom` 但仍是 `isReferenceTargetType() === false`，
  证明两个判定已分离；
- `typeContext.test.mjs`：片段根 `<EvaEvent>` / `<UpgradeTemplate>` 解析为顶层
  类型，`<Weapon>` 仍回退到 `WeaponRef`；
- `completion.test.mjs`：`FXList` 属性补全出现 `inheritFrom`；
- `contentFeatures.test.mjs`：`FXList inheritFrom`、`<Sound Weight>`、片段根
  `<EvaEvent>` 不再报 unknown-attribute，真实拼写错误仍报。

### 文档同步

- `docs/requirements.md`：继承机制补充“对资产类型通用”；
- `docs/plan.md`：XSD 结构说明补充实测差异与两个判定的分离；
- `docs/features-reference-counts.md`：说明通用 `inheritFrom` 不扩大 CodeLens
  目标集合。

---

## 三十一、问题分析（2026-08-11）：补齐所有“内容即引用”的语义（含 simpleContent 复杂类型）

### 目标

上一轮只恢复了 `AudioFileRefWithWeight` / `MultisoundSubsoundRef` 的属性，但它们
的文本内容（`<Sound>AudioFile</Sound>`、`<Subsound>VoiceEvent</Subsound>`）仍然
没有按引用处理。本轮把 simple-content 的内容语义统一到一条管线：**凡是元素文本
内容带 `xas:refType` 的，无论底层是 simple type 还是 simpleContent complexType，
都参与补全 / hover / 跳转 / 诊断 / 引用索引 / FAR**。

### 真实项目验证

用插件同一套解析器 + 模型扫描 Corona `Data`（7540 个 XML，跳过 w3x）：

| 类别 | 唯一元素/类型组合 | 出现次数 | 典型元素 |
|---|---|---|---|
| 带 `refType` 的内容引用 | 62 | 20,813 | `Sound`→AudioFile、`Subsound`→BaseAudioEventInfo、`CreateObject`→GameObject、`TriggeredBy`→UpgradeTemplate |
| 无 `refType` 的 `isRef` 内容 | 5 | 1,150 | `Value`/`AddEmotion`/`Compare`/`Campaign`/`Mission`→AssetReference |
| 普通标量/枚举内容 | 6 | 9,012 | `IncludeThing`/`ExcludeThing`→WeakReference、`Script`、`SpecificBarrelOverride` |

结论：

- `Sound` / `Attack` / `Decay`（`AudioFileRefWithWeight`）内容确实是 `AudioFile`
  引用；`Subsound`（`MultisoundSubsoundRef`）内容确实是 `BaseAudioEventInfo`
  引用，必须纳入全局引用语义。
- `AssetReference` 系的无类型内容（`Value` 等）是着色器常量、脚本参数等，
  **不应**按全局资产 ID 解析；保持上一轮“只处理带 refType 的内容”的边界。
- `IncludeThing` / `ExcludeThing` 等 `WeakReference` 内容是对象过滤/局部语义，
  也没有 refType，不参与全局引用。
- 内联 simpleContent（如 w3x 的 `Frame`）是 `xs:float` 标量，`contentInfoOfType`
  能识别但 `refType === null`，不会误报。

### 实现

1. **模型层**：`schemaModel.ts` 新增 `SimpleContentInfo` / `ContentTypeInfo` 和
   `contentInfoOfType()`；`ComplexTypeInfo` 增加可选 `content` 字段。
   `xsd-to-model.mjs` 对 `simpleContent/extension` 记录 base 类型的
   `refType` / `isRef` / 枚举 / list / `$DEFINE` 能力。
2. **引用判定**：`refs.ts` 的 `isReferenceContentType()` 与
   `resolveContentReferenceTargets()` 改用统一内容描述；simpleContent 复杂类型
   的 `refType` 也进入 `referenceTargetTypes()`，保证 CodeLens 类型过滤正确。
3. **索引**：`records.ts` 内容记录的 `refType` 从统一内容描述提取，FAR 与
   引用计数不再丢 `Sound` / `Subsound`。
4. **补全**：`completion.ts` 的元素片段、内容值补全、子元素补全触发 suggest 均
   统一走 `contentInfoOfType()`，`<Sound>` 会生成 `<Sound>$1</Sound>` 并弹
   AudioFile 候选。
5. **hover / 导航 / 诊断**：全部改为从 `contentInfoOfType()` 取 `refType`。

### 测试（全量 219 通过）

- `schemaModel.test.mjs`：`contentInfoOfType` 对 simple 与 simpleContent 统一；
- `refs.test.mjs`：`AudioFileRefWithWeight` / `MultisoundSubsoundRef` 是内容引用，
  `@inline:Frame` 不是；同名 AudioFile / AudioEvent 严格按 refType 过滤；
- `records.test.mjs`：`Sound` / `Subsound` 文本进入引用索引；
- `completion.test.mjs`：`<Sound>` 补全成值对并触发 suggest，内容值只补
  AudioFile；
- `contentFeatures.test.mjs`：`<Sound>` hover / Ctrl+点击 / `<Subsound>` 未解析
  诊断；
- `referenceProvider.test.mjs`：FAR 返回 `Sound` 文本引用。

### 文档同步

- `docs/requirements.md`：simple-content 元素补充 simpleContent 复杂类型示例；
- `docs/plan.md`：simple-content 文本引用说明补充第三十一轮扩展；
- `docs/features-reference-counts.md`：引用语义说明补充“含 simpleContent 复杂
  类型”。

---

## 三十二、问题分析（2026-08-11）：限定引用值 `类型:ID` 未被归一化导致误报未解析

### 现象

Corona `Data\Allied\Units\AlliedFutureTankX-1\AudioEvent.xml`：

```xml
<Includes>
    <Include type="instance" source="DATA:SageXml/Sounds/BaseSoundEffect.xml" />
</Includes>

<AudioEvent
    id="ALL_FutureTank_ArmPrimaryWeapon"
    inheritFrom="AudioEvent:BaseSoundEffect"
    ... />
```

报 `Unresolved reference "AudioEvent:BaseSoundEffect"`，提示当前索引中未找到；
但 `SageXml\Sounds\BaseSoundEffect.xml` 里确实存在 `<AudioEvent id="BaseSoundEffect" />`，
且 `instance` include 会被索引器与文档局部 overlay 正常 walk。

### 根因

插件只在 **manifest 一侧**做了“资产名 `类型:ID` → 裸 ID（取最后冒号段）”
的归一化（`manifestParser.deriveAssetId`）；**XML 引用值一侧**直接用原始值查
`assetsById`。于是 `AudioEvent:BaseSoundEffect` 被当成完整 ID 精确匹配，
索引里只有 `BaseSoundEffect`，必然查不到。

实测最小复现：索引中包含 `AudioEvent@BaseSoundEffect`（origin=sdk），
`assetsById.get("audioevent:basesoundeffect")` 返回 NOT FOUND，
`resolveReferenceTargetsForType` 返回 0 目标。

### 影响面（真实数据统计）

这是原版数据的**普遍写法**，不是用户笔误：

| 属性 | SageXml | Corona Data | 典型值 |
|---|---|---:|---|
| `inheritFrom` | 5,483 | 3,219 | `AudioEvent:BaseSoundEffect` |
| `Sound`（AudioEntry） | 39 | 98 | `AudioEvent:JAP_Refinery_Select` |
| `Side` | 67 | 195 | `PlayerTemplate:Allies` |
| `ParticleTexture` | 2 | 2 | `Texture:FXLenzFlare01` |

前缀全部是**定义资产的具体类型**（manifest 全名格式），而 XSD refType 可能是
基类（如 `Sound` 的 refType 是 `BaseAudioEventInfo`，前缀是 `AudioEvent`）。
两侧数据的 `id="类型:ID"` 出现次数均为 0，说明定义侧永远是裸 ID，取最后冒号段
没有歧义。少数 `Sound="AudioEvent:MammothTankTurretMoveLoop"` 等引用在 SDK
源码与三个 manifest 中都找不到定义，是原版数据自身的死引用，归一化后仍会
（且应该）继续报未解析。

### 修复

1. `refs.ts` 新增 `normalizeReferenceId(value)`：取最后冒号段（与
   `deriveAssetId` 同一规则；冒号后为空时保留原值，避免半输入误匹配），
   应用到 `resolveReferenceTargetsForType` 与 `resolveContentReferenceTargets`。
2. `referenceIndex.ts` 的 `buildReferenceIndex` 与 `features/references.ts`
   的 `definitionsForReference` 同样归一化，FAR / CodeLens / 引用 peek 与
   诊断、hover、跳转保持一致。
3. `records.ts` 不修改：记录仍保存原始值与原始偏移，导航/悬停范围不受影响，
   缓存格式与版本不变。
4. `completion.ts` 的 `assetIdItems`：当前输入段含 `:` 时按冒号后片段过滤，
   补全项 label/insertText 为“已输入前缀 + 裸 ID”（如 `AudioEvent:Base…`
   → `AudioEvent:BaseSoundEffect`）；未输入前缀时保持裸 ID 补全，不特判任何
   类型、也不改变默认补全形态。

### 测试（219 → 226 全绿）

- `refs.test.mjs`：`normalizeReferenceId` 边界；qualified `inheritFrom`
  解析、裸 ID 不变、错误类型前缀仍被 selfType 过滤；qualified 属性
  （`Sound` / `Side`）与 simple-content（`AudioFile:...`）引用解析；
- `referenceIndex.test.mjs`：qualified 记录计入反向索引（FAR / CodeLens 桶）；
- `indexer.test.mjs`：临时项目集成——`instance` include 进 SageXml +
  `inheritFrom="AudioEvent:BaseSoundEffect"`，断言定义入库、解析命中、
  反向索引落点（即用户报告的完整场景）；
- `completion.test.mjs`：`AudioEvent:Base…` 补全为
  `AudioEvent:BaseSoundEffect` 且替换范围只覆盖当前段；无前缀仍补裸 ID；
- `contentFeatures.test.mjs`：qualified `inheritFrom` 不产生未解析诊断，
  Ctrl+点击精确定位到裸 ID 定义。

### 文档同步

- `docs/requirements.md`：情况描述补充 `类型:ID` 引用写法与归一化规则；
- `docs/plan.md`：设计决策 5 补充限定引用值归一化，实施记录追加第 29 轮；
- `CHANGELOG.md`：0.1.24。
