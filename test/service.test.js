import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InspectionService } from '../src/service.js';

const T0 = Date.parse('2026-10-20T00:00:00Z');

async function makeService(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dryroom-'));
  const clock = { now: T0 };
  const service = await InspectionService.open({
    dataDir: dir,
    now: () => clock.now,
    totalPersonnel: 2,
    holdTtlMs: 60_000,
    ...options,
  });
  return {
    service,
    dir,
    setNow: ms => { clock.now = ms; },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test('受理 → 确认 → 批准 全流程，确认后锁定监测能力', async () => {
  const { service, cleanup } = await makeService();
  try {
    const submitted = await service.submitRequest({
      topicCodes: ['dew-point'],
      startsAt: '2026-10-25T20:00:00Z',
      endsAt: '2026-10-25T21:00:00Z',
      commandId: 'cmd-submit-1',
    });
    assert.equal(submitted.status, 201);
    assert.equal(submitted.body.request.state, 'submitted');
    const id = submitted.body.request.requestId;

    // 确认前不占用人员
    let cap = await service.getCapacity({ at: '2026-10-25T20:30:00Z' });
    assert.equal(cap.body.locked, 0);

    const confirmed = await service.confirmRequest(id, { commandId: 'cmd-confirm-1' });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.requests[0].state, 'window-held');
    assert.ok(confirmed.body.groupId);

    cap = await service.getCapacity({ at: '2026-10-25T20:30:00Z' });
    assert.equal(cap.body.locked, 1);
    assert.equal(cap.body.available, 1);

    const approved = await service.approveRequest(id, { commandId: 'cmd-approve-1' });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.request.state, 'approved');

    const detail = await service.getRequest(id);
    assert.deepEqual(
      detail.body.request.reasons.map(r => r.code),
      ['submitted', 'confirmed', 'approved'],
    );
  } finally {
    await cleanup();
  }
});

test('同一操作重复到达只生效一次（提交与确认均幂等）', async () => {
  const { service, cleanup } = await makeService();
  try {
    const first = await service.submitRequest({
      topicCodes: ['dew-point'],
      startsAt: '2026-10-25T20:00:00Z',
      endsAt: '2026-10-25T21:00:00Z',
      commandId: 'cmd-dup',
    });
    const second = await service.submitRequest({
      topicCodes: ['dew-point'],
      startsAt: '2026-10-25T20:00:00Z',
      endsAt: '2026-10-25T21:00:00Z',
      commandId: 'cmd-dup',
    });
    assert.deepEqual(second, first);
    const list = await service.listRequests();
    assert.equal(list.body.requests.length, 1);

    const id = first.body.request.requestId;
    const confirm1 = await service.confirmRequest(id, { commandId: 'cmd-dup-confirm' });
    const confirm2 = await service.confirmRequest(id, { commandId: 'cmd-dup-confirm' });
    assert.deepEqual(confirm2, confirm1);
    const cap = await service.getCapacity({ at: '2026-10-25T20:30:00Z' });
    assert.equal(cap.body.locked, 1); // 没有重复扣减
  } finally {
    await cleanup();
  }
});

