import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { EventStore } from '../src/store.js';
import { InspectionService } from '../src/service.js';

const NOW = Date.parse('2026-10-20T10:00:00Z');
const DAY = 86400_000;

async function makeEnv({ snapshotEvery = 200, now = NOW, dir: existingDir = null, keep = false } = {}) {
  const dir = existingDir || await mkdtemp(path.join(os.tmpdir(), 'dryroom-'));
  let clockValue = now;
  const clock = () => clockValue;
  const store = new EventStore(dir, { snapshotEvery, clock });
  await store.load();
  const service = new InspectionService(store, { clock });
  return {
    dir,
    service,
    store,
    setTime: (t) => { clockValue = t; },
    advance: (ms) => { clockValue += ms; },
    dispose: async () => { if (!keep) await rm(dir, { recursive: true, force: true }); },
  };
}

// ISO helpers：不同班次用不同偏移量表达。
const iso = (ms, offset) => {
  const d = new Date(ms);
  const local = new Date(ms + offset);
  const pad = (n) => String(n).padStart(2, '0');
  const sign = offset >= 0 ? '+' : '-';
  const oh = Math.abs(Math.round(offset / 3600_000));
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`
    + `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:00${sign}${pad(oh)}:00`;
};

async function seedBaseline(env, { roomCapacity = 1, people = ['P1', 'P2', 'P3'], roomId = 'DRY-A' } = {}) {
  await env.service.registerRoom({ commandId: 'cmd-room', roomId, capacity: roomCapacity });
  for (let i = 0; i < people.length; i += 1) {
    await env.service.registerPerson({ commandId: `cmd-person-${people[i]}`, personId: people[i], displayName: `人员${people[i]}` });
  }
  // 所有人 10-20 至 11-10 全可用（覆盖测试窗口）。
  for (const personId of people) {
    await env.service.addAvailability(personId, {
      commandId: `cmd-avail-${personId}`,
      window: { startsAt: new Date(NOW - DAY).toISOString(), endsAt: new Date(NOW + 21 * DAY).toISOString() },
    });
  }
}

const W = {
  start: Date.parse('2026-10-25T21:30:00Z'), // = 23:30+02:00
  end: Date.parse('2026-10-26T00:30:00Z'), // = 01:30+01:00（跨午夜、跨偏移）
};

test('完整受理：不同偏移量表达的同一时刻被正确归一，窗口暂留→确认→锁定', async () => {
  const env = await makeEnv();
  await seedBaseline(env);
  try {
    const submitted = await env.service.submitRequest({
      commandId: 'cmd-submit-1', requestId: 'DRY-100', topicCodes: ['dew-point'], personIds: ['P1'],
      roomId: 'DRY-A',
      window: { startsAt: iso(W.start, 2 * 3600_000), endsAt: iso(W.end, 1 * 3600_000) },
    });
    assert.equal(submitted.state, 'window-held');
    assert.equal(submitted.window.startEpoch, W.start);
    assert.equal(submitted.window.endEpoch, W.end);
    assert.ok(submitted.holdExpiresAt);

    const approved = await env.service.confirmRequest('DRY-100', { commandId: 'cmd-confirm-1' });
    assert.equal(approved.state, 'approved');
    assert.equal(approved.window.roomId, 'DRY-A');
    assert.ok(approved.reasons[0].message.includes('监测能力已锁定'));
  } finally { await env.dispose(); }
});

test('幂等：同一 commandId 重复（并发）到达只生效一次', async () => {
  const env = await makeEnv();
  await seedBaseline(env);
  try {
    const payload = {
      commandId: 'cmd-dup', requestId: 'DRY-DUP', topicCodes: ['dew-point'], personIds: ['P1'],
      roomId: 'DRY-A',
      window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.end).toISOString() },
    };
    const [a, b, c] = await Promise.all([
      env.service.submitRequest(payload),
      env.service.submitRequest({ ...payload }),
      env.service.submitRequest({ ...payload }),
    ]);
    assert.equal(a.requestId, b.requestId);
    assert.equal(b.requestId, c.requestId);
    assert.equal((await env.service.listRequests()).length, 1);

    // 确认也幂等：重复确认不报错、不产生重复事件
    const [x, y] = await Promise.all([
      env.service.confirmRequest('DRY-DUP', { commandId: 'cmd-dup-confirm' }),
      env.service.confirmRequest('DRY-DUP', { commandId: 'cmd-dup-confirm' }),
    ]);
    assert.equal(x.state, 'approved');
    assert.equal(y.state, 'approved');
    // 重复命令没有产生新申请事件：request-submitted 恰有一条
    const submitEvents = [...env.service.state.requests.values()];
    assert.equal(submitEvents.length, 1);
    assert.equal(submitEvents[0].revision, 2); // held + approved 两次修订
  } finally { await env.dispose(); }
});

test('commandId 复用于不同操作 → 409', async () => {
  const env = await makeEnv();
  await seedBaseline(env);
  try {
    await env.service.registerRoom({ commandId: 'shared', roomId: 'DRY-X', capacity: 1 });
    await assert.rejects(
      () => env.service.registerPerson({ commandId: 'shared', personId: 'PX' }),
      (e) => e.statusCode === 409 && e.code === 'command-id-reuse',
    );
  } finally { await env.dispose(); }
});

test('容量冲突：第二个重合申请进入协商并给出原因与备选窗口', async () => {
  const env = await makeEnv();
  await seedBaseline(env);
  try {
    await env.service.submitRequest({
      commandId: 'c1', requestId: 'R1', topicCodes: ['dew-point'], personIds: ['P1'], roomId: 'DRY-A',
      window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.end).toISOString() },
    });
    await env.service.confirmRequest('R1', { commandId: 'c1-ok' });
    const r2 = await env.service.submitRequest({
      commandId: 'c2', requestId: 'R2', topicCodes: ['particle'], personIds: ['P2'], roomId: 'DRY-A',
      window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.end).toISOString() },
    });
    assert.equal(r2.state, 'negotiating');
    const kinds = r2.conflictReport.conflicts.map((c) => c.kind);
    assert.ok(kinds.includes('calendar-overlap'));
    assert.ok(r2.conflictReport.alternatives.length > 0);
    assert.ok(r2.reasons.some((r) => r.code === 'alternatives-available'));
  } finally { await env.dispose(); }
});

test('取消立即释放占用，不留下幽灵窗口', async () => {
  const env = await makeEnv();
  await seedBaseline(env);
  try {
    await env.service.submitRequest({
      commandId: 'c1', requestId: 'R1', topicCodes: ['x'], personIds: ['P1'], roomId: 'DRY-A',
      window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.end).toISOString() },
    });
    const r2 = await env.service.submitRequest({
      commandId: 'c2', requestId: 'R2', topicCodes: ['y'], personIds: ['P2'], roomId: 'DRY-A',
      window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.end).toISOString() },
    });
    assert.equal(r2.state, 'negotiating');

    const cancelled = await env.service.cancelRequest('R1', { commandId: 'c3', reason: '班次调整' });
    assert.equal(cancelled.state, 'cancelled');

    // 容量释放后 R2 自动晋升暂留；此时同窗口新申请仍受容量约束
    assert.equal((await env.service.getRequest('R2')).state, 'window-held');
    const r3 = await env.service.submitRequest({
      commandId: 'c4', requestId: 'R3', topicCodes: ['z'], personIds: ['P3'], roomId: 'DRY-A',
      window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.end).toISOString() },
    });
    assert.equal(r3.state, 'negotiating');

    // 级联：R2 也取消后 R3 晋升，日历与人员可用性都不再计入 R1/R2
    await env.service.cancelRequest('R2', { commandId: 'c5' });
    assert.equal((await env.service.getRequest('R3')).state, 'window-held');
    const cal = await env.service.calendar({ from: new Date(W.start - 1000).toISOString(), to: new Date(W.end + 1000).toISOString() });
    assert.deepEqual(cal.slots.map((s) => s.requestIds).flat().sort(), ['R3']);
    const avail = await env.service.availability({
      from: new Date(W.start).toISOString(), to: new Date(W.end).toISOString(), personIds: 'P1,P2,P3',
    });
    assert.equal(avail.availableCount, 2); // P1/P2 已释放；P3 在 R3 暂留中
    assert.deepEqual(avail.available.map((p) => p.personId).sort(), ['P1', 'P2']);

    // 重复取消幂等
    const again = await env.service.cancelRequest('R1', { commandId: 'c3' });
    assert.equal(again.state, 'cancelled');
  } finally { await env.dispose(); }
});

test('改期清空旧窗口占用；旧窗口可被他人使用', async () => {
  const env = await makeEnv();
  await seedBaseline(env);
  try {
    await env.service.submitRequest({
      commandId: 'c1', requestId: 'R1', topicCodes: ['x'], personIds: ['P1'], roomId: 'DRY-A',
      window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.end).toISOString() },
    });
    const moved = await env.service.rescheduleRequest('R1', {
      commandId: 'c2',
      window: { startsAt: new Date(W.start + 3 * 3600_000).toISOString(), endsAt: new Date(W.end + 3 * 3600_000).toISOString() },
    });
    assert.equal(moved.state, 'window-held');
    assert.equal(moved.window.startEpoch, W.start + 3 * 3600_000);

    const taker = await env.service.submitRequest({
      commandId: 'c3', requestId: 'R2', topicCodes: ['x'], personIds: ['P2'], roomId: 'DRY-A',
      window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.end).toISOString() },
    });
    assert.equal(taker.state, 'window-held'); // 旧窗口无幽灵
  } finally { await env.dispose(); }
});

test('暂留 TTL 过期后自动释放；窗口已过的申请自动过期', async () => {
  const env = await makeEnv();
  await seedBaseline(env);
  try {
    const held = await env.service.submitRequest({
      commandId: 'c1', requestId: 'R1', topicCodes: ['x'], personIds: ['P1'], roomId: 'DRY-A',
      window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.end).toISOString() },
    });
    assert.equal(held.state, 'window-held');
    env.advance(16 * 60 * 1000); // 超过 15 分钟保留期
    // 任意操作触发清扫
    await env.service.registerRoom({ commandId: 'c-room2', roomId: 'DRY-Z', capacity: 1 });
    assert.equal((await env.service.getRequest('R1')).state, 'expired');
    assert.equal((await env.service.getRequest('R1')).window, null);

    // 窗口落在过去的申请直接过期
    env.setTime(W.end + DAY);
    const stale = await env.service.submitRequest({
      commandId: 'c2', requestId: 'R2', topicCodes: ['x'], personIds: ['P1'], roomId: 'DRY-A',
      window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.end).toISOString() },
    });
    assert.equal(stale.state, 'expired');
  } finally { await env.dispose(); }
});

test('乐观并发：revision 不匹配返回 409', async () => {
  const env = await makeEnv();
  await seedBaseline(env);
  try {
    const r = await env.service.submitRequest({
      commandId: 'c1', requestId: 'R1', topicCodes: ['x'], personIds: ['P1'], roomId: 'DRY-A',
      window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.end).toISOString() },
    });
    await assert.rejects(
      () => env.service.confirmRequest('R1', { commandId: 'c2', revision: r.revision + 1 }),
      (e) => e.statusCode === 409 && e.code === 'revision-conflict',
    );
  } finally { await env.dispose(); }
});

test('联合检查：主题重合的两份申请合并表决，全员接受后锁定一个监测位', async () => {
  const env = await makeEnv();
  await seedBaseline(env);
  try {
    await env.service.submitRequest({
      commandId: 's1', requestId: 'R1', topicCodes: ['dew-point', 'particle'], personIds: ['P1'], roomId: 'DRY-A',
      window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.end + 3600_000).toISOString() },
    });
    const r2 = await env.service.submitRequest({
      commandId: 's2', requestId: 'R2', topicCodes: ['dew-point'], personIds: ['P2'], roomId: 'DRY-A',
      window: { startsAt: new Date(W.start + 1800_000).toISOString(), endsAt: new Date(W.end).toISOString() },
    });
    assert.equal(r2.state, 'negotiating');
    assert.ok(r2.conflictReport.conflicts.some((c) => c.kind === 'topic-overlap'));

    const proposal = await env.service.createProposal({
      commandId: 'p1', proposalId: 'PROP-1', requestIds: ['R1', 'R2'],
    });
    assert.equal(proposal.state, 'proposed');
    assert.equal(proposal.requiredCount, 2);
    assert.deepEqual(proposal.pendingResponders.sort(), ['P1', 'P2']);
    // 提案期间成员申请处于协商态，且尚未锁定（日历不提前占满）
    const mid = await env.service.calendar({ from: new Date(W.start).toISOString(), to: new Date(W.end).toISOString() });
    assert.equal(mid.slots.length, 1); // 只有提案这一个占位
    assert.equal(mid.slots[0].kind, 'proposal');

    const first = await env.service.respondProposal('PROP-1', { commandId: 'v1', personId: 'P1', decision: 'accept' });
    assert.equal(first.state, 'proposed');
    assert.equal(first.acceptedCount, 1);

    // 无关人员不能表决
    await assert.rejects(
      () => env.service.respondProposal('PROP-1', { commandId: 'vx', personId: 'P3', decision: 'accept' }),
      (e) => e.statusCode === 422 && e.code === 'not-a-responder',
    );

    const done = await env.service.respondProposal('PROP-1', { commandId: 'v2', personId: 'P2', decision: 'accept' });
    assert.equal(done.state, 'accepted');
    for (const id of ['R1', 'R2']) {
      const rec = await env.service.getRequest(id);
      assert.equal(rec.state, 'approved');
      assert.equal(rec.proposalId, 'PROP-1');
    }

    // 联合检查只占一个监测位：容量1房间内第三人时间重合仍只遇到这一个占用
    const r3 = await env.service.submitRequest({
      commandId: 's3', requestId: 'R3', topicCodes: ['z'], personIds: ['P3'], roomId: 'DRY-A',
      window: { startsAt: new Date(W.start + 1800_000).toISOString(), endsAt: new Date(W.end).toISOString() },
    });
    const occupantIds = r3.conflictReport.conflicts.find((c) => c.kind === 'calendar-overlap').with;
    assert.deepEqual(occupantIds.sort(), ['R1', 'R2']);
  } finally { await env.dispose(); }
});

test('联合检查：任一方拒绝则提案作废，成员回到各自日历重新评估', async () => {
  const env = await makeEnv();
  await seedBaseline(env);
  try {
    await env.service.submitRequest({
      commandId: 's1', requestId: 'R1', topicCodes: ['dew-point'], personIds: ['P1'], roomId: 'DRY-A',
      window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.end).toISOString() },
    });
    await env.service.submitRequest({
      commandId: 's2', requestId: 'R2', topicCodes: ['dew-point'], personIds: ['P2'], roomId: 'DRY-A',
      window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.end).toISOString() },
    });
    await env.service.createProposal({ commandId: 'p1', proposalId: 'PROP-9', requestIds: ['R1', 'R2'] });
    const rejected = await env.service.respondProposal('PROP-9', { commandId: 'v1', personId: 'P2', decision: 'decline', reason: '海外团队时差' });
    assert.equal(rejected.state, 'rejected');
    const r1 = await env.service.getRequest('R1');
    assert.equal(r1.state, 'window-held'); // 独立窗口重新可用
    assert.equal(r1.proposalId, null);
    assert.equal((await env.service.getRequest('R2')).state, 'negotiating'); // 容量被 R1 占
  } finally { await env.dispose(); }
});

test('提案进行中成员取消 → 提案作废且不锁定；成员改期同样释放', async () => {
  const env = await makeEnv();
  await seedBaseline(env);
  try {
    await env.service.submitRequest({
      commandId: 's1', requestId: 'R1', topicCodes: ['t'], personIds: ['P1'], roomId: 'DRY-A',
      window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.end).toISOString() },
    });
    await env.service.submitRequest({
      commandId: 's2', requestId: 'R2', topicCodes: ['t'], personIds: ['P2'], roomId: 'DRY-A',
      window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.end).toISOString() },
    });
    await env.service.createProposal({ commandId: 'p1', proposalId: 'PROP-X', requestIds: ['R1', 'R2'] });
    await env.service.cancelRequest('R1', { commandId: 'cx' });
    assert.equal((await env.service.getProposal('PROP-X')).state, 'cancelled');
    // R1 取消后提案作废，R2 在同窗口重新评估：容量已释放 → R2 持有窗口
    assert.equal((await env.service.getRequest('R2')).state, 'window-held');
    assert.equal((await env.service.getRequest('R2')).proposalId, null);
  } finally { await env.dispose(); }
});

test('已锁定联合检查：一方取消则联合占用消失，另一方回到独立日历重评', async () => {
  const env = await makeEnv({ keep: true });
  await seedBaseline(env);
  try {
    await env.service.submitRequest({
      commandId: 's1', requestId: 'R1', topicCodes: ['t'], personIds: ['P1'], roomId: 'DRY-A',
      window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.end).toISOString() },
    });
    await env.service.submitRequest({
      commandId: 's2', requestId: 'R2', topicCodes: ['t'], personIds: ['P2'], roomId: 'DRY-A',
      window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.end).toISOString() },
    });
    await env.service.createProposal({ commandId: 'p1', proposalId: 'PROP-DISSOLVE', requestIds: ['R1', 'R2'] });
    await env.service.respondProposal('PROP-DISSOLVE', { commandId: 'v1', personId: 'P1', decision: 'accept' });
    await env.service.respondProposal('PROP-DISSOLVE', { commandId: 'v2', personId: 'P2', decision: 'accept' });
    assert.equal((await env.service.getRequest('R1')).state, 'approved');

    // R1 退出：提案作废，联合占用消失；R2 回到独立窗口（单人可持有）
    await env.service.cancelRequest('R1', { commandId: 'c-r1' });
    const cal1 = await env.service.calendar({ from: new Date(W.start).toISOString(), to: new Date(W.end).toISOString() });
    assert.equal(cal1.slots.length, 1);
    assert.deepEqual(cal1.slots[0].requestIds, ['R2']);
    assert.equal(cal1.slots[0].kind, 'solo');
    const r2 = await env.service.getRequest('R2');
    assert.equal(r2.state, 'window-held');
    assert.equal(r2.proposalId, null);

    // 重启后状态仍然一致（reopened 已在事件流中）
    await env.dispose();
  } catch (e) { await env.dispose(); throw e; }

  const env2 = await makeEnv({ dir: env.dir });
  try {
    const cal = await env2.service.calendar({ from: new Date(W.start).toISOString(), to: new Date(W.end).toISOString() });
    assert.equal(cal.slots.length, 1);
    assert.deepEqual(cal.slots[0].requestIds, ['R2']);
    assert.equal((await env2.service.getRequest('R1')).state, 'cancelled');
  } finally { await env2.dispose(); }
});

test('无主题且无共同人员的申请不能合并；偏好窗口无绝对时间交集时报错并给出各窗口', async () => {
  const env = await makeEnv();
  await seedBaseline(env);
  try {
    await env.service.submitRequest({
      commandId: 's1', requestId: 'R1', topicCodes: ['a'], personIds: ['P1'], roomId: 'DRY-A',
      window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.start + 3600_000).toISOString() },
    });
    await env.service.submitRequest({
      commandId: 's2', requestId: 'R2', topicCodes: ['b'], personIds: ['P2'], roomId: 'DRY-A',
      window: { startsAt: new Date(W.start + 2 * 3600_000).toISOString(), endsAt: new Date(W.start + 3 * 3600_000).toISOString() },
    });
    await assert.rejects(
      () => env.service.createProposal({ commandId: 'p1', requestIds: ['R1', 'R2'] }),
      (e) => e.statusCode === 422 && e.code === 'no-common-window',
    );
  } finally { await env.dispose(); }
});

test('受阻判定：仅有同人冲突且近期无备选窗口时 verdict=blocked 并说明原因', async () => {
  const env = await makeEnv({ now: NOW });
  await env.service.registerRoom({ commandId: 'rm1', roomId: 'DRY-A', capacity: 1 });
  await env.service.registerRoom({ commandId: 'rm2', roomId: 'DRY-B', capacity: 2 });
  await env.service.registerPerson({ commandId: 'pp1', personId: 'P1' });
  // P1 的可用时间恰好只覆盖目标窗口
  await env.service.addAvailability('P1', {
    commandId: 'av1',
    window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.end).toISOString() },
  });
  try {
    await env.service.submitRequest({
      commandId: 's1', requestId: 'R1', topicCodes: ['alpha'], personIds: ['P1'], roomId: 'DRY-A',
      window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.end).toISOString() },
    });
    await env.service.confirmRequest('R1', { commandId: 'ok1' });
    // R2：不同房间（无容量问题）、不同主题（无合并线索）、同一人、无其他可覆盖时间
    const blocked = await env.service.submitRequest({
      commandId: 's2', requestId: 'R2', topicCodes: ['beta'], personIds: ['P1'], roomId: 'DRY-B',
      window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.end).toISOString() },
    });
    assert.equal(blocked.verdict, 'blocked');
    assert.ok(blocked.reasons.some((r) => r.code === 'rolling-quota'));
    assert.ok(blocked.reasons.some((r) => r.code === 'blocked'));
  } finally { await env.dispose(); }
});

test('保护时段：申请进入协商且原因包含 protected-period', async () => {
  const env = await makeEnv();
  await seedBaseline(env);
  try {
    await env.service.addProtectedPeriod({
      commandId: 'ban1', periodId: 'BAN-1',
      window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.end).toISOString() },
      reason: '吊装作业',
    });
    const r = await env.service.submitRequest({
      commandId: 's1', requestId: 'R1', topicCodes: ['x'], personIds: ['P1'], roomId: 'DRY-A',
      window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.end).toISOString() },
    });
    assert.equal(r.state, 'negotiating');
    assert.ok(r.conflictReport.conflicts.some((c) => c.kind === 'protected-period'));
  } finally { await env.dispose(); }
});

test('并发申请：容量1房间在 20 个并发申请下只暂留 1 个，可用人员清点始终正确', async () => {
  const env = await makeEnv();
  await seedBaseline(env, { people: ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9',
    'Q0', 'Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9'] });
  try {
    const people = [];
    for (let i = 0; i < 10; i += 1) people.push(`P${i}`);
    for (let i = 0; i < 10; i += 1) people.push(`Q${i}`);
    const results = await Promise.all(people.map((personId, i) => env.service.submitRequest({
      commandId: `parallel-${i}`, requestId: `RR-${i}`, topicCodes: ['x'], personIds: [personId], roomId: 'DRY-A',
      window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.end).toISOString() },
    })));
    const held = results.filter((r) => r.state === 'window-held');
    const negotiating = results.filter((r) => r.state === 'negotiating');
    assert.equal(held.length, 1);
    assert.equal(negotiating.length, 19);

    const avail = await env.service.availability({
      from: new Date(W.start).toISOString(), to: new Date(W.end).toISOString(),
      personIds: people.join(','),
    });
    assert.equal(avail.total, 20);
    assert.equal(avail.availableCount, 19);
    assert.equal(avail.busy.length, 1);

    // 日历中该房间该时段恰好 1 个占用
    const cal = await env.service.calendar({ from: new Date(W.start).toISOString(), to: new Date(W.end).toISOString() });
    assert.equal(cal.slots.length, 1);
    assert.equal(cal.rooms.find((r) => r.roomId === 'DRY-A').used, 1);
  } finally { await env.dispose(); }
});

test('重启恢复：事件回放后日历一致，commandId 仍然幂等', async () => {
  const env = await makeEnv({ keep: true });
  await seedBaseline(env);
  try {
    await env.service.submitRequest({
      commandId: 's1', requestId: 'R1', topicCodes: ['x'], personIds: ['P1'], roomId: 'DRY-A',
      window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.end).toISOString() },
    });
    await env.service.confirmRequest('R1', { commandId: 'ok1' });
    await env.service.submitRequest({
      commandId: 's2', requestId: 'R2', topicCodes: ['y'], personIds: ['P2'], roomId: 'DRY-A',
      window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.end).toISOString() },
    });
    await env.dispose();
  } catch (e) { await env.dispose(); throw e; }

  // 新进程：同一数据目录重新加载
  const env2 = await makeEnv({ dir: env.dir });
  try {
    assert.equal((await env2.service.getRequest('R1')).state, 'approved');
    assert.equal((await env2.service.getRequest('R2')).state, 'negotiating');
    const cal = await env2.service.calendar({ from: new Date(W.start).toISOString(), to: new Date(W.end).toISOString() });
    assert.deepEqual(cal.slots.map((s) => s.requestIds).flat(), ['R1']);
    // 旧 commandId 重放返回首次结果而不是再建申请
    const replay = await env2.service.submitRequest({
      commandId: 's2', requestId: 'R2', topicCodes: ['y'], personIds: ['P2'], roomId: 'DRY-A',
      window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.end).toISOString() },
    });
    assert.equal(replay.requestId, 'R2');
    assert.equal((await env2.service.listRequests()).length, 2);
  } finally { await env2.dispose(); }
});

test('重启恢复：快照 + 日志混合回放一致', async () => {
  const env = await makeEnv({ snapshotEvery: 5, keep: true });
  await seedBaseline(env);
  try {
    await env.service.submitRequest({
      commandId: 's1', requestId: 'R1', topicCodes: ['x'], personIds: ['P1'], roomId: 'DRY-A',
      window: { startsAt: new Date(W.start).toISOString(), endsAt: new Date(W.end).toISOString() },
    });
    await env.service.confirmRequest('R1', { commandId: 'ok1' });
    assert.ok((await env.store.stats()).seq > 5);
  } finally { await env.dispose(); }

  const env2 = await makeEnv({ snapshotEvery: 5, dir: env.dir });
  try {
    assert.equal((await env2.service.getRequest('R1')).state, 'approved');
    const cal = await env2.service.calendar({ from: new Date(W.start).toISOString(), to: new Date(W.end).toISOString() });
    assert.equal(cal.slots.length, 1);
  } finally { await env2.dispose(); }
});
