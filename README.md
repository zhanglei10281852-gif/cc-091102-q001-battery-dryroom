# 固态电池干燥间检查协调

本服务由入场检查统筹模块演进而来，负责登记干燥间的环境监测窗口、识别材料主题重合并维护人员容量。时间字段必须携带偏移量；`fixtures/incident.json` 保存一次跨午夜、跨时区的现场记录。

运行 `npm test` 检查领域资料，运行 `npm start` 启动本地接口。开发数据写入 `data/`，密钥与现场联系人信息不得提交。

## 工作流程

```
submitted ──无冲突──▶ submitted ──confirm──▶ window-held ──approve──▶ approved
    │                      │                      │                      │
    └─有冲突─▶ negotiating ┘                      ├─保留期过─▶ expired   │
               negotiating ──confirm(可 mergeWith)─┘                     │
               任意非终态 ──cancel──▶ cancelled（占用立即释放）
```

- **受理**：`POST /requests` 登记申请，同步识别冲突；无冲突为 `submitted`，有冲突转入 `negotiating` 并记录原因。
- **合并确认**：`POST /requests/:id/confirm`，可用 `mergeWith: [id...]` 把多方并入同一联合检查组；窗口默认取各方并集，组内人员按成员最大值只锁一份。
- **锁定**：确认成功即锁定窗口与监测人员（`window-held`），保留期默认 30 分钟，逾期未批准自动 `expired` 并释放。
- **改期**：`POST /requests/:id/reschedule` 先校验后落账——冲突或容量不足时原窗口保持不变；成功时原窗口占用原子释放，不留幽灵占用。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/requests` | 受理申请 `{topicCodes[], startsAt, endsAt, party?, roomId?, personnelRequired?, commandId?}` |
| GET | `/requests?state=` | 列出申请（可按状态过滤） |
| GET | `/requests/:id` | 申请详情，含 `reasons`（获准 / 协商 / 受阻原因）与 `conflicts` |
| POST | `/requests/:id/confirm` | 确认 `{mergeWith?, startsAt?, endsAt?}`，锁定窗口与人员 |
| POST | `/requests/:id/approve` | 批准（保留期不再适用） |
| POST | `/requests/:id/cancel` | 取消 `{reason?}`，释放占用 |
| POST | `/requests/:id/reschedule` | 改期 `{startsAt, endsAt}` |
| GET | `/calendar?from=&to=` | 日历：已锁定窗口（UTC 归一）与待确认申请 |
| GET | `/capacity?at=` 或 `?from=&to=` | 可用监测人员：某时刻或窗口峰值 |

冲突类别：`calendar-overlap`（时段重合）、`topic-overlap`（材料主题重合，可合并）、`rolling-quota`（滚动配额）、`protected-period`（保护时段）；另有 `capacity-exhausted`（人员不足）。

## 关键语义

- **时间归一**：所有时间必须带偏移量（如 `2026-10-25T23:30:00+02:00`），比较前统一归一到 UTC 时刻；夏令时切换夜跨午夜的窗口按真实时长计算。
- **半开区间**：窗口为 `[start, end)`，首尾相接不算重叠，可以连续排班。
- **幂等**：每个写操作携带 `commandId`（或 `Idempotency-Key` 头），重复到达返回首次结果，副作用只发生一次；重启后幂等表随日志恢复。
- **持久化**：事件日志 `data/events.jsonl` + 定期快照 `data/snapshot.json`，重启后回放恢复一致日历，过期保留在启动时即被清扫。
- **并发**：所有变更串行落账，容量按扫描线峰值核对，并发争抢同一人员时只有一份申请能锁定。

## 配置（环境变量）

`PORT`（默认 8080）、`DATA_DIR`（默认 `data`）、`TOTAL_PERSONNEL`（默认 3）、`HOLD_TTL_MS`（默认 1800000）、`PROTECTED_PERIODS`（JSON 数组 `[{startsAt, endsAt, reason}]`）。
