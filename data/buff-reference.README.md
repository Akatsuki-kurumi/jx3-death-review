# Buff 本地参考字典

数据文件：`data/buff-reference.json`，UTF-8 JSON，无 BOM。

当前来源为维护者提供的 `maintainer-target-monitor-20261104.zhcn.jx3dat` 目标监控，声明版本“苍生铸世 · 2026/10/31”。2026-11-04 按 GB18030 解码，以数据型 Lua 解析器读取，未执行文件内容、未请求网络。已接入击杀分析及 AI 游戏事实库，未修改前端页面。

本次完整替换旧 `302007_3317138.jx3dat` 词典，未把两份标签合并。旧版及完整差异保存在本地 `analysis/buff-dictionary-2026-11-04/`，不随公开源码发布。新来源未出现某个 ID，只表示未收录，不能解释为游戏删除了该 Buff。

## 数据规模

- 1 个非空目标监控面板，共 1,432 条原始监控记录。
- 1,381 个不同 Buff ID，1,432 组 ID + 等级，408 个原始分类/显示标签。
- 1,432 条不同监控定义，本来源没有重复定义、同等级多名称或多分类；数据结构仍保留这些能力。
- 相比旧词典增加 684 个 ID，有 139 个旧 ID 未被新来源收录。ID + 等级维度增加 1,175 组，移除 595 组；共同条目中 40 组名称/分类变化，包含图标变化时共 45 组。
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
dictionary.buffs['377'].levels['0'].name;           // 镇山河
dictionary.buffs['377'].levels['0'].categories;     // ["无敌"]
dictionary.buffs['377'].levels['0'].iconIds;        // [1453]
dictionary.buffs['9377'].levels['0'].categories;    // ["疾行"]
dictionary.buffs['11361'].levels['1'].name;         // 尘身
dictionary.buffs['11361'].levels['2'].name;         // 尘身（新来源原文）
dictionary.buffs['11361'].levels['1'].categories;   // ["强免"]
dictionary.buffs['11361'].levels['2'].categories;   // ["免封"]
dictionary.buffs['24356'].levels['0'].categories;   // ["禁疗"]，监控作者标签
dictionary.buffs['29282'].levels['0'].name;         // 提子
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

顶层 `panels[].fields` 保留各面板的原设置；`source` 记录原文件名、编码、SHA256 和原声明版本；`stats` 提供计数。schemaVersion 为 `1.1.0`，保留原查表结构，新增 `maintenance`。本次由维护配置选定 `client=std`、`gameVersion=std-2026-10-30`，basis 为 `maintainer_selected_monitor`；这不是原监控字段，也不把抓取日期当成游戏生效日期。`mechanicsVerified=false` 表示未逐条核实机制。

## 使用边界

1. 这是监控作者整理的参考标签，不是官方效果数据库。`szContent` 既有“大减”“免封”等缩写，也有技能简称；保留原文，不擅自扩展为固定游戏机制。声明版本“苍生铸世 · 2026/10/31”不表示每一项都经过官方核验。
2. 必须保留 Buff ID + 等级。`nLevel=0` 原样保存；现有击杀分析 `matchBuff` 会组合精确等级与监控等级 0 候选，并检查叠层条件，返回具体 match 类型。本次沿用既有行为，没有重新验证插件通配语义；不能把它等同于 API 等级 0 说明适用于所有等级。
3. 精确等级缺失时，若该 ID 所有记录只有一种名称，可作为明确标注来源的名称参考；分类和心法/叠层条件不能跨等级直接套用。存在多个名称时保留候选或回退 ID。
4. 同等级多分类同时保留。`definitions` 保留心法、叠层、地图及开关等原字段；现有匹配器只检查叠层，其他监控筛选条件未逐项执行。匹配结果增加 conditionStatus 提醒此边界。原始 tKungfu、tTargetKungfu 不擅自解释为 Buff 施法者条件。
5. 不能根据 Buff 标签直接认定某个技能已主动施放、成功解控或减少了多少伤害；仍需对应的 JCL 事件证据。Buff 与技能是不同资源类型，不能用 Buff ID 查技能名称。
6. 字典只提供图标 ID，不含图像文件。本次没有下载图标；接入时复用现有持久缓存，新增图标首次成功获取后保存。

## 验证与重新导入

可复用转换程序：`scripts/import-buff-reference.cjs`，不依赖本地研究目录。合成导入、条件与标签变化、事实升级和经验保留测试见 `test/buff-reference.test.cjs`。

本次真实来源验证：`analysis/buff-dictionary-2026-11-04/validation.json`；差异报告 `diff.json`；原字典备份 `buff-reference.previous.json`。

已从保存后的 JSON 重建所有 1,432 条监控记录及全部面板字段，与解析后的源数据逐字段一致；等级、名称、分类、图标、条件及原始来源均保留，源文件读取前后 SHA256 一致。重建比较忽略 Lua 字段文本顺序，不声称可以复原原文件字节格式。源文件 SHA256：`9d9e2bd1145623a81021cbd6dd544f7aa0b3335e26e78ab55d0ca6672585533b`。

转换程序会拒绝覆盖已存在的输出与报告。命令：`node scripts/import-buff-reference.cjs 输入文件 新JSON路径 新报告路径 std std-2026-10-30`。末尾两个参数是维护者指定的客户端和资料版本，可以同时省略（未知），不能只提供一个。换季先另存、验证、比较，备份当前字典后再替换；不要直接把旧版本标为当前版本。

替换后需重新启动使用它的后端进程。词典内容已参与对战缓存规则指纹和 AI 知识指纹；AI 首次读取时归档旧监控事实，导入新监控事实，保留学习经验。没有用户事实库浏览入口；旧 AI 报告保留原结果，不自动付费重跑。
