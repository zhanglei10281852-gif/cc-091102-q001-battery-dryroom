import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { EventStore } from '../src/store.js';
import { InspectionService } from '../src/service.js';
import { createApp } from '../src/http.js';

const NOW = Date.parse('2026-10-20T10:00:00Z');

async function startServer(dir, { clock = () => NOW } = {}) {
  const store = new EventStore(dir, { clock });
  await store.load();
  const service = new InspectionService(store, { clock });
  const app = createApp(service);
  await new Promise((resolve) => app.listen(0, resolve));
  const port = app.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    base, service,
    request: (method, url, body) => fetch(base + url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (res) => ({ status: res.status, body: await res.json() })),
    close: () => new Promise((resolve) => app.close(resolve)),
  };
}

test('HTTP 健康接口', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dryroom-http-'));
  const srv = await startServer(dir);
  try {
    const res = await srv.request('GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'running');
  } finally { await srv.close(); await rm(dir, { recursive: true, force: true }); }
});

test('HTTP 端到端：配置→跨时区申请→协商→合并表决→锁定→查询原因', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dryroom-http-'));
  const srv = await startServer(dir);
  try {
    // 两座新干燥间，容量各 1
    for (const room of [['DRY-A', '一号干燥间'], ['DRY-B', '二号干燥间']]) {
      const r = await srv.request('POST', '/rooms', { commandId: `room-${room[0]}`, roomId: room[0], displayName: room[1], capacity: 1 });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    // 跨时区团队：欧洲班组 P-EU、日本班组 P-JP
    await srv.request('POST', '/personnel', { commandId: 'p-eu', personId: 'P-EU', displayName: '欧洲班组' });
    await srv.request('POST', '/personnel', { commandId: 'p-jp', personId: 'P-JP', displayName: '日本班组' });
    await srv.request('POST', '/personnel/P-EU/availability', {
      commandId: 'av-eu',
      windows: [{ startsAt: '2026-10-20T00:00:00Z', endsAt: '2026-11-10T00:00:00Z' }],
    });
    await srv.request('POST', '/personnel/P-JP/availability', {
      commandId: 'av-jp',
      windows: [{ startsAt: '2026-10-20T00:00:00Z', endsAt: '2026-11-10T00:00:00Z' }],
    });

    // 欧洲班组用 +02:00 表达跨午夜窗口
    const eu = await srv.request('POST', '/requests', {
      commandId: 'req-eu', requestId: 'DRY-EU', topicCodes: ['dew-point', 'particle'], personIds: ['P-EU'], roomId: 'DRY-A',
      window: { startsAt: '2026-10-25T23:30:00+02:00', endsAt: '2026-10-26T01:30:00+01:00' },
    });
    assert.equal(eu.status, 200);
    assert.equal(eu.body.state, 'window-held');

    // 日本班组用 +09:00 表达同一绝对时刻的另一表述（06:30+09 = 21:30Z 前一日；取同窗口）
    const jp = await srv.request('POST', '/requests', {
      commandId: 'req-jp', requestId: 'DRY-JP', topicCodes: ['particle'], personIds: ['P-JP'], roomId: 'DRY-A',
      window: { startsAt: '2026-10-26T06:30:00+09:00', endsAt: '2026-10-26T09:30:00+09:00' },
    });
    // 06:30+09 = 2026-10-25T21:30Z；EU 窗口为 21:30Z–00:30Z，故两窗重合 3 小时
    assert.equal(jp.body.state, 'negotiating');
    assert.ok(jp.body.reasons.some((r) => r.code === 'topic-overlap'));

    // 发起联合检查（显式给公共窗口）
    const prop = await srv.request('POST', '/proposals', {
      commandId: 'prop-1', proposalId: 'PROP-HTTP', requestIds: ['DRY-EU', 'DRY-JP'],
      window: { startsAt: '2026-10-25T21:30:00Z', endsAt: '2026-10-26T00:30:00Z' },
      roomId: 'DRY-A',
    });
    assert.equal(prop.status, 200, JSON.stringify(prop.body));
    assert.deepEqual(prop.body.pendingResponders.sort(), ['P-EU', 'P-JP']);

    for (const [cmd, person] of [['vote-eu', 'P-EU'], ['vote-jp', 'P-JP']]) {
      const v = await srv.request('POST', '/proposals/PROP-HTTP/respond', { commandId: cmd, personId: person, decision: 'accept' });
      assert.equal(v.status, 200, JSON.stringify(v.body));
    }

    // 两份申请均获准，原因可查
    for (const id of ['DRY-EU', 'DRY-JP']) {
      const r = await srv.request('GET', `/requests/${id}`);
      assert.equal(r.body.state, 'approved');
      assert.equal(r.body.verdict, 'approved');
      assert.ok(r.body.reasons[0].message.includes('联合检查'));
    }

    // 日历只有一个联合占用（一个监测位）
    const cal = await srv.request('GET', '/calendar?from=2026-10-25T00:00:00Z&to=2026-10-27T00:00:00Z');
    assert.equal(cal.body.slots.length, 1);
    assert.equal(cal.body.slots[0].kind, 'proposal');
    assert.deepEqual(cal.body.slots[0].requestIds.sort(), ['DRY-EU', 'DRY-JP']);

    // 无偏移量时间被拒
    const bad = await srv.request('POST', '/requests', {
      commandId: 'bad-time', topicCodes: ['x'], personIds: ['P-EU'], roomId: 'DRY-A',
      window: { startsAt: '2026-10-25T23:30:00', endsAt: '2026-10-26T01:30:00' },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'missing-offset');
  } finally { await srv.close(); await rm(dir, { recursive: true, force: true }); }
});

test('HTTP 幂等：同一 commandId 并发重复提交只生效一次', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dryroom-http-'));
  const srv = await startServer(dir);
  try {
    await srv.request('POST', '/rooms', { commandId: 'room', roomId: 'DRY-A', capacity: 1 });
    await srv.request('POST', '/personnel', { commandId: 'p1', personId: 'P1' });
    await srv.request('POST', '/personnel/P1/availability', {
      commandId: 'av1', window: { startsAt: '2026-10-20T00:00:00Z', endsAt: '2026-11-10T00:00:00Z' },
    });
    const payload = {
      commandId: 'once', requestId: 'DRY-ONCE', topicCodes: ['x'], personIds: ['P1'], roomId: 'DRY-A',
      window: { startsAt: '2026-10-25T20:00:00Z', endsAt: '2026-10-25T22:00:00Z' },
    };
    const results = await Promise.all([
      srv.request('POST', '/requests', payload),
      srv.request('POST', '/requests', { ...payload }),
      srv.request('POST', '/requests', { ...payload }),
    ]);
    for (const r of results) assert.equal(r.status, 200);
    const list = await srv.request('GET', '/requests');
    assert.equal(list.body.length, 1);

    // commandId 跨操作复用 → 409
    const reuse = await srv.request('POST', '/rooms', { commandId: 'once', roomId: 'DRY-Z', capacity: 1 });
    assert.equal(reuse.status, 409);
    assert.equal(reuse.body.error.code, 'command-id-reuse');
  } finally { await srv.close(); await rm(dir, { recursive: true, force: true }); }
});

