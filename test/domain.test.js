import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  overlaps,
  toInstant,
  peakUsage,
  intervalsOverlap,
  reserve,
  detectConflicts,
} from '../src/domain.js';

const incident = JSON.parse(await readFile(new URL('../fixtures/incident.json', import.meta.url)));

test('跨时区时间归一到同一时刻（事故样例：夏令时切换夜跨午夜）', () => {
  // 2026-10-25T23:30:00+02:00 → 21:30Z；2026-10-26T01:30:00+01:00 → 次日 00:30Z。
  // 墙上时间看似 2 小时，实际持续 3 小时。
  assert.equal(toInstant(incident.startsAt), Date.parse('2026-10-25T21:30:00Z'));
  assert.equal(toInstant(incident.endsAt), Date.parse('2026-10-26T00:30:00Z'));
});

test('不同偏移量表示的窗口按同一时刻判定重叠', () => {
  // 23:00+01:00 – 02:00+01:00，即 22:00Z – 01:00Z，与事故窗口相交。
  const other = { startsAt: '2026-10-25T23:00:00+01:00', endsAt: '2026-10-26T02:00:00+01:00' };
  assert.equal(overlaps(incident, other), true);
  // 旧实现按墙上时间比较会漏判：UTC 下 21:30–22:00 与事故窗口相交，但墙上 21:30 < 23:30。
  const utcOnly = { startsAt: '2026-10-25T21:30:00Z', endsAt: '2026-10-25T22:00:00Z' };
  assert.equal(overlaps(incident, utcOnly), true);
});

test('首尾相接不算重叠，可以连续排班', () => {
  const after = { startsAt: '2026-10-26T00:30:00Z', endsAt: '2026-10-26T02:00:00Z' };
  assert.equal(overlaps(incident, after), false);
  const before = { startsAt: '2026-10-25T20:30:00Z', endsAt: '2026-10-25T21:30:00Z' };
  assert.equal(overlaps(incident, before), false);
  // 偏移量写法不同但表示相接的同一时刻，同样不算重叠。
  const adjacentLocal = { startsAt: '2026-10-26T01:30:00+01:00', endsAt: '2026-10-26T03:00:00+01:00' };
  assert.equal(overlaps(incident, adjacentLocal), false);
});

test('缺少偏移量的时间被拒绝', () => {
  assert.throws(() => toInstant('2026-10-25T23:30:00'), /偏移量/);
  assert.throws(() => toInstant('2026-10-25'), /偏移量/);
  assert.throws(() => toInstant('not-a-time+02:00'), /合法/);
});

test('半开区间边界', () => {
  assert.equal(intervalsOverlap(0, 10, 10, 20), false);
  assert.equal(intervalsOverlap(0, 11, 10, 20), true);
  assert.equal(intervalsOverlap(10, 20, 0, 10), false);
});

test('峰值占用：相接窗口不叠加，交错窗口取峰值', () => {
  const locks = [
    { startMs: 0, endMs: 10, personnel: 2 },
    { startMs: 10, endMs: 20, personnel: 1 },
    { startMs: 5, endMs: 15, personnel: 1 },
  ];
  assert.equal(peakUsage(locks, 0, 20), 3);
  assert.equal(peakUsage(locks, 10, 20), 2);
  assert.equal(peakUsage(locks, 30, 40), 0);
});

test('reserve 幂等：同一 commandId 重复到达只扣减一次', () => {
  const state = { seen: [], capacity: 2, requests: new Map() };
  reserve(state, { commandId: 'c1', requestId: 'r1' });
  reserve(state, { commandId: 'c1', requestId: 'r1' });
  assert.equal(state.capacity, 1);
  assert.equal(state.requests.size, 1);
});

test('冲突识别：主题重合优先于单纯时段重合', () => {
  const candidate = { startMs: 0, endMs: 10, topicCodes: ['dew-point'], roomId: 'default' };
  const holders = [
    { requestId: 'A', startMs: 5, endMs: 15, topicCodes: ['dew-point'], roomId: 'default' },
    { requestId: 'B', startMs: 5, endMs: 15, topicCodes: ['particle'], roomId: 'default' },
    { requestId: 'C', startMs: 5, endMs: 15, topicCodes: ['dew-point'], roomId: 'room-2' },
  ];
  const conflicts = detectConflicts({ candidate, holders });
  assert.deepEqual(conflicts.map(c => [c.kind, c.withRequestId]), [
    ['topic-overlap', 'A'],
    ['calendar-overlap', 'B'],
  ]);
});