test('材料主题重合 → 协商 → 多方合并确认，组内只占一份人员', async () => {
  const { service, cleanup } = await makeService();
  try {
    const a = await service.submitRequest({
      topicCodes: ['dew-point'],
      startsAt: '2026-10-25T20:00:00Z',
      endsAt: '2026-10-25T21:00:00Z',
      commandId: 'cmd-a',
    });
    const idA = a.body.request.requestId;
    await service.confirmRequest(idA, { commandId: 'cmd-a-confirm' });

    // B 与 A 主题重合且时段相交 → 受理即进入协商，并记录原因
    const b = await service.submitRequest({
      topicCodes: ['dew-point', 'particle'],
      startsAt: '2026-10-25T20:30:00Z',
      endsAt: '2026-10-25T21:30:00Z',
      commandId: 'cmd-b',
    });
    const idB = b.body.request.requestId;
    assert.equal(b.body.request.state, 'negotiating');
    assert.equal(b.body.request.conflicts[0].kind, 'topic-overlap');
    assert.equal(b.body.request.conflicts[0].withRequestId, idA);

    // 单独确认 B 会被冲突拦下
    const blocked = await service.confirmRequest(idB, { commandId: 'cmd-b-alone' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'conflict');

    // 多方合并确认：B 拉上 A 组成联合检查组
    const merged = await service.confirmRequest(idB, { commandId: 'cmd-b-merge', mergeWith: [idA] });
    assert.equal(merged.status, 200);
    assert.equal(merged.body.merged, true);
    const states = Object.fromEntries(merged.body.requests.map(r => [r.requestId, r]));
    assert.equal(states[idA].state, 'window-held');
    assert.equal(states[idB].state, 'window-held');
    assert.equal(states[idA].groupId, states[idB].groupId);
    // 合并窗口覆盖双方：20:00Z – 21:30Z
    assert.equal(states[idA].startsAtUtc, '2026-10-25T20:00:00.000Z');
    assert.equal(states[idA].endsAtUtc, '2026-10-25T21:30:00.000Z');

    // 联合检查组只占一份人员
    const cap = await service.getCapacity({ at: '2026-10-25T21:00:00Z' });
    assert.equal(cap.body.locked, 1);

    // 受阻与获准的原因都可查询
    const detail = await service.getRequest(idB);
    const codes = detail.body.request.reasons.map(r => r.code);
    assert.ok(codes.includes('topic-overlap'));
    assert.ok(codes.includes('merged'));
    assert.ok(codes.includes('confirmed'));
  } finally {
    await cleanup();
  }
});

test('时段重合但主题不同 → calendar-overlap，改期后可确认', async () => {
  const { service, cleanup } = await makeService();
  try {
    const a = await service.submitRequest({
      topicCodes: ['dew-point'],
      startsAt: '2026-10-25T20:00:00Z',
      endsAt: '2026-10-25T21:00:00Z',
      commandId: 'cmd-cal-a',
    });
    const idA = a.body.request.requestId;
    await service.confirmRequest(idA, { commandId: 'cmd-cal-a-confirm' });

    const b = await service.submitRequest({
      topicCodes: ['particle'],
      startsAt: '2026-10-25T20:30:00Z',
      endsAt: '2026-10-25T21:30:00Z',
      commandId: 'cmd-cal-b',
    });
    const idB = b.body.request.requestId;
    assert.equal(b.body.request.state, 'negotiating');
    assert.equal(b.body.request.conflicts[0].kind, 'calendar-overlap');

    const moved = await service.rescheduleRequest(idB, {
      startsAt: '2026-10-25T21:00:00Z',
      endsAt: '2026-10-25T22:00:00Z',
      commandId: 'cmd-cal-b-move',
    });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.request.state, 'window-held');
  } finally {
    await cleanup();
  }
});

test('不同干燥间的相同时段互不冲突', async () => {
  const { service, cleanup } = await makeService();
  try {
    const a = await service.submitRequest({
      topicCodes: ['dew-point'],
      roomId: 'room-1',
      startsAt: '2026-10-25T20:00:00Z',
      endsAt: '2026-10-25T21:00:00Z',
      commandId: 'cmd-room-a',
    });
    await service.confirmRequest(a.body.request.requestId, { commandId: 'cmd-room-a-confirm' });
    const b = await service.submitRequest({
      topicCodes: ['dew-point'],
      roomId: 'room-2',
      startsAt: '2026-10-25T20:00:00Z',
      endsAt: '2026-10-25T21:00:00Z',
      commandId: 'cmd-room-b',
    });
    assert.equal(b.body.request.state, 'submitted');
  } finally {
    await cleanup();
  }
});

