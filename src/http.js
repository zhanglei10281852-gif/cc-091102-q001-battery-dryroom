// HTTP 适配层：JSON 收发、路由、错误归一化。业务规则全部在 service/domain。

import { createServer } from 'node:http';
import { ApiError } from './domain.js';

const json = (response, status, body) => {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(payload);
};

const readBody = (request) => new Promise((resolve, reject) => {
  let raw = '';
  let size = 0;
  request.on('data', (chunk) => {
    size += chunk.length;
    if (size > 1_048_576) {
      reject(new ApiError(413, 'payload-too-large', '请求体不得超过 1 MiB'));
      request.destroy();
      return;
    }
    raw += chunk;
  });
  request.on('end', () => {
    if (!raw.trim()) return resolve({});
    try {
      resolve(JSON.parse(raw));
    } catch {
      reject(new ApiError(400, 'invalid-json', '请求体不是合法 JSON'));
    }
  });
  request.on('error', reject);
});

// /resources/:id/... 风格的简单匹配。
const compile = (pattern) => {
  const parts = pattern.split('/').filter(Boolean);
  return (segments) => {
    if (segments.length !== parts.length) return null;
    const params = {};
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i].startsWith(':')) params[parts[i].slice(1)] = decodeURIComponent(segments[i]);
      else if (parts[i] !== segments[i]) return null;
    }
    return params;
  };
};

const ROUTES = [
  ['POST', '/requests', (s, body) => s.submitRequest(body)],
  ['GET', '/requests', (s, _b, _p, q) => s.listRequests({ state: q.state || null })],
  ['GET', '/requests/:id', (s, _b, p) => s.getRequest(p.id)],
  ['POST', '/requests/:id/confirm', (s, body, p) => s.confirmRequest(p.id, body)],
  ['POST', '/requests/:id/cancel', (s, body, p) => s.cancelRequest(p.id, body)],
  ['POST', '/requests/:id/reschedule', (s, body, p) => s.rescheduleRequest(p.id, body)],
  ['POST', '/proposals', (s, body) => s.createProposal(body)],
  ['GET', '/proposals/:id', (s, _b, p) => s.getProposal(p.id)],
  ['POST', '/proposals/:id/respond', (s, body, p) => s.respondProposal(p.id, body)],
  ['POST', '/rooms', (s, body) => s.registerRoom(body)],
  ['POST', '/personnel', (s, body) => s.registerPerson(body)],
  ['POST', '/personnel/:id/availability', (s, body, p) => s.addAvailability(p.id, body)],
  ['POST', '/protected-periods', (s, body) => s.addProtectedPeriod(body)],
  ['GET', '/calendar', (s, _b, _p, q) => s.calendar(q)],
  ['GET', '/availability', (s, _b, _p, q) => s.availability(q)],
];

export function createApp(service, { onReady } = {}) {
  const routes = ROUTES.map(([method, pattern, handler]) => ({ method, match: compile(pattern), handler, pattern }));

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const segments = url.pathname.split('/').filter(Boolean);
      const query = Object.fromEntries(url.searchParams.entries());

      if (request.method === 'GET' && url.pathname === '/health') {
        const stats = await service.store.stats();
        return json(response, 200, { service: 'dryroom-inspection', status: 'running', ...stats });
      }

      if (request.method === 'GET' && segments.length === 2 && segments[0] === 'proposals') {
        return json(response, 200, { proposals: await service.listProposals() });
      }

      let body = {};
      if (request.method !== 'GET') body = await readBody(request);

      for (const route of routes) {
        if (route.method !== request.method) continue;
        const params = route.match(segments);
        if (!params) continue;
        const result = await route.handler(service, body, params, query);
        return json(response, 200, result);
      }

      return json(response, 404, { error: { code: 'not-found', message: `没有与 ${request.method} ${url.pathname} 匹配的路由` } });
    } catch (err) {
      const status = err.statusCode || 500;
      if (status >= 500) console.error('[error]', err);
      return json(response, status, {
        error: {
          code: err.code || 'internal-error',
          message: err.statusCode ? err.message : '服务内部错误',
          ...(err.details ? { details: err.details } : {}),
        },
      });
    }
  }).on('listening', () => onReady?.());
}