test('HTTP 取消释放占用，后续同窗口申请可暂留', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dryroom-http-'));
  const srv = await startServer(dir);
  try {
    await srv.request('POST', '/rooms', { commandId: 'room', roomId: 'DRY-A', capacity: 1 });
    await srv.request('POST', '/personnel', { commandId: 'p1', personId: 'P1' });
    await srv.request('POST', '/personnel', { commandId: 'p2', personId: 'P2' });
    for (const p of ['P1', 'P2']) {
      await srv.request('POST', `/personnel/${p}/availability`, {
        commandId: `av-${p}`, window: { startsAt: '2026-10-20T00:00:00Z', endsAt: '2026-11-10T00:00:00Z' },
      });
    }
    await srv.request('POST', '/requests', {
      commandId: 'r1', requestId: 'DRY-1', topicCodes: ['x'], personIds: ['P1'], roomId: 'DRY-A',
      window: { startsAt: '2026-10-25T20:00:00Z', endsAt: '2026-10-25T22:00:00Z' },
    });
    const blocked = await srv.request('POST', '/requests', {
      commandId: 'r2', requestId: 'DRY-2', topicCodes: ['y'], personIds: ['P2'], roomId: 'DRY-A',
      window: { startsAt: '2026-10-25T20:00:00Z', endsAt: '2026-10-25T22:00:00Z' },
    });
    assert.equal(blocked.body.state, 'negotiating');

    const cancel = await srv.request('POST', '/requests/DRY-1/cancel', { commandId: 'cancel-r1' });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.state, 'cancelled');

    // 容量释放后，协商中的 DRY-2 在下一次观察时自动晋升为暂留（无幽灵占用、无重复承诺）
    const promoted = await srv.request('GET', '/requests/DRY-2');
    assert.equal(promoted.body.state, 'window-held');

    // 即使不晋升，改期到同窗口也应成功；此处改期到另一相接窗口验证排程连续
    const move = await srv.request('POST', '/requests/DRY-2/reschedule', {
      commandId: 'move-r2',
      window: { startsAt: '2026-10-25T22:00:00Z', endsAt: '2026-10-26T00:00:00Z' },
    });
    assert.equal(move.status, 200);
    assert.equal(move.body.state, 'window-held');
  } finally { await srv.close(); await rm(dir, { recursive: true, force: true }); }
});
