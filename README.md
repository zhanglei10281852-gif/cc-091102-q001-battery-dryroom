# 固态电池干燥间检查协调

联合检查协调服务：受理环境监测申请、识别材料主题与人员时段重合、组织多方合并表决，在确认后锁定干燥间有限的监测能力。所有时间字段必须携带偏移量，服务内部统一归一到绝对时刻（epoch）比较。

`fixtures/incident.json` 保存一次跨午夜、跨时区（`+02:00` → 次日 `+01:00`）的现场记录。

## 设计要点

- **时间归一**：拒绝无偏移量的裸时间；`Date.parse` 归一到 epoch 毫秒后比较。占用采用半开区间 `[start, end)`，首尾相接（`end == next.start`）不冲突，可连续排班；跨午夜、跨时区、夏令时切换夜都以绝对时刻为准。
- **冲突类别**（`src/domain.js`）：
  - `calendar-overlap`：同房间重合占用位超过房间 `capacity`；
  - `topic-overlap`：材料主题重合（建议联合检查）；
  - `rolling-quota`：参与人员在重合窗口已被排程，或未登记覆盖整段的可用时间；
  - `protected-period`：窗口与保护时段（吊装/封禁）相交。
- **结论**：无冲突 → `window-held`（暂留 15 分钟，需确认锁定）；可合并或有无冲突备选窗口 → `negotiating`；既无合并线索也无近期备选 → `blocked`。每份申请都带 `reasons` 说明获准/协商/受阻原因。
- **联合检查**：主题或人员重合的多份申请可组成提案，全体参与人员表决；全员接受后整体只锁定**一个**监测位；任一方拒绝/取消/改期则提案作废，成员回到各自日历重新评估，已锁定的联合检查被拆散时联合占用立即释放。
- **无幽灵占用**：取消、改期、暂留 TTL 过期、窗口过期、提案作废全部通过事件清除占用；冲突解除后协商中的申请在下一次观察时自动晋升。
- **幂等**：每个写命令必须带 `commandId`；同一命令重复（含并发、重启后）到达只生效一次，返回首次结果。`commandId` 跨操作复用返回 409。
- **持久化与恢复**：JSONL 仅追加事件日志 + 周期快照（临时文件原子 rename）。所有写操作经单条 Promise 链串行提交；重启时读最新快照再重放其后事件，日历与幂等索引一致恢复。
- **并发**：串行事务 + 申请 `revision` 乐观锁；并发申请下容量计数与可用人员清点始终正确。

## 运行

```bash
npm test          # 34 个测试：领域、编排/持久化、HTTP 端到端
npm start         # 默认 DATA_DIR=./data，PORT=8080
PORT=8099 DATA_DIR=/var/lib/dryroom npm start
```

开发数据写入 `data/`（已在 `.gitignore`），密钥与现场联系人信息不得提交。

## API

所有请求/响应均为 JSON；写操作需要 `commandId`。时间一律为带偏移量的 ISO 8601（`Z` 或 `±HH:MM`）。

### 基础数据

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/rooms` | 登记干燥间 `{commandId, roomId, capacity, displayName?}` |
| POST | `/personnel` | 登记人员 `{commandId, personId, displayName?}` |
| POST | `/personnel/:id/availability` | 登记可用时间 `{commandId, window|windows:[{startsAt,endsAt}]}`（可用时间须覆盖整个申请窗口） |
| POST | `/protected-periods` | 保护时段 `{commandId, periodId?, roomId?, window, reason?}`，`roomId` 省略表示全局 |

### 检查申请

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/requests` | 提交申请 `{commandId, requestId?, topicCodes[], personIds[], roomId, window:{startsAt,endsAt}}`；立即返回 `window-held` / `negotiating`（含冲突与备选窗口）/ `blocked` / `expired` |
| GET | `/requests?state=` | 申请列表 |
| GET | `/requests/:id` | 申请详情，含 `verdict`、`reasons`（获准/协商/受阻原因）、`conflictReport.alternatives`、`revision`、`history` |
| POST | `/requests/:id/confirm` | 确认暂留窗口并锁定监测能力（可带 `revision` 乐观锁；确认前复检） |
| POST | `/requests/:id/cancel` | 取消并立即释放占用（联合提案中会拆散整个提案） |
| POST | `/requests/:id/reschedule` | 改期 `{commandId, window, roomId?}`，旧窗口立即释放 |

### 合并提案

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/proposals` | `{commandId, requestIds[], window?, roomId?}`；省略窗口时取各申请偏好窗口的绝对时间交集 |
| GET | `/proposals` / `/proposals/:id` | 提案与表决进度 |
| POST | `/proposals/:id/respond` | `{commandId, personId, decision:'accept'|'decline', reason?}`；全员接受即统一锁定，任一拒绝即作废 |

### 查询

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/calendar?from=&to=&roomId=` | 区间内全部占用（`solo` / `proposal`）与各房间监测位用量 |
| GET | `/availability?from=&to=&personIds=a,b` | 可用人员清点：`availableCount`、`available`、`busy`、`unavailable`（含未登记者） |
| GET | `/health` | 健康状态与事件序号 |

### 典型跨时区流程

```
POST /rooms                 {commandId:'rm', roomId:'DRY-A', capacity:1}
POST /personnel             {commandId:'p1', personId:'P-EU'}
POST /personnel/p1/availability {commandId:'a1', window:{startsAt:'2026-10-01T00:00:00Z', endsAt:'2026-11-30T00:00:00Z'}}
POST /requests              欧洲班组 2026-10-25T23:30:00+02:00 → 2026-10-26T01:30:00+01:00
  → window-held（归一为 21:30Z → 次日 00:30Z）
POST /requests              日本班组 2026-10-26T06:30:00+09:00 → 09:30+09:00（与上窗绝对时间重合）
  → negotiating：calendar-overlap + topic-overlap
POST /proposals             联合窗口 21:30Z → 00:30Z
POST /proposals/:id/respond 双方 accept → 两份申请 approved，日历只有 1 个 proposal 占用
```

## 代码结构

```
src/domain.js   时间归一、半开区间占用、四类冲突、备选窗口、人员/房间清点（纯函数）
src/store.js    事件信封与回放、JSONL 日志、快照、串行幂等事务
src/service.js  业务编排：申请/确认/取消/改期、提案表决、过期清扫、原因视图
src/http.js     HTTP 路由与 JSON 错误归一
src/server.js   启动入口（加载持久化状态后监听）
```
