# 昨日世界 / World Yesterday

> **项目状态：已停止更新并下线。** 本项目自 2026-09-01 起无限期冻结，最后一期为 2026-08-31。仓库、历史日报和全部生成框架继续保留，但采集与部署均不会自动运行。

一个 PC 优先、公开只读的双语世界新闻日报。项目因当前维护决定停止继续更新；以下代码和说明作为可恢复的历史实现保留。

## 保留的运行链路

1. `collect.yml` 仅在 GitHub Actions 中手动触发，抓取指定日期的 RSS 与 GDELT，最多保留 90 个白名单候选。此步不调用模型。
2. Windows 计划任务当前不应安装；如恢复持续更新，可在用户登录后每 60 分钟通过隐藏包装器调用 `scripts/run-controller.ps1`。
3. 控制器先处理北京时间“昨日”，之后按从新到旧补缺；每个开机自然日最多 2 期，两期之间至少 90 分钟。
4. Codex 只可读取工作区，返回符合固定 JSON Schema 的日报。语义验证、`astro build` 全部通过后，控制器才提交并推送。
5. Pages 工作流仅在 GitHub Actions 中手动触发，重新执行测试、类型检查、验证和构建，再发布 `dist/`。

## 恢复方式

如需临时恢复网站，在 GitHub Actions 中手动运行 **Validate and deploy site**；成功部署会重新发布 GitHub Pages。需要补充候选时，再手动运行 **Collect daily candidates**。只有决定恢复每日更新时，才应重新加入工作流自动触发并安装 `WorldYesterday-CatchUp` 计划任务。

## 本机首次设置

需要 Node.js 24、Git、Codex CLI，以及已登录并可复用的 Codex CLI 会话。

```powershell
npm install
npm test
npm run check
npm run build
npm run controller:dry
```

建立公开 GitHub 仓库并设置远端后，推送 `main`。在仓库的 **Settings → Pages → Source** 选择 **GitHub Actions**。然后以当前 Windows 用户安装计划任务：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-task.ps1
```

任务触发器为“登录时 + 每 60 分钟”，要求网络可用。控制器从最多 90 个快照候选中均衡提交 60 个给只读沙箱中的 Codex，不在日常生成中逐页浏览；默认使用 `medium` 推理强度。若 `codex.exe` 不在 PATH，可在用户环境中设置 `CODEX_EXECUTABLE` 为完整路径。`CODEX_REASONING_EFFORT` 可按需改为 `low`、`high` 或 `xhigh`。卸载任务运行 `scripts/uninstall-windows-task.ps1`。

## 常用命令

```powershell
npm run collect                         # 采集北京时间昨日
npm run collect -- --date 2026-08-25  # 指定日期
npm run controller:dry                 # 只显示下一期，不调用 Codex
npm run controller -- --date 2026-08-25
npm run controller -- --publish        # 验证成功后提交并推送
```

`data/raw/` 保存原始候选，`data/editions/` 保存公开日报，`data/usage/` 保存月度聚合。`.runtime/`、本机任务状态和日志不会提交。仓库中不得放入令牌、Cookie 或账号文件。

## 可靠性与边界

- 真实性证据只接受 `config/sources.json` 中的 A/B 级来源；GDELT 只用于发现热点。
- 每期另设 Science 与 Nature 两个期刊精选位置。Science RSS 只负责发现和日期判断，采集器按 DOI 精确查询 Crossref 补充出版社提交的摘要；Crossref 不是第二个独立来源，也不改变核验等级。
- 已核验内容需要两个独立白名单来源，或一个能直接证明自身行为/数据的一手来源；国家媒体会标注属性，争议事件不能只靠国家媒体定论。
- 每期最多 15 条白名单单源观察；证据不足时允许少于 30 条，绝不以低质量来源凑数。
- 可靠性只决定能否发布，不参与重要性加分；重要性采用公开权重的 MCDA，由控制器计算。单一主要机构每期最多 2 条、同栏目最多 1 条，科技与科学中的航天主题合计最多 3 条。
- 网站永远显示内容日期、实际生成时间、是否是最近完整日期及历史缺口。失败不会覆盖上一期。
- CLI 当前没有可依赖的“运行中到 80,000 token 自动中止”开关。项目通过最多 60 个已经清洗的候选、单轮结构化输出和严格篇幅控制输入，并读取 CLI usage 记录；测得超过 80,000 时拒绝发布。这个限制能阻止超额内容上线，但无法追回该次已经消耗的额度。

Codex 非交互模式与登录复用见 [OpenAI 官方文档](https://learn.chatgpt.com/docs/non-interactive-mode)，GitHub Actions 费用规则见 [GitHub 文档](https://docs.github.com/en/billing/concepts/product-billing/github-actions)。
