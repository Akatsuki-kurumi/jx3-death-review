# Buff 本地参考字典

数据文件：`data/buff-reference.json`，UTF-8 JSON，无 BOM。

来自用户提供的 `302007_3317138.jx3dat`，按 GB18030 解码，以数据型 Lua 解析器读取，未执行文件内容、未请求网络。仅整理参考数据，未修改复盘业务代码或页面。

## 数据规模

- 10 个监控面板，其中 7 个非空；共 4,323 条原始监控记录。
- 836 个不同 Buff ID，852 组 ID + 等级，229 个原始分类/显示标签。
- 合并为 854 条不同监控定义；3,469 条重复定义通过来源引用保留。
- 有 1 组同 ID 同等级包含多个分类；有 2 个 ID 在不同等级下名称不同。
- 所有记录的 ID、名称、分类均存在。未因面板被禁用而丢弃其中参考资料。

## 读取方式

```js
const dictionary = require('./data/buff-reference.json');
const buff = dictionary.buffs[String(buffId)];
const exact = buff?.levels[String(buffLevel)];
// exact?.name：该等级的中文名称。
// exact?.categories：原文标签数组，不能只取一个覆盖其他标签。
// exact?.iconIds：原配置的图标 ID 数组，沿用项目已有本地图标缓存。
// exact?.groups：原配置 szGroup，仅作分组信息，不当作分类。
```

例如：

```js
dictionary.buffs['377'].levels['1'].name;           // 镇山河
dictionary.buffs['377'].levels['1'].categories;     // ["无敌"]
dictionary.buffs['377'].levels['1'].iconIds;        // [1453]
dictionary.buffs['9377'].levels['0'].categories;    // ["免封", "高山"]
dictionary.buffs['11361'].levels['1'].name;         // 尘身
dictionary.buffs['11361'].levels['2'].name;         // 掠关
dictionary.buffs['11361'].name;                    // null：跨等级不能选定单一名称
dictionary.buffs['11361'].names;                   // ["尘身", "掠关"]
```

`categoryIndex[标签]` 返回带有 `buffId`、`level` 的条目，可用于按原始分类筛选。

## 字段和来源

| JSON 字段 | 原字段 | 含义 |
|---|---|---|
| buffs[id].id | dwID | Buff ID |
| levels[level].level | nLevel | 原监控配置等级 |
| name / names | szNote | 单一名称或名称列表 |
| categories | szContent | 原监控作者设置的分类/显示文字 |
| iconIds | nIconID | 图标 ID，不是 Buff ID |
| groups | szGroup | 监控分组名称 |
| definitions[].monitorFields | 原记录其他字段 | 保留叠层条件、心法条件、颜色、开关等原值 |
| definitions[].sourceRefs | 面板序号、记录序号、szUUID | 追踪所有原始记录，包括重复来源 |

顶层 `panels[].fields` 保留各面板的原设置；`source` 记录原文件名、编码、SHA256 和原声明版本；`stats` 提供计数。`client=null` 表示文件未直接声明与 API 对应的客户端类型，不凭文件名推断。

## 使用边界

1. 这是监控作者整理的参考标签，不是官方效果数据库。`szContent` 既有“大减”“免封”等缩写，也有技能简称；保留原文，不擅自扩展为固定游戏机制。原配置声明版本为 `2026/4/9`，不代表已核对当前游戏版本。
2. 必须优先按 Buff ID + 等级精确匹配。`nLevel=0` 原样保存；本次未核实监控插件对 0 的匹配规则，不能自动把它等同于 API 通用等级或所有等级通配。
3. 精确等级缺失时，若该 ID 所有记录只有一种名称，可作为明确标注来源的名称参考；分类和心法/叠层条件不能跨等级直接套用。存在多个名称时保留候选或回退 ID。
4. 同等级多分类同时保留。`definitions` 的心法条件、叠层条件等属于原监控定义，尚未实现匹配器；需要据此作自动判断时，应由接入方单独验证。
5. 不能根据 Buff 标签直接认定某个技能已主动施放、成功解控或减少了多少伤害；仍需对应的 JCL 事件证据。Buff 与技能是不同资源类型，不能用 Buff ID 查技能名称。
6. 字典只提供图标 ID，不含图像文件。本次没有下载图标；接入时复用现有持久缓存，新增图标首次成功获取后保存。

## 验证与重新导入

转换参考程序：`analysis/buff-dictionary-2026-10-25/import-buff-reference.cjs`。

验证报告：`analysis/buff-dictionary-2026-10-25/validation.json`。

已从保存后的 JSON 重建所有 4,323 条监控记录及全部面板字段，与解析后的源数据逐字段一致；确认等级差异、多分类、图标 ID、原始来源均保留，源文件读取前后 SHA256 一致。重建比较忽略 Lua 字段的文本排列顺序，不声称原文件字节格式可以复原。

转换程序会拒绝覆盖已存在的输出与报告，避免覆盖共享工作区已有结果。可使用 `node import-buff-reference.cjs 输入文件 新JSON路径 新报告路径` 指定输出；后续导入其他版本时先另存并比较，再决定是否替换当前参考字典。
