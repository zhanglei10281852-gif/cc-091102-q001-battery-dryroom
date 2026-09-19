import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInstant, overlaps, isAdjacent, evaluateWindow, findAlternatives,
  availabilityOf, roomLoad, ApiError,
} from '../src/domain.js';
import { createInitialState, applyEvent } from '../src/store.js';

// -- 构造助手 ----------------------------------------------------------------

function bootState(setup) {
  const state = createInitialState();
  const at = (n) => new Date(n).toISOString();
  let seq = 0;
  const ev = (type, data) => applyEvent(state, { seq: ++seq, at: at(1_800_000_000_000 + seq), type, data });
  ev('room-registered', { roomId: 'DRY-A', displayName: '一号干燥间', capacity: 1 });
  ev('room-registered', { roomId: 'DRY-B', displayName: '二号干燥间', capacity: 2 });
  setup?.(ev);
  return state;
}

const win = (start, end, roomId = 'DRY-A') => ({ roomId, start, end });

const T = {
  // 2026-10-25 这一周的若干绝对时刻（epoch ms）
  d25_22: Date.parse('2026-10-25T22:00:00+02:00'),
  d25_23: Date.parse('2026-10-25T23:00:00+02:00'),
  d26_00: Date.parse('2026-10-26T00:00:00+02:00'),
  d26_01: Date.parse('2026-10-26T01:00:00+02:00'),
  d26_02: Date.parse('2026-10-26T02:00:00+02:00'),
};

// -- 时间归一 ----------------------------------------------------------------

test('parseInstant：接受各种偏移量并归一到同一 epoch', () => {
  // 23:30+02:00 与 21:30Z 是同一时刻；01:30+01:00（跨午夜）= 00:30Z
  assert.equal(parseInstant('2026-10-25T23:30:00+02:00'), Date.parse('2026-10-25T21:30:00Z'));
  assert.equal(parseInstant('2026-10-26T01:30:00+01:00'), Date.parse('2026-10-26T00:30:00Z'));
  assert.equal(parseInstant('2026-10-25T21:30:00Z'), Date.parse('2026-10-25T21:30:00Z'));
});

test('parseInstant：拒绝无偏移量的裸时间', () => {
  assert.throws(() => parseInstant('2026-10-25T23:30:00'), (e) => e instanceof ApiError && e.code === 'missing-offset');
  assert.throws(() => parseInstant('not-a-date'), ApiError);
});

test('半开区间：跨午夜 DST 风格的墙上字符串不会误判，首尾相接不算重合', () => {
  // 事故样例：+02:00 到次日 +01:00（跨夏令时切换夜），时长 3 小时而非墙上的 2 小时
  const a = { start: Date.parse('2026-10-25T23:30:00+02:00'), end: Date.parse('2026-10-26T01:30:00+01:00') };
  assert.equal(a.end - a.start, 3 * 3600_000);

  // 旧实现按 slice(0,19) 比较："2026-10-25T23:30" < "2026-10-26T01:30" 看似成立，
  // 但对 +09:00 与 +01:00 的两个窗口会把先后顺序排反。归一后正确：
  const tokyo = { start: Date.parse('2026-10-26T09:00:00+09:00'), end: Date.parse('2026-10-26T10:00:00+09:00') };
  const berlin = { start: Date.parse('2026-10-26T01:00:00+01:00'), end: Date.parse('2026-10-26T02:00:00+01:00') };
  assert.equal(tokyo.start, berlin.start); // 同一绝对时刻
  assert.ok(overlaps(tokyo, berlin));

  const first = win(T.d25_23, T.d26_01);
  const second = win(T.d26_01, T.d26_02);
  assert.equal(overlaps(first, second), false);
  assert.ok(isAdjacent(first, second));
  // 反向相接同样成立
  assert.ok(isAdjacent(second, first));
  // 哪怕重叠 1 毫秒也算重合
  assert.ok(overlaps(win(T.d25_23, T.d26_01 + 1), second));
});

// -- 冲突识别 ----------------------------------------------------------------

test('同房间容量为 1 时，重合窗口产生 calendar-overlap', () => {
  const state = bootState((ev) => {
    ev('person-registered', { personId: 'P1' });
    ev('availability-added', { personId: 'P1', start: T.d25_22, end: T.d26_02 });
    ev('request-submitted', { requestId: 'R1', topicCodes: ['dew-point'], personIds: ['P1'], preferredRoomId: 'DRY-A', preferredWindow: win(T.d25_23, T.d26_01) });
    ev('request-held', { requestId: 'R1', window: win(T.d25_23, T.d26_01, 'DRY-A'), holdExpiresAt: T.d26_02 });
  });
  const conflicts = evaluateWindow(state, {
    selfRequestId: 'R2', roomId: 'DRY-A', start: T.d26_00, end: T.d26_02,
    topicCodes: ['particle'], personIds: ['P1'],
  });
  const kinds = conflicts.map((c) => c.kind).sort();
  assert.ok(kinds.includes('calendar-overlap'));
  assert.ok(kinds.includes('rolling-quota')); // P1 同时段重复
  assert.ok(!kinds.includes('topic-overlap'));
});

