# 昨日世界 / World Yesterday

一个 PC 优先、公开只读的双语世界新闻日报。GitHub Actions 每天保存白名单候选，本机登录并联网后由 Codex CLI 生成最近一个完整自然日的日报；通过来源、结构和构建校验后才提交并由 GitHub Pages 发布。

## 运行链路

1. `collect.yml` 在北京时间 02:30（UTC 18:30）抓取 RSS 与 GDELT，最多保留 90 个白名单候选。此步不调用模型。
2. Windows 任务在用户登录后启动，并每 30 分钟调用 `scripts/run-controller.ps1`。
3. 控制器先处理北京时间“昨日”，之后按从新到旧补缺；每个开机自然日最多 2 期，两期之间至少 90 分钟。
4. Codex 只可读取工作区，返回符合固定 JSON Schema 的日报。语义验证、`astro build` 全部通过后，控制器才提交并推送。
5. Pages 工作流重新执行测试、类型检查、验证和构建，再发布 `dist/`。

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

任务触发器为“登录时 + 每 30 分钟”，要求网络可用。控制器把白名单 RSS 快照一次性提交给只读沙箱中的 Codex，不在日常生成中逐页浏览；默认使用 `high` 推理强度。若 `codex.exe` 不在 PATH，可在用户环境中设置 `CODEX_EXECUTABLE` 为完整路径。`CODEX_REASONING_EFFORT` 可改为 `medium` 或 `xhigh`。卸载任务运行 `scripts/uninstall-windows-task.ps1`。

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
- 已核验内容需要两个独立白名单来源，或一个能直接证明自身行为/数据的一手来源；国家媒体会标注属性，争议事件不能只靠国家媒体定论。
- 每期最多 5 条“待核实观察”；证据不足时允许少于 30 条，绝不以低质量来源凑数。
- 可靠性只决定能否发布，不参与重要性加分；重要性采用公开权重的 MCDA，由控制器计算。单一主要机构每期最多 2 条、同栏目最多 1 条，科技与科学中的航天主题合计最多 3 条。
- 网站永远显示内容日期、实际生成时间、是否是最近完整日期及历史缺口。失败不会覆盖上一期。
- CLI 当前没有可依赖的“运行中到 80,000 token 自动中止”开关。项目通过最多 90 个已经清洗的 RSS 候选、单轮结构化输出和严格篇幅控制输入，并读取 CLI usage 记录；测得超过 80,000 时拒绝发布。这个限制能阻止超额内容上线，但无法追回该次已经消耗的额度。

Codex 非交互模式与登录复用见 [OpenAI 官方文档](https://learn.chatgpt.com/docs/non-interactive-mode)，GitHub Actions 费用规则见 [GitHub 文档](https://docs.github.com/en/billing/concepts/product-billing/github-actions)。
