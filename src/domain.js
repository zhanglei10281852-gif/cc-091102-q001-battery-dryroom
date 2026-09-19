// 纯领域逻辑：带偏移量时间归一、占用模型、冲突识别、备选窗口、人员可用性。
// 不做 IO，不依赖时钟注入以外的外部状态，便于单元测试与重启回放。

export const requestStates = ['submitted', 'negotiating', 'window-held', 'approved', 'cancelled', 'expired'];
export const conflictKinds = ['calendar-overlap', 'topic-overlap', 'rolling-quota', 'protected-period'];

export const HOLD_TTL_MS = 15 * 60 * 1000; // 暂定窗口保留 15 分钟，逾期自动释放
export const DEFAULT_ROOM = 'DRY-MAIN';
export const ACTIVE_STATES = ['submitted', 'negotiating', 'window-held', 'approved'];

export class ApiError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// 时间归一：一切比较都落到同一绝对时刻（epoch 毫秒）。输入必须携带偏移量，
// 拒绝“无时区裸时间”，避免跨午夜/跨时区班次被墙上时钟字符串误排序。
// ---------------------------------------------------------------------------

const OFFSET_RE = /(Z|[+-]\d{2}:?\d{2})$/i;

export function parseInstant(value, field = '时间') {
  if (typeof value !== 'string' || !OFFSET_RE.test(value.trim())) {
    throw new ApiError(400, 'missing-offset', `${field} 必须是携带偏移量的 ISO 8601 字符串（Z 或 ±HH:MM）`, { field, received: value });
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new ApiError(400, 'invalid-instant', `${field} 无法解析为有效时刻`, { field, received: value });
  }
  return ms;
}

export const toUtc = (ms) => new Date(ms).toISOString();

export function windowView(win) {
  if (!win) return null;
  return {
    startsAt: win.startsAt,
    endsAt: win.endsAt,
    startEpoch: win.start,
    endEpoch: win.end,
    startsAtUtc: toUtc(win.start),
    endsAtUtc: toUtc(win.end),
    roomId: win.roomId,
  };
}

export function normalizeWindow(payload, { label = '时间窗口' } = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new ApiError(400, 'invalid-window', `${label} 必须包含 startsAt 与 endsAt`);
  }
  const start = parseInstant(payload.startsAt, 'startsAt');
  const end = parseInstant(payload.endsAt, 'endsAt');
  if (start >= end) {
    throw new ApiError(400, 'invalid-window', 'endsAt 必须晚于 startsAt（半开区间 [start, end)）', {
      startsAt: payload.startsAt,
      endsAt: payload.endsAt,
    });
  }
  return { start, end, startsAt: payload.startsAt, endsAt: payload.endsAt };
}

// 半开区间：相接不算重合，首尾相接可以连续排班。
export function overlaps(left, right) {
  const l = left.start !== undefined ? left : { start: Date.parse(left.startsAt), end: Date.parse(left.endsAt) };
  const r = right.start !== undefined ? right : { start: Date.parse(right.startsAt), end: Date.parse(right.endsAt) };
  return l.start < r.end && r.start < l.end;
}

export const isAdjacent = (a, b) => a.end === b.start || b.end === a.start;
export const covers = (win, start, end) => win.start <= start && end <= win.end;
export const uniqSorted = (items) => [...new Set(items)].sort();
export const intersect = (a, b) => a.filter((x) => b.includes(x));

// ---------------------------------------------------------------------------
// 占用模型：活跃占用 = 未被提案吸收的 held/approved 单窗口 + 每个活跃合并提案
// （提案整体只占一个监测能力位，参与人不再单独占位）。
// ---------------------------------------------------------------------------

