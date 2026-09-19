// 事件溯源的状态折叠器：服务运行时与重启回放共用同一份逻辑，保证日历一致。
export const EMPTY_STATE = () => ({
  requests: {},
  groups: {},
  commands: {},
  counters: { request: 0, group: 0 },
});

const TERMINAL_BY_EVENT = {
  'request-approved': 'approved',
  'request-cancelled': 'cancelled',
  'request-expired': 'expired',
};

export function applyEvent(state, event) {
  const p = event.payload ?? {};
  switch (event.type) {
    case 'request-submitted': {
      state.requests[p.request.requestId] = p.request;
      if (p.counter) state.counters.request = Math.max(state.counters.request, p.counter);
      break;
    }
    case 'request-confirmed': {
      state.groups[p.groupId] = {
        groupId: p.groupId,
        memberIds: [...p.memberIds],
        startsAt: p.startsAt,
        endsAt: p.endsAt,
        startMs: p.startMs,
        endMs: p.endMs,
        createdAt: event.at,
      };
      for (const id of p.memberIds) {
        const request = state.requests[id];
        if (!request) continue;
        request.state = 'window-held';
        request.groupId = p.groupId;
        request.startsAt = p.startsAt;
        request.endsAt = p.endsAt;
        request.startMs = p.startMs;
        request.endMs = p.endMs;
        request.holdExpiresAt = p.holdExpiresAt;
        request.holdExpiresAtMs = p.holdExpiresAtMs;
        request.conflicts = [];
        for (const reason of p.reasons?.[id] ?? []) request.reasons.push(reason);
        request.revision += 1;
        request.updatedAt = event.at;
      }
      if (p.groupCounter) state.counters.group = Math.max(state.counters.group, p.groupCounter);
      break;
    }
    case 'request-approved':
    case 'request-cancelled':
    case 'request-expired': {
      const request = state.requests[p.requestId];
      if (!request) break;
      request.state = TERMINAL_BY_EVENT[event.type];
      if (event.type === 'request-approved') {
        request.holdExpiresAt = null;
        request.holdExpiresAtMs = null;
      }
      request.reasons.push(p.reason);
      request.revision += 1;
      request.updatedAt = event.at;
      break;
    }
    case 'request-rescheduled': {
      const request = state.requests[p.requestId];
      if (!request) break;
      request.state = 'window-held';
      request.groupId = p.groupId;
      request.startsAt = p.startsAt;
      request.endsAt = p.endsAt;
      request.startMs = p.startMs;
      request.endMs = p.endMs;
      request.holdExpiresAt = p.holdExpiresAt;
      request.holdExpiresAtMs = p.holdExpiresAtMs;
      request.conflicts = [];
      request.reasons.push(p.reason);
      request.revision += 1;
      request.updatedAt = event.at;
      state.groups[p.groupId] = {
        groupId: p.groupId,
        memberIds: [p.requestId],
        startsAt: p.startsAt,
        endsAt: p.endsAt,
        startMs: p.startMs,
        endMs: p.endMs,
        createdAt: event.at,
      };
      if (p.groupCounter) state.counters.group = Math.max(state.counters.group, p.groupCounter);
      break;
    }
    case 'request-annotated': {
      // 确认 / 改期受阻时记录原因，可选地转入协商态；不触碰既有锁定。
      const request = state.requests[p.requestId];
      if (!request) break;
      request.reasons.push(p.reason);
      if (p.state !== undefined) request.state = p.state;
      if (p.conflicts !== undefined) request.conflicts = p.conflicts;
      request.revision += 1;
      request.updatedAt = event.at;
      break;
    }
    case 'command-rejected': {
      break; // 仅通过下方 commands 记录幂等结果
    }
    default:
      throw new Error(`未知事件类型：${event.type}`);
  }
  if (event.commandId && event.result) {
    state.commands[event.commandId] = event.result;
  }
  return state;
}