test('容量耗尽被拒；首尾相接的连续排班可以复用人员', async () => {
  const { service, cleanup } = await makeService({ totalPersonnel: 1 });
  try {
    const a = await service.submitRequest({
      topicCodes: ['dew-point'],
      roomId: 'room-1',
      startsAt: '2026-10-25T20:00:00Z',
      endsAt: '2026-10-25T21:00:00Z',
      commandId: 'cmd-cap-a',
    });
    await service.confirmRequest(a.body.request.requestId, { commandId: 'cmd-cap-a-confirm' });

    // 另一干燥间同时段：无日历冲突，但人员不够
    const b = await service.submitRequest({
      topicCodes: ['particle'],
      roomId: 'room-2',
      startsAt: '2026-10-25T20:30:00Z',
      endsAt: '2026-10-25T21:30:00Z',
      commandId: 'cmd-cap-b',
    });
    const idB = b.body.request.requestId;
    assert.equal(b.body.request.state, 'submitted');
    const blocked = await service.confirmRequest(idB, { commandId: 'cmd-cap-b-confirm' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'capacity-exhausted');
    const detail = await service.getRequest(idB);
    assert.ok(detail.body.request.reasons.some(r => r.code === 'capacity-exhausted'));

    // 与 A 首尾相接：21:00Z 开始，半开区间下不重叠，人员可复用
    const c = await service.submitRequest({
      topicCodes: ['particle'],
      roomId: 'room-2',
      startsAt: '2026-10-25T21:00:00Z',
      endsAt: '2026-10-25T22:00:00Z',
      commandId: 'cmd-cap-c',
    });
    const idC = c.body.request.requestId;
    const ok = await service.confirmRequest(idC, { commandId: 'cmd-cap-c-confirm' });
    assert.equal(ok.status, 200);
    const cap = await service.getCapacity({ at: '2026-10-25T21:00:00Z' });
    assert.equal(cap.body.locked, 1);
  } finally {
    await cleanup();
  }
});

test('滚动配额与保护时段阻止受理', async () => {
  const { service, cleanup } = await makeService({
    totalPersonnel: 5,
    rollingQuota: { max: 1, windowMs: 24 * 3600 * 1000 },
    protectedPeriods: [{ startsAt: '2026-11-01T00:00:00Z', endsAt: '2026-11-02T00:00:00Z', reason: '设备维护' }],
  });
  try {
    const a = await service.submitRequest({
      topicCodes: ['dew-point'],
      startsAt: '2026-10-25T20:00:00Z',
      endsAt: '2026-10-25T21:00:00Z',
      commandId: 'cmd-quota-a',
    });
    await service.confirmRequest(a.body.request.requestId, { commandId: 'cmd-quota-a-confirm' });

    // 24 小时滚动窗口内已有检查 → rolling-quota
    const b = await service.submitRequest({
      topicCodes: ['particle'],
      startsAt: '2026-10-26T10:00:00Z',
      endsAt: '2026-10-26T11:00:00Z',
      commandId: 'cmd-quota-b',
    });
    assert.equal(b.body.request.state, 'negotiating');
    assert.equal(b.body.request.conflicts[0].kind, 'rolling-quota');

    // 超出滚动窗口则不受影响
    const c = await service.submitRequest({
      topicCodes: ['particle'],
      startsAt: '2026-10-27T21:00:00Z',
      endsAt: '2026-10-27T22:00:00Z',
      commandId: 'cmd-quota-c',
    });
    assert.equal(c.body.request.state, 'submitted');

    // 落入保护时段 → protected-period
    const d = await service.submitRequest({
      topicCodes: ['particle'],
      startsAt: '2026-11-01T12:00:00Z',
      endsAt: '2026-11-01T13:00:00Z',
      commandId: 'cmd-quota-d',
    });
    assert.equal(d.body.request.state, 'negotiating');
    assert.equal(d.body.request.conflicts[0].kind, 'protected-period');
  } finally {
    await cleanup();
  }
});

test('取消与过期都会释放占用，不留幽灵', async () => {
  const { service, setNow, cleanup } = await makeService({ totalPersonnel: 1 });
  try {
    const a = await service.submitRequest({
      topicCodes: ['dew-point'],
      roomId: 'room-1',
      startsAt: '2026-10-25T20:00:00Z',
      endsAt: '2026-10-25T21:00:00Z',
      commandId: 'cmd-rel-a',
    });
    const idA = a.body.request.requestId;
    await service.confirmRequest(idA, { commandId: 'cmd-rel-a-confirm' });

    const cancelled = await service.cancelRequest(idA, { commandId: 'cmd-rel-a-cancel' });
    assert.equal(cancelled.body.request.state, 'cancelled');
    let cap = await service.getCapacity({ at: '2026-10-25T20:30:00Z' });
    assert.equal(cap.body.locked, 0);

    // 过期：保留 60 秒未批准 → expired
    const b = await service.submitRequest({
      topicCodes: ['particle'],
      roomId: 'room-1',
      startsAt: '2026-10-25T20:00:00Z',
      endsAt: '2026-10-25T21:00:00Z',
      commandId: 'cmd-rel-b',
    });
    const idB = b.body.request.requestId;
    await service.confirmRequest(idB, { commandId: 'cmd-rel-b-confirm' });
    cap = await service.getCapacity({ at: '2026-10-25T20:30:00Z' });
    assert.equal(cap.body.locked, 1);

    setNow(T0 + 120_000);
    const detail = await service.getRequest(idB); // 查询触发惰性清扫
    assert.equal(detail.body.request.state, 'expired');
    assert.ok(detail.body.request.reasons.some(r => r.code === 'expired'));
    cap = await service.getCapacity({ at: '2026-10-25T20:30:00Z' });
    assert.equal(cap.body.locked, 0);
  } finally {
    await cleanup();
  }
});

test('改期释放原窗口占用；改期冲突时原窗口保持不变', async () => {
  const { service, cleanup } = await makeService({ totalPersonnel: 1 });
  try {
    const a = await service.submitRequest({
      topicCodes: ['dew-point'],
      roomId: 'room-1',
      startsAt: '2026-10-25T20:00:00Z',
      endsAt: '2026-10-25T21:00:00Z',
      commandId: 'cmd-mv-a',
    });
    const idA = a.body.request.requestId;
    await service.confirmRequest(idA, { commandId: 'cmd-mv-a-confirm' });

    // 改期到 22:00–23:00
    const moved = await service.rescheduleRequest(idA, {
      startsAt: '2026-10-25T22:00:00Z',
      endsAt: '2026-10-25T23:00:00Z',
      commandId: 'cmd-mv-a-1',
    });
    assert.equal(moved.status, 200);
    let cap = await service.getCapacity({ at: '2026-10-25T20:30:00Z' });
    assert.equal(cap.body.locked, 0); // 原窗口已释放
    cap = await service.getCapacity({ at: '2026-10-25T22:30:00Z' });
    assert.equal(cap.body.locked, 1);

    // 原窗口可以立刻被别人使用（无幽灵占用）
    const b = await service.submitRequest({
      topicCodes: ['particle'],
      roomId: 'room-1',
      startsAt: '2026-10-25T20:00:00Z',
      endsAt: '2026-10-25T21:00:00Z',
      commandId: 'cmd-mv-b',
    });
    const idB = b.body.request.requestId;
    assert.equal(b.body.request.state, 'submitted');
    assert.equal((await service.confirmRequest(idB, { commandId: 'cmd-mv-b-confirm' })).status, 200);

    // 改期到与 B 冲突的窗口 → 409，A 保持原窗口不动
    const rejected = await service.rescheduleRequest(idA, {
      startsAt: '2026-10-25T20:30:00Z',
      endsAt: '2026-10-25T21:30:00Z',
      commandId: 'cmd-mv-a-2',
    });
    assert.equal(rejected.status, 409);
    const detail = await service.getRequest(idA);
    assert.equal(detail.body.request.state, 'window-held');
    assert.equal(detail.body.request.startsAtUtc, '2026-10-25T22:00:00.000Z');
  } finally {
    await cleanup();
  }
});

test('重启后从日志与快照恢复一致日历，过期保留在启动时被清扫', async () => {
  const { dir, service, cleanup } = await makeService({ holdTtlMs: 60_000 });
  try {
    const a = await service.submitRequest({
      topicCodes: ['dew-point'],
      startsAt: '2026-10-25T20:00:00Z',
      endsAt: '2026-10-25T21:00:00Z',
      commandId: 'cmd-re-a',
    });
    const idA = a.body.request.requestId;
    await service.confirmRequest(idA, { commandId: 'cmd-re-a-confirm' });
    const b = await service.submitRequest({
      topicCodes: ['particle'],
      startsAt: '2026-10-26T08:00:00Z',
      endsAt: '2026-10-26T09:00:00Z',
      commandId: 'cmd-re-b',
    });
    const idB = b.body.request.requestId;
    await service.confirmRequest(idB, { commandId: 'cmd-re-b-confirm' });
    await service.snapshot();

    // 重启 1：同一时刻，日历应与重启前一致
    const reopened = await InspectionService.open({ dataDir: dir, now: () => T0, totalPersonnel: 2, holdTtlMs: 60_000 });
    const calendar = await reopened.getCalendar({});
    assert.equal(calendar.body.locks.length, 2);
    const cap = await reopened.getCapacity({ at: '2026-10-25T20:30:00Z' });
    assert.equal(cap.body.locked, 1);
    // 幂等表同样恢复：重复命令返回原结果，不产生副作用
    const replay = await reopened.confirmRequest(idA, { commandId: 'cmd-re-a-confirm' });
    assert.equal(replay.status, 200);
    assert.equal((await reopened.listRequests()).body.requests.length, 2);

    // 重启 2：时间已过保留期，启动即清扫为 expired
    const later = await InspectionService.open({ dataDir: dir, now: () => T0 + 120_000, totalPersonnel: 2, holdTtlMs: 60_000 });
    const detail = await later.getRequest(idA);
    assert.equal(detail.body.request.state, 'expired');
    const capAfter = await later.getCapacity({ at: '2026-10-25T20:30:00Z' });
    assert.equal(capAfter.body.locked, 0);
  } finally {
    await cleanup();
  }
});

test('并发确认下可用人员数量始终正确', async () => {
  const { service, cleanup } = await makeService({ totalPersonnel: 1 });
  try {
    // 5 个不同干燥间、同一时段的申请，争抢 1 个监测人员
    const ids = [];
    for (let i = 0; i < 5; i += 1) {
      const submitted = await service.submitRequest({
        topicCodes: ['dew-point'],
        roomId: `room-${i}`,
        startsAt: '2026-10-25T20:00:00Z',
        endsAt: '2026-10-25T21:00:00Z',
        commandId: `cmd-conc-submit-${i}`,
      });
      ids.push(submitted.body.request.requestId);
    }
    const results = await Promise.all(ids.map((id, i) =>
      service.confirmRequest(id, { commandId: `cmd-conc-confirm-${i}` })));
    const succeeded = results.filter(r => r.status === 200);
    const failed = results.filter(r => r.status === 409);
    assert.equal(succeeded.length, 1);
    assert.equal(failed.length, 4);
    assert.ok(failed.every(r => r.body.error.code === 'capacity-exhausted'));

    const cap = await service.getCapacity({ at: '2026-10-25T20:30:00Z' });
    assert.equal(cap.body.locked, 1);
    assert.equal(cap.body.available, 0);

    // 并发的同一命令重复到达也只生效一次
    const dup = await Promise.all([
      service.confirmRequest(ids[1], { commandId: 'cmd-conc-dup' }),
      service.confirmRequest(ids[1], { commandId: 'cmd-conc-dup' }),
    ]);
    assert.deepEqual(dup[0], dup[1]);
    const capAfter = await service.getCapacity({ at: '2026-10-25T20:30:00Z' });
    assert.equal(capAfter.body.locked, 1);
  } finally {
    await cleanup();
  }
});

test('非法输入被拒绝：无偏移量时间、空主题、倒置窗口', async () => {
  const { service, cleanup } = await makeService();
  try {
    const noOffset = await service.submitRequest({
      topicCodes: ['dew-point'],
      startsAt: '2026-10-25T20:00:00',
      endsAt: '2026-10-25T21:00:00',
      commandId: 'cmd-bad-1',
    });
    assert.equal(noOffset.status, 400);
    assert.equal(noOffset.body.error.code, 'invalid-timestamp');

    const noTopics = await service.submitRequest({
      topicCodes: [],
      startsAt: '2026-10-25T20:00:00Z',
      endsAt: '2026-10-25T21:00:00Z',
      commandId: 'cmd-bad-2',
    });
    assert.equal(noTopics.status, 400);

    const inverted = await service.submitRequest({
      topicCodes: ['dew-point'],
      startsAt: '2026-10-25T21:00:00Z',
      endsAt: '2026-10-25T20:00:00Z',
      commandId: 'cmd-bad-3',
    });
    assert.equal(inverted.status, 400);
    assert.equal(inverted.body.error.code, 'invalid-window');

    const missing = await service.getRequest('DRY-999');
    assert.equal(missing.status, 404);
  } finally {
    await cleanup();
  }
});