export function occupants(state) {
  const list = [];
  for (const rec of state.requests.values()) {
    if (rec.proposalId) continue; // 由其合并提案统一代表
    if ((rec.state === 'approved' || rec.state === 'window-held') && rec.window) {
      list.push({
        kind: 'solo',
        id: rec.requestId,
        requestIds: [rec.requestId],
        roomId: rec.window.roomId,
        start: rec.window.start,
        end: rec.window.end,
        topicCodes: rec.topicCodes,
        personIds: rec.personIds,
      });
    }
  }
  for (const proposal of state.proposals.values()) {
    if (proposal.state !== 'proposed' && proposal.state !== 'accepted') continue;
    const topicCodes = new Set();
    const personIds = new Set();
    for (const id of proposal.requestIds) {
      const rec = state.requests.get(id);
      if (!rec) continue;
      rec.topicCodes.forEach((t) => topicCodes.add(t));
      rec.personIds.forEach((p) => personIds.add(p));
    }
    list.push({
      kind: 'proposal',
      id: proposal.proposalId,
      requestIds: [...proposal.requestIds],
      roomId: proposal.window.roomId,
      start: proposal.window.start,
      end: proposal.window.end,
      topicCodes: [...topicCodes].sort(),
      personIds: [...personIds].sort(),
    });
  }
  return list;
}

function describeConflict(kind, extra) {
  const base = { kind, ...extra };
  switch (kind) {
    case 'calendar-overlap':
      base.message = `房间 ${extra.roomId} 监测位在该时段已被 ${extra.with.join('、')} 占用`;
      base.suggestion = 'merge-or-reschedule';
      break;
    case 'topic-overlap':
      base.message = `与 ${extra.with.join('、')} 的材料主题（${extra.topics.join('、')}）重合，建议组成联合检查`;
      base.suggestion = 'merge';
      break;
    case 'rolling-quota':
      base.message = extra.reason === 'outside-availability'
        ? `人员 ${extra.personId} 在该时段没有登记的可用时间（或尚未登记）`
        : `人员 ${extra.personId} 已参加 ${extra.with.join('、')} 的重合窗口，不能重复排程`;
      base.suggestion = extra.reason === 'outside-availability' ? 'reschedule-or-register-availability' : 'merge-or-reschedule';
      break;
    case 'protected-period':
      base.message = `窗口落在保护时段 ${extra.periodId} 内（${extra.reason || '现场封禁'}）`;
      base.suggestion = 'reschedule';
      break;
    default:
      base.message = kind;
  }
  return base;
}

// ---------------------------------------------------------------------------
// 冲突识别。candidate: { selfRequestId, groupRequestIds, roomId, start, end,
// topicCodes, personIds }；groupRequestIds 内的占用方视为同组（用于提案复检）。
// ---------------------------------------------------------------------------

export function evaluateWindow(state, candidate) {
  const conflicts = [];
  const room = state.rooms.get(candidate.roomId);
  const capacity = room ? room.capacity : 1;
  const group = new Set(candidate.groupRequestIds || []);
  if (candidate.selfRequestId) group.add(candidate.selfRequestId);

  const others = occupants(state).filter((o) => !o.requestIds.some((id) => group.has(id)));
  const overlapping = others.filter((o) => overlaps(o, candidate));

  // 保护时段：全局（roomId 为空）或同房间。
  for (const period of state.protectedPeriods.values()) {
    const roomMatch = !period.roomId || period.roomId === candidate.roomId;
    if (roomMatch && overlaps(period, candidate)) {
      conflicts.push(describeConflict('protected-period', {
        periodId: period.periodId,
        reason: period.reason,
        roomId: period.roomId,
      }));
    }
  }

  // 房间监测能力：同房间重合占用位 + 本申请 1 位不得超过容量。
  const sameRoom = overlapping.filter((o) => o.roomId === candidate.roomId);
  if (sameRoom.length + 1 > capacity) {
    for (const o of sameRoom) {
      conflicts.push(describeConflict('calendar-overlap', {
        roomId: candidate.roomId,
        capacity,
        with: o.requestIds,
        occupant: o.kind,
      }));
    }
  }

  for (const o of overlapping) {
    const topics = intersect(candidate.topicCodes, o.topicCodes);
    if (topics.length) {
      conflicts.push(describeConflict('topic-overlap', { with: o.requestIds, topics }));
    }
    const people = intersect(candidate.personIds, o.personIds);
    for (const personId of people) {
      conflicts.push(describeConflict('rolling-quota', {
        personId,
        with: o.requestIds,
        reason: 'already-scheduled',
      }));
    }
  }

  // 人员可用性登记：必须有人能覆盖整个窗口。
  for (const personId of candidate.personIds) {
    const person = state.personnel.get(personId);
    const covered = person && person.windows.some((w) => covers(w, candidate.start, candidate.end));
    if (!covered) {
      conflicts.push(describeConflict('rolling-quota', { personId, reason: 'outside-availability' }));
    }
  }

  return conflicts;
}