test('容量为 2 的房间允许第二个重合监测位，第三个才冲突', () => {
  const state = bootState((ev) => {
    ev('person-registered', { personId: 'P1' });
    ev('person-registered', { personId: 'P2' });
    ev('person-registered', { personId: 'P3' });
    for (const p of ['P1', 'P2', 'P3']) ev('availability-added', { personId: p, start: T.d25_22, end: T.d26_02 });
    ev('request-submitted', { requestId: 'R1', topicCodes: ['x'], personIds: ['P1'], preferredRoomId: 'DRY-B', preferredWindow: win(T.d25_23, T.d26_01, 'DRY-B') });
    ev('request-approved', { requestId: 'R1', window: win(T.d25_23, T.d26_01, 'DRY-B') });
  });
  const second = evaluateWindow(state, {
    selfRequestId: 'R2', roomId: 'DRY-B', start: T.d26_00, end: T.d26_01,
    topicCodes: ['x'], personIds: ['P2'],
  });
  assert.deepEqual(second.map((c) => c.kind), ['topic-overlap']); // 容量未满；主题重合建议合并

  // R2 也获批后第三个位才触发容量冲突
  applyEvent(state, { seq: 98, at: new Date().toISOString(), type: 'request-submitted', data: { requestId: 'R2', topicCodes: ['x'], personIds: ['P2'], preferredRoomId: 'DRY-B', preferredWindow: win(T.d26_00, T.d26_01, 'DRY-B') } });
  applyEvent(state, { seq: 99, at: new Date().toISOString(), type: 'request-approved', data: { requestId: 'R2', window: win(T.d26_00, T.d26_01, 'DRY-B') } });
  const third = evaluateWindow(state, {
    selfRequestId: 'R3', roomId: 'DRY-B', start: T.d26_00, end: T.d26_01,
    topicCodes: ['y'], personIds: ['P3'],
  });
  assert.ok(third.some((c) => c.kind === 'calendar-overlap'));
});

test('topic-overlap 只在主题相交且时间重合时出现', () => {
  const state = bootState((ev) => {
    ev('person-registered', { personId: 'P1' });
    ev('person-registered', { personId: 'P2' });
    for (const p of ['P1', 'P2']) ev('availability-added', { personId: p, start: T.d25_22, end: T.d26_02 });
    ev('request-submitted', { requestId: 'R1', topicCodes: ['dew-point', 'particle'], personIds: ['P1'], preferredRoomId: 'DRY-A', preferredWindow: win(T.d25_23, T.d26_01) });
    ev('request-approved', { requestId: 'R1', window: win(T.d25_23, T.d26_01, 'DRY-A') });
  });
  // 不同房间 → 无容量冲突，但主题重合仍提示合并
  const otherRoom = evaluateWindow(state, {
    selfRequestId: 'R9', roomId: 'DRY-B', start: T.d25_23 + 1000, end: T.d26_00,
    topicCodes: ['particle'], personIds: ['P2'],
  });
  assert.deepEqual(otherRoom.map((c) => c.kind), ['topic-overlap']);
  // 时间不重合（相接）→ 无冲突
  const adjacent = evaluateWindow(state, {
    selfRequestId: 'R9', roomId: 'DRY-A', start: T.d26_01, end: T.d26_02,
    topicCodes: ['particle'], personIds: ['P2'],
  });
  assert.deepEqual(adjacent, []);
});

test('protected-period：全局封禁与房间封禁均被识别', () => {
  const state = bootState((ev) => {
    ev('person-registered', { personId: 'P1' });
    ev('availability-added', { personId: 'P1', start: T.d25_22, end: T.d26_02 });
    ev('protected-period-added', { periodId: 'BAN-1', start: T.d25_23, end: T.d26_00, reason: '产线吊装' });
  });
  const conflicts = evaluateWindow(state, {
    selfRequestId: 'R1', roomId: 'DRY-A', start: T.d25_23, end: T.d26_00,
    topicCodes: ['x'], personIds: ['P1'],
  });
  assert.ok(conflicts.some((c) => c.kind === 'protected-period'));
  // 相接不冲突
  assert.deepEqual(evaluateWindow(state, {
    selfRequestId: 'R2', roomId: 'DRY-A', start: T.d26_00, end: T.d26_01,
    topicCodes: ['x'], personIds: ['P1'],
  }), []);
});

