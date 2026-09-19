import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { InspectionService } from './service.js';

const BODY_LIMIT = 1_000_000;

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) {
      const err = new Error('请求体过大');
      err.code = 'payload-too-large';
      throw err;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('not-an-object');
    return body;
  } catch (err) {
    if (err.message === 'not-an-object') {
      const wrapped = new Error('请求体必须是 JSON 对象');
      wrapped.code = 'invalid-json';
      throw wrapped;
    }
    const wrapped = new Error('请求体不是合法 JSON');
    wrapped.code = 'invalid-json';
    throw wrapped;
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const ACTIONS = {
  confirm: 'confirmRequest',
  approve: 'approveRequest',
  cancel: 'cancelRequest',
  reschedule: 'rescheduleRequest',
};

export function createHandler(service) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const path = url.pathname;

      if (req.method === 'GET' && (path === '/' || path === '/health')) {
        return send(res, 200, { service: 'dryroom-inspection', status: 'running' });
      }
      if (req.method === 'POST' && path === '/requests') {
        const body = await readJsonBody(req);
        body.commandId ??= req.headers['idempotency-key'];
        const { status, body: reply } = await service.submitRequest(body);
        return send(res, status, reply);
      }
      if (req.method === 'GET' && path === '/requests') {
        const { status, body } = await service.listRequests({ state: url.searchParams.get('state') ?? undefined });
        return send(res, status, body);
      }
      if (req.method === 'GET' && path === '/calendar') {
        const { status, body } = await service.getCalendar({
          from: url.searchParams.get('from') ?? undefined,
          to: url.searchParams.get('to') ?? undefined,
        });
        return send(res, status, body);
      }
      if (req.method === 'GET' && path === '/capacity') {
        const { status, body } = await service.getCapacity({
          at: url.searchParams.get('at') ?? undefined,
          from: url.searchParams.get('from') ?? undefined,
          to: url.searchParams.get('to') ?? undefined,
        });
        return send(res, status, body);
      }

      const match = path.match(/^\/requests\/([\w-]+)(?:\/(confirm|approve|cancel|reschedule))?$/);
      if (match) {
        const [, requestId, action] = match;
        if (req.method === 'GET' && !action) {
          const { status, body } = await service.getRequest(requestId);
          return send(res, status, body);
        }
        if (req.method === 'POST' && action) {
          const body = await readJsonBody(req);
          body.commandId ??= req.headers['idempotency-key'];
          const { status, body: reply } = await service[ACTIONS[action]](requestId, body);
          return send(res, status, reply);
        }
      }

      return send(res, 404, { error: { code: 'not-found', message: `未知路由 ${req.method} ${path}` } });
    } catch (err) {
      const status = err.code === 'invalid-json' ? 400 : err.code === 'payload-too-large' ? 413 : 500;
      return send(res, status, { error: { code: err.code ?? 'internal', message: err.message } });
    }
  };
}

async function main() {
  const service = await InspectionService.open({
    dataDir: process.env.DATA_DIR ?? 'data',
    totalPersonnel: Number(process.env.TOTAL_PERSONNEL ?? 3),
    holdTtlMs: Number(process.env.HOLD_TTL_MS ?? 30 * 60 * 1000),
    protectedPeriods: process.env.PROTECTED_PERIODS ? JSON.parse(process.env.PROTECTED_PERIODS) : [],
  });
  const server = createServer(createHandler(service));
  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, () => {
    console.log(`dryroom-inspection listening on :${port}`);
  });
  const timer = setInterval(() => {
    service.sweepExpired().catch(() => {});
  }, 15_000);
  timer.unref();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