// 在未来 14 天内按 30 分钟步进寻找无冲突备选窗口。
export function findAlternatives(state, candidate, now, { horizonDays = 14, stepMs = 30 * 60 * 1000, max = 6 } = {}) {
  const duration = candidate.end - candidate.start;
  const horizon = now + horizonDays * 24 * 60 * 60 * 1000;
  let cursor = Math.max(now, candidate.start);
  if (cursor % stepMs) cursor = Math.ceil(cursor / stepMs) * stepMs;
  const found = [];
  for (let t = cursor; t + duration <= horizon && found.length < max; t += stepMs) {
    const probe = { ...candidate, start: t, end: t + duration };
    if (!evaluateWindow(state, probe).length) {
      found.push({
        roomId: probe.roomId,
        startsAt: toUtc(t),
        endsAt: toUtc(t + duration),
        startEpoch: t,
        endEpoch: t + duration,
      });
    }
  }
  return found;
}

// 综合判定：无冲突即可持有窗口；可合并或存在备选 → 协商；否则受阻。
export function decide(state, rec, window, now) {
  const candidate = {
    selfRequestId: rec.requestId,
    roomId: window.roomId || rec.preferredRoomId,
    start: window.start,
    end: window.end,
    topicCodes: rec.topicCodes,
    personIds: rec.personIds,
  };
  const conflicts = evaluateWindow(state, candidate);
  if (!conflicts.length) {
    return { outcome: 'held', conflicts: [], alternatives: [], evaluatedAt: now };
  }
  const alternatives = findAlternatives(state, candidate, now);
  const mergeable = conflicts.some((c) => c.kind === 'topic-overlap' || c.kind === 'calendar-overlap');
  const outcome = mergeable || alternatives.length ? 'negotiating' : 'blocked';
  return { outcome, conflicts, alternatives, evaluatedAt: now };
}

// ---------------------------------------------------------------------------
// 人员可用性：登记窗口覆盖整个区间，且没有被活跃占用占用。
// ---------------------------------------------------------------------------

export function availabilityOf(state, { start, end, personIds = null }) {
  const scoped = personIds
    ? personIds.map((id) => state.personnel.get(id)).filter(Boolean)
    : [...state.personnel.values()];
  const active = occupants(state).filter((o) => overlaps(o, { start, end }));
  const available = [];
  const busy = [];
  const outside = [];
  for (const person of scoped) {
    const covered = person.windows.some((w) => covers(w, start, end));
    const holder = active.find((o) => o.personIds.includes(person.personId));
    if (!covered) {
      outside.push({ personId: person.personId, displayName: person.displayName, reason: 'outside-availability' });
    } else if (holder) {
      busy.push({ personId: person.personId, displayName: person.displayName, requestIds: holder.requestIds, kind: holder.kind });
    } else {
      available.push({ personId: person.personId, displayName: person.displayName });
    }
  }
  const requestedButUnknown = (personIds || []).filter((id) => !state.personnel.has(id));
  for (const personId of requestedButUnknown) {
    outside.push({ personId, displayName: null, reason: 'not-registered' });
  }
  return {
    total: scoped.length + requestedButUnknown.length,
    availableCount: available.length,
    available,
    busy,
    unavailable: outside,
  };
}

// 房间监测位在指定区间的占用情况。
export function roomLoad(state, roomId, start, end) {
  const room = state.rooms.get(roomId);
  const capacity = room ? room.capacity : 1;
  const slots = occupants(state)
    .filter((o) => o.roomId === roomId && overlaps(o, { start, end }))
    .map((o) => ({ kind: o.kind, id: o.id, requestIds: o.requestIds, start: o.start, end: o.end }));
  return { roomId, capacity, used: slots.length, free: Math.max(0, capacity - slots.length), slots };
}
