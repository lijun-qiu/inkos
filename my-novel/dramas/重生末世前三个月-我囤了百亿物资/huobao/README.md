# 火宝格式剧本说明

- 规范：`C:\project\huobao-drama\skills\script_rewriter\SKILL.md`
- 源小说：`shorts/重生末世前三个月-我囤了百亿物资/final/chapters/`
- 产出：`huobao/episodes/ep01.md` … `ep50.md`（一章一集）
- **未调用** huobao-drama / 任何外部 API，仅在本地按技能格式改写

## 格式

```
# 第N集 标题
## S01 | 内景/外景 · 地点 | 时间段
动作段落
角色名：（状态/表情）台词
```

## 导入火宝

1. 新建 drama
2. 为每集创建 episode，把对应 `epXX.md` 全文写入该集的 `script_content`（或先作 `content` 再改写——本目录已是改写结果，可直接作 `script_content`）
3. 继续跑 extractor / storyboard_breaker 等后续 Agent


## 版本
- `episodes/` + `script-all.md` + `INDEX.md`：当前定稿 **v003**（串行高密度；改写时优先咬合上一集剧本结尾）