test('人员未登记可用时间 → rolling-quota(outside-availability)；跨偏移量但同一绝对时刻可用', () => {
  const state = bootState((ev) => {
    ev('person-registered', { personId: 'P1' });
  });
  const conflicts = evaluateWindow(state, {
    selfRequestId: 'R1', roomId: 'DRY-A', start: T.d26_00, end: T.d26_01,
    topicCodes: ['x'], personIds: ['P1'],
  });
  assert.ok(conflicts.some((c) => c.kind === 'rolling-quota' && c.reason === 'outside-availability'));

  // 用 +09:00 表达的可用区间覆盖 +01:00 表达的窗口（同一绝对时刻）
  applyEvent(state, { seq: 50, at: new Date().toISOString(), type: 'availability-added',
    data: { personId: 'P1', start: Date.parse('2026-10-26T09:00:00+09:00'), end: Date.parse('2026-10-26T10:00:00+09:00') } });
  const ok = evaluateWindow(state, {
    selfRequestId: 'R1', roomId: 'DRY-A', start: Date.parse('2026-10-26T01:30:00+01:00'), end: Date.parse('2026-10-26T02:00:00+01:00'),
    topicCodes: ['x'], personIds: ['P1'],
  });
  assert.deepEqual(ok, []);
});

// -- 备选窗口与可用性查询 -----------------------------------------------------

test('findAlternatives 跳过被占用与保护时段，返回相接但不重合的窗口', () => {
  const state = bootState((ev) => {
    ev('person-registered', { personId: 'P1' });
    ev('availability-added', { personId: 'P1', start: T.d25_22, end: T.d26_02 + 14 * 3600_000 });
    ev('request-submitted', { requestId: 'R1', topicCodes: ['x'], personIds: ['P1'], preferredRoomId: 'DRY-A', preferredWindow: win(T.d25_23, T.d26_01) });
    ev('request-approved', { requestId: 'R1', window: win(T.d25_23, T.d26_01, 'DRY-A') });
  });
  const alts = findAlternatives(state, {
    roomId: 'DRY-A', start: T.d25_23, end: T.d26_01, topicCodes: ['x'], personIds: ['P1'],
  }, T.d25_23 - 3600_000);
  assert.ok(alts.length > 0);
  // 第一备选应从占用窗口结束处相接开始
  assert.equal(alts[0].startEpoch, T.d26_01);
});

test('availabilityOf：并发语义下准确清点可用人数（忙/不可用/未登记分开）', () => {
  const state = bootState((ev) => {
    ev('person-registered', { personId: 'P1', displayName: '甲' });
    ev('person-registered', { personId: 'P2', displayName: '乙' });
    ev('person-registered', { personId: 'P3', displayName: '丙' });
    ev('availability-added', { personId: 'P1', start: T.d25_22, end: T.d26_02 });
    ev('availability-added', { personId: 'P2', start: T.d25_22, end: T.d26_02 });
    // P3 可用时间不覆盖
    ev('availability-added', { personId: 'P3', start: T.d26_01, end: T.d26_02 });
    ev('request-submitted', { requestId: 'R1', topicCodes: ['x'], personIds: ['P1'], preferredRoomId: 'DRY-A', preferredWindow: win(T.d25_23, T.d26_01) });
    ev('request-approved', { requestId: 'R1', window: win(T.d25_23, T.d26_01, 'DRY-A') });
  });
  const result = availabilityOf(state, { start: T.d26_00, end: T.d26_01 });
  assert.equal(result.total, 3);
  assert.equal(result.availableCount, 1); // 只有 P2
  assert.deepEqual(result.available.map((p) => p.personId), ['P2']);
  assert.deepEqual(result.busy.map((p) => p.personId), ['P1']);
  assert.deepEqual(result.unavailable.map((p) => p.personId), ['P3']);

  // 只查指定人员，含未登记者
  const scoped = availabilityOf(state, { start: T.d26_00, end: T.d26_01, personIds: ['P2', 'GHOST'] });
  assert.equal(scoped.availableCount, 1);
  assert.equal(scoped.unavailable[0].personId, 'GHOST');
});

test('roomLoad：反映监测位占用与余量', () => {
  const state = bootState((ev) => {
    ev('person-registered', { personId: 'P1' });
    ev('availability-added', { personId: 'P1', start: T.d25_22, end: T.d26_02 });
    ev('request-submitted', { requestId: 'R1', topicCodes: ['x'], personIds: ['P1'], preferredRoomId: 'DRY-B', preferredWindow: win(T.d25_23, T.d26_01, 'DRY-B') });
    ev('request-approved', { requestId: 'R1', window: win(T.d25_23, T.d26_01, 'DRY-B') });
  });
  const load = roomLoad(state, 'DRY-B', T.d25_23, T.d26_01);
  assert.equal(load.capacity, 2);
  assert.equal(load.used, 1);
  assert.equal(load.free, 1);
});
