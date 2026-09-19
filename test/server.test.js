import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHandler } from '../src/server.js';
import { InspectionService } from '../src/service.js';

async function makeServer(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dryroom-http-'));
  const service = await InspectionService.open({ dataDir: dir, totalPersonnel: 2, ...options });
  const server = createServer(createHandler(service));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: async () => {
      await new Promise(resolve => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function post(base, path, body, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('HTTP 全流程：提交、确认、批准、查询日历与容量', async () => {
  const { base, close } = await makeServer();
  try {
    const health = await fetch(`${base}/health`).then(r => r.json());
    assert.equal(health.status, 'running');

    const submitted = await post(base, '/requests', {
      topicCodes: ['dew-point', 'particle'],
      startsAt: '2026-10-25T23:30:00+02:00',
      endsAt: '2026-10-26T01:30:00+01:00',
      party: 'quality-team',
    }, { 'idempotency-key': 'http-key-1' });
    assert.equal(submitted.status, 201);
    const id = submitted.body.request.requestId;
    // 跨时区窗口归一到 UTC 展示
    assert.equal(submitted.body.request.startsAtUtc, '2026-10-25T21:30:00.000Z');
    assert.equal(submitted.body.request.endsAtUtc, '2026-10-26T00:30:00.000Z');

    // 同一 Idempotency-Key 重放 → 同一结果，不产生第二个申请
    const replayed = await post(base, '/requests', {
      topicCodes: ['dew-point', 'particle'],
      startsAt: '2026-10-25T23:30:00+02:00',
      endsAt: '2026-10-26T01:30:00+01:00',
    }, { 'idempotency-key': 'http-key-1' });
    assert.deepEqual(replayed, submitted);
    const list = await fetch(`${base}/requests`).then(r => r.json());
    assert.equal(list.requests.length, 1);

    const confirmed = await post(base, `/requests/${id}/confirm`, {}, { 'idempotency-key': 'http-key-2' });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.requests[0].state, 'window-held');

    const approved = await post(base, `/requests/${id}/approve`, {}, { 'idempotency-key': 'http-key-3' });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.request.state, 'approved');

    const capacity = await fetch(`${base}/capacity?at=2026-10-25T22:00:00Z`).then(r => r.json());
    assert.equal(capacity.locked, 1);

    const calendar = await fetch(`${base}/calendar?from=2026-10-25T00:00:00Z&to=2026-10-27T00:00:00Z`).then(r => r.json());
    assert.equal(calendar.locks.length, 1);
    assert.equal(calendar.locks[0].startsAtUtc, '2026-10-25T21:30:00.000Z');

    const detail = await fetch(`${base}/requests/${id}`).then(r => r.json());
    assert.deepEqual(detail.request.reasons.map(r => r.code), ['submitted', 'confirmed', 'approved']);
  } finally {
    await close();
  }
});

test('HTTP 错误路径：缺偏移量 400、未知申请 404、未知路由 404、坏 JSON 400', async () => {
  const { base, close } = await makeServer();
  try {
    const noOffset = await post(base, '/requests', {
      topicCodes: ['dew-point'],
      startsAt: '2026-10-25T20:00:00',
      endsAt: '2026-10-25T21:00:00',
    });
    assert.equal(noOffset.status, 400);
    assert.equal(noOffset.body.error.code, 'invalid-timestamp');

    const missing = await fetch(`${base}/requests/DRY-404`);
    assert.equal(missing.status, 404);

    const unknown = await fetch(`${base}/nope`);
    assert.equal(unknown.status, 404);

    const badJson = await fetch(`${base}/requests`, { method: 'POST', body: '{oops' });
    assert.equal(badJson.status, 400);
  } finally {
    await close();
  }
});

test('HTTP 取消与改期接口', async () => {
  const { base, close } = await makeServer();
  try {
    const submitted = await post(base, '/requests', {
      topicCodes: ['dew-point'],
      startsAt: '2026-10-25T20:00:00Z',
      endsAt: '2026-10-25T21:00:00Z',
    });
    const id = submitted.body.request.requestId;
    await post(base, `/requests/${id}/confirm`, {});

    const moved = await post(base, `/requests/${id}/reschedule`, {
      startsAt: '2026-10-25T22:00:00Z',
      endsAt: '2026-10-25T23:00:00Z',
    });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.request.startsAtUtc, '2026-10-25T22:00:00.000Z');

    const cancelled = await post(base, `/requests/${id}/cancel`, { reason: '计划调整' });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.request.state, 'cancelled');

    const capacity = await fetch(`${base}/capacity?at=2026-10-25T22:30:00Z`).then(r => r.json());
    assert.equal(capacity.locked, 0);
  } finally {
    await close();
  }
});
