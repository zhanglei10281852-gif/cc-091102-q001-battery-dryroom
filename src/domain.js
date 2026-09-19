// 领域状态与冲突类别 —— 原有导出保持不变。
export const requestStates = ['submitted', 'negotiating', 'window-held', 'approved', 'cancelled', 'expired'];
export const conflictKinds = ['calendar-overlap', 'topic-overlap', 'rolling-quota', 'protected-period'];

// 未锁定（开放）/ 已锁定（占用日历与人员）/ 终态。
export const OPEN_STATES = new Set(['submitted', 'negotiating']);
export const ACTIVE_STATES = new Set(['window-held', 'approved']);
export const TERMINAL_STATES = new Set(['cancelled', 'expired']);

export class DomainError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const OFFSET_PATTERN = /(Z|[+-]\d{2}:?\d{2})$/i;

// 时间字段必须携带偏移量；一律归一到 UTC 毫秒（同一时刻）后再参与比较。
export function toInstant(value, field = 'timestamp') {
  if (typeof value !== 'string' || !OFFSET_PATTERN.test(value.trim())) {
    throw new DomainError('invalid-timestamp', `${field} 必须携带时区偏移量（例如 2026-10-25T23:30:00+02:00）`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new DomainError('invalid-timestamp', `${field} 不是合法时间：${value}`);
  }
  return ms;
}

export function toUtcIso(ms) {
  return new Date(ms).toISOString();
}

// 半开区间 [start, end)：首尾相接（end === start）不算重叠，因此可以连续排班。
export function intervalsOverlap(leftStartMs, leftEndMs, rightStartMs, rightEndMs) {
  return leftStartMs < rightEndMs && rightStartMs < leftEndMs;
}

// 修复旧实现：先归一到 UTC 时刻再比较，不再直接比较墙上时间。
export function overlaps(left, right) {
  return intervalsOverlap(
    toInstant(left.startsAt, 'startsAt'),
    toInstant(left.endsAt, 'endsAt'),
    toInstant(right.startsAt, 'startsAt'),
    toInstant(right.endsAt, 'endsAt'),
  );
}

// 扫描线求窗口内人员占用峰值。同一时刻先释放后占用（半开区间语义），
// 因此首尾相接的两把锁不会叠加计数。
export function peakUsage(locks, startMs, endMs) {
  const events = [];
  for (const lock of locks) {
    if (!intervalsOverlap(lock.startMs, lock.endMs, startMs, endMs)) continue;
    events.push([Math.max(lock.startMs, startMs), lock.personnel]);
    events.push([Math.min(lock.endMs, endMs), -lock.personnel]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let peak = 0;
  for (const [, delta] of events) {
    current += delta;
    if (current > peak) peak = current;
  }
  return peak;
}

// 冲突识别：材料主题重合、人员时段重合、滚动配额、保护时段。
// candidate: { startMs, endMs, topicCodes, roomId }
// holders:   已锁定窗口的其他申请（调用方已排除自身）
// locks:     当前有效的人员占用（按联合检查组聚合）
export function detectConflicts({ candidate, holders = [], locks = [], protectedPeriods = [], rollingQuota = null }) {
  const conflicts = [];

  for (const period of protectedPeriods) {
    if (intervalsOverlap(candidate.startMs, candidate.endMs, period.startMs, period.endMs)) {
      conflicts.push({
        kind: 'protected-period',
        detail: period.reason ?? '保护时段',
        protectedStartsAt: toUtcIso(period.startMs),
        protectedEndsAt: toUtcIso(period.endMs),
      });
    }
  }

  if (rollingQuota && rollingQuota.max > 0 && rollingQuota.windowMs > 0) {
    // 以申请窗口为锚，向前 / 向后各取一个滚动窗口，取较大占用数。
    const backward = new Set();
    const forward = new Set();
    for (const lock of locks) {
      if (intervalsOverlap(lock.startMs, lock.endMs, candidate.startMs - rollingQuota.windowMs, candidate.endMs)) backward.add(lock.groupId);
      if (intervalsOverlap(lock.startMs, lock.endMs, candidate.startMs, candidate.endMs + rollingQuota.windowMs)) forward.add(lock.groupId);
    }
    const count = Math.max(backward.size, forward.size);
    if (count >= rollingQuota.max) {
      conflicts.push({
        kind: 'rolling-quota',
        detail: `滚动窗口内已有 ${count} 项检查，达到上限 ${rollingQuota.max}`,
        limit: rollingQuota.max,
        windowMs: rollingQuota.windowMs,
      });
    }
  }

  for (const other of holders) {
    if ((other.roomId ?? 'default') !== (candidate.roomId ?? 'default')) continue;
    if (!intervalsOverlap(candidate.startMs, candidate.endMs, other.startMs, other.endMs)) continue;
    const sharedTopics = candidate.topicCodes.filter(topic => other.topicCodes.includes(topic));
    if (sharedTopics.length > 0) {
      conflicts.push({ kind: 'topic-overlap', withRequestId: other.requestId, sharedTopics });
    } else {
      conflicts.push({ kind: 'calendar-overlap', withRequestId: other.requestId });
    }
  }

  return conflicts;
}

// 兼容旧接口的容量登记：同一 commandId 重复到达只生效一次，且只扣减一次。
export function reserve(state, request) {
  if (state.seen.includes(request.commandId)) return state;
  state.seen.push(request.commandId);
  state.capacity -= 1;
  state.requests.set(request.requestId, request);
  return state;
}
