import { randomUUID } from 'node:crypto';
import {
  ACTIVE_STATES,
  OPEN_STATES,
  TERMINAL_STATES,
  DomainError,
  detectConflicts,
  intervalsOverlap,
  peakUsage,
  toInstant,
  toUtcIso,
} from './domain.js';
import { applyEvent } from './reducer.js';
import { EventStore } from './store.js';

const SNAPSHOT_EVERY = 25;

const DEFAULTS = {
  totalPersonnel: 3,
  holdTtlMs: 30 * 60 * 1000,
  rollingQuota: { max: 8, windowMs: 24 * 60 * 60 * 1000 },
  protectedPeriods: [],
};

const CONFIRMABLE_STATES = new Set(['submitted', 'negotiating', 'window-held']);

function errorResult(err) {
  if (err instanceof DomainError) {
    const status = err.code === 'not-found' ? 404
      : ['invalid-state', 'conflict', 'capacity-exhausted', 'duplicate-request'].includes(err.code) ? 409
        : 400;
    return {
      status,
      body: { error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } },
    };
  }
  throw err;
}

function reasonFromConflict(conflict, at) {
  let message;
  switch (conflict.kind) {
    case 'topic-overlap':
      message = `与 ${conflict.withRequestId} 材料主题重合（${conflict.sharedTopics.join('、')}），可组织合并确认`;
      break;
    case 'calendar-overlap':
      message = `与 ${conflict.withRequestId} 检查时段重合`;
      break;
    case 'rolling-quota':
      message = conflict.detail;
      break;
    case 'protected-period':
      message = `落入保护时段（${conflict.detail}）`;
      break;
    default:
      message = conflict.kind;
  }
  return { at, code: conflict.kind, message };
}

// 对外视图：窗口同时给出原始写法与归一后的 UTC 写法。
function publicRequest(request) {
  return {
    requestId: request.requestId,
    state: request.state,
    topicCodes: [...request.topicCodes],
    startsAt: request.startsAt,
    endsAt: request.endsAt,
    startsAtUtc: toUtcIso(request.startMs),
    endsAtUtc: toUtcIso(request.endMs),
    party: request.party,
    roomId: request.roomId,
    personnelRequired: request.personnelRequired,
    groupId: request.groupId,
    holdExpiresAt: request.holdExpiresAt,
    conflicts: request.conflicts,
    reasons: request.reasons,
    revision: request.revision,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

export class InspectionService {
  static async open(options = {}) {
    const store = new EventStore(options.dataDir ?? 'data');
    const { state, seq } = await store.load();
    const service = new InspectionService(store, state, seq, options);
    await service.sweepExpired(); // 重启后立即清扫过期保留，保证日历一致
    return service;
  }

  constructor(store, state, seq, options = {}) {
    this.store = store;
    this.state = state;
    this.seq = seq;
    this.now = options.now ?? (() => Date.now());
    this.totalPersonnel = options.totalPersonnel ?? DEFAULTS.totalPersonnel;
    this.holdTtlMs = options.holdTtlMs ?? DEFAULTS.holdTtlMs;
    this.rollingQuota = options.rollingQuota ?? DEFAULTS.rollingQuota;
    this.protectedPeriods = (options.protectedPeriods ?? DEFAULTS.protectedPeriods).map(period => ({
      startMs: toInstant(period.startsAt, 'protectedPeriods[].startsAt'),
      endMs: toInstant(period.endsAt, 'protectedPeriods[].endsAt'),
      reason: period.reason,
    }));
    this.queue = Promise.resolve(); // 所有变更与查询串行执行，容量核对不会交错
  }

  _enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  // 写前日志：先落盘再改内存；result 一并入事件，重启后幂等表随之恢复。
  async _commit(type, commandId, payload, buildResult) {
    const event = { seq: this.seq + 1, type, commandId, at: toUtcIso(this.now()), payload, result: null };
    const preview = applyEvent(structuredClone(this.state), event);
    event.result = buildResult(preview);
    await this.store.append(event);
    applyEvent(this.state, event);
    this.seq = event.seq;
    if (this.seq % SNAPSHOT_EVERY === 0) {
      await this.store.snapshot(this.state, this.seq);
    }
    return event.result;
  }

  _mustFind(requestId) {
    const request = this.state.requests[requestId];
    if (!request) throw new DomainError('not-found', `申请 ${requestId} 不存在`);
    return request;
  }

  // 有效人员占用：按联合检查组聚合，personnel 取组内在办成员的最大值。
  // 取消 / 过期 / 改期后申请离开 ACTIVE 状态，占用随之消失，不会留下幽灵占用。
  _activeLocks(excludeIds = new Set()) {
    const locks = [];
    for (const group of Object.values(this.state.groups)) {
      const members = group.memberIds
        .map(id => this.state.requests[id])
        .filter(request => request
          && request.groupId === group.groupId
          && ACTIVE_STATES.has(request.state)
          && !excludeIds.has(request.requestId));
      if (members.length === 0) continue;
      locks.push({
        groupId: group.groupId,
        startsAt: group.startsAt,
        endsAt: group.endsAt,
        startMs: group.startMs,
        endMs: group.endMs,
        personnel: Math.max(...members.map(member => member.personnelRequired)),
        memberIds: members.map(member => member.requestId),
      });
    }
    return locks;
  }

  _detectFor(candidate, excludeIds) {
    const holders = Object.values(this.state.requests).filter(request =>
      ACTIVE_STATES.has(request.state) && !excludeIds.has(request.requestId));
    return detectConflicts({
      candidate,
      holders,
      locks: this._activeLocks(excludeIds),
      protectedPeriods: this.protectedPeriods,
      rollingQuota: this.rollingQuota,
    });
  }

  _buildRequest(input) {
    if (!Array.isArray(input.topicCodes)) {
      throw new DomainError('invalid-input', 'topicCodes 必须是非空数组');
    }
    const topicCodes = [...new Set(input.topicCodes.map(topic => String(topic).trim()).filter(Boolean))];
    if (topicCodes.length === 0) {
      throw new DomainError('invalid-input', 'topicCodes 不能为空');
    }
    const startMs = toInstant(input.startsAt, 'startsAt');
    const endMs = toInstant(input.endsAt, 'endsAt');
    if (endMs <= startMs) {
      throw new DomainError('invalid-window', 'endsAt 必须晚于 startsAt');
    }
    const personnelRequired = input.personnelRequired ?? 1;
    if (!Number.isInteger(personnelRequired) || personnelRequired < 1) {
      throw new DomainError('invalid-input', 'personnelRequired 必须是正整数');
    }
    if (personnelRequired > this.totalPersonnel) {
      throw new DomainError('invalid-input', `personnelRequired 超过监测人员总数 ${this.totalPersonnel}`);
    }

    let requestId = input.requestId;
    let counter = null;
    if (requestId !== undefined && requestId !== null) {
      if (typeof requestId !== 'string' || !/^[\w][\w-]*$/.test(requestId)) {
        throw new DomainError('invalid-input', `requestId 不合法：${requestId}`);
      }
      if (this.state.requests[requestId]) {
        throw new DomainError('duplicate-request', `申请 ${requestId} 已存在`);
      }
    } else {
      let next = this.state.counters.request + 1;
      while (this.state.requests[`DRY-${next}`]) next += 1;
      requestId = `DRY-${next}`;
      counter = next;
    }

    return {
      record: {
        requestId,
        topicCodes,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        startMs,
        endMs,
        party: input.party !== undefined && input.party !== null ? String(input.party) : null,
        roomId: input.roomId !== undefined && input.roomId !== null ? String(input.roomId) : 'default',
        personnelRequired,
      },
      counter,
    };
  }

  async _sweepExpiredLocked() {
    const nowMs = this.now();
    const expired = Object.values(this.state.requests).filter(request =>
      request.state === 'window-held'
      && request.holdExpiresAtMs !== null
      && request.holdExpiresAtMs <= nowMs);
    for (const request of expired) {
      const commandId = `sweep:${request.requestId}:${request.holdExpiresAtMs}`;
      if (this.state.commands[commandId]) continue;
      await this._commit('request-expired', commandId, {
        requestId: request.requestId,
        reason: { at: toUtcIso(nowMs), code: 'expired', message: '保留期内未获批准，窗口与人员占用已释放' },
      }, () => ({ status: 200, body: { expired: request.requestId } }));
    }
    return expired.map(request => request.requestId);
  }

  sweepExpired() {
    return this._enqueue(() => this._sweepExpiredLocked());
  }

  snapshot() {
    return this._enqueue(async () => {
      await this.store.snapshot(this.state, this.seq);
    });
  }

  // ---- 命令 ----

  submitRequest(input = {}) {
    return this._enqueue(async () => {
      await this._sweepExpiredLocked();
      const commandId = input.commandId ?? randomUUID();
      const cached = this.state.commands[commandId];
      if (cached) return cached;
      try {
        const { record, counter } = this._buildRequest(input);
        const at = toUtcIso(this.now());
        const conflicts = this._detectFor(record, new Set([record.requestId]));
        const reasons = [{ at, code: 'submitted', message: '检查申请已受理' }];
        for (const conflict of conflicts) reasons.push(reasonFromConflict(conflict, at));
        const request = {
          ...record,
          state: conflicts.length > 0 ? 'negotiating' : 'submitted',
          groupId: null,
          holdExpiresAt: null,
          holdExpiresAtMs: null,
          reasons,
          conflicts,
          revision: 1,
          createdAt: at,
          updatedAt: at,
        };
        return await this._commit(
          'request-submitted',
          commandId,
          { request, counter },
          state => ({ status: 201, body: { request: publicRequest(state.requests[request.requestId]) } }),
        );
      } catch (err) {
        const result = errorResult(err);
        await this._commit('command-rejected', commandId, { op: 'submit' }, () => result);
        return result;
      }
    });
  }

  confirmRequest(requestId, input = {}) {
    return this._enqueue(async () => {
      await this._sweepExpiredLocked();
      const commandId = input.commandId ?? randomUUID();
      const cached = this.state.commands[commandId];
      if (cached) return cached;
      try {
        const target = this._mustFind(requestId);
        if (!CONFIRMABLE_STATES.has(target.state)) {
          throw new DomainError('invalid-state', `申请 ${requestId} 当前状态为 ${target.state}，不能确认`);
        }
        if (input.mergeWith !== undefined && !Array.isArray(input.mergeWith)) {
          throw new DomainError('invalid-input', 'mergeWith 必须是申请编号数组');
        }
        const mergeIds = [...new Set(input.mergeWith ?? [])].filter(id => id !== requestId);
        const members = [target, ...mergeIds.map(id => this._mustFind(id))];
        for (const member of members) {
          if (!CONFIRMABLE_STATES.has(member.state)) {
            throw new DomainError('invalid-state', `成员 ${member.requestId} 当前状态为 ${member.state}，不能参与合并确认`);
          }
          if ((member.roomId ?? 'default') !== (target.roomId ?? 'default')) {
            throw new DomainError('invalid-input', `成员 ${member.requestId} 与 ${requestId} 不在同一干燥间`);
          }
        }

        // 窗口：显式指定，否则取各方窗口的并集（联合检查覆盖全部主题）。
        let startsAt; let endsAt; let startMs; let endMs;
        if (input.startsAt !== undefined || input.endsAt !== undefined) {
          startMs = toInstant(input.startsAt, 'startsAt');
          endMs = toInstant(input.endsAt, 'endsAt');
          startsAt = input.startsAt;
          endsAt = input.endsAt;
        } else {
          startMs = Math.min(...members.map(member => member.startMs));
          endMs = Math.max(...members.map(member => member.endMs));
          startsAt = toUtcIso(startMs);
          endsAt = toUtcIso(endMs);
        }
        if (endMs <= startMs) {
          throw new DomainError('invalid-window', 'endsAt 必须晚于 startsAt');
        }

        const exclude = new Set(members.map(member => member.requestId));
        const candidate = {
          requestId,
          startMs,
          endMs,
          topicCodes: [...new Set(members.flatMap(member => member.topicCodes))],
          roomId: target.roomId ?? 'default',
        };
        const conflicts = this._detectFor(candidate, exclude);
        const at = toUtcIso(this.now());
        // 只有从未锁定的申请才转入协商态；已持有窗口的申请保持原状，仅记录受阻原因。
        const blockedState = OPEN_STATES.has(target.state) ? 'negotiating' : undefined;
        if (conflicts.length > 0) {
          const reason = { at, code: conflicts[0].kind, message: '确认时仍存在冲突，已转入协商', conflicts };
          return await this._commit(
            'request-annotated',
            commandId,
            { requestId, reason, state: blockedState, conflicts },
            state => ({
              status: 409,
              body: {
                error: { code: 'conflict', message: '检查窗口仍存在冲突', conflicts },
                request: publicRequest(state.requests[requestId]),
              },
            }),
          );
        }

        const needed = Math.max(...members.map(member => member.personnelRequired));
        const peak = peakUsage(this._activeLocks(exclude), startMs, endMs);
        if (peak + needed > this.totalPersonnel) {
          const reason = {
            at,
            code: 'capacity-exhausted',
            message: `窗口内可用监测人员不足：需要 ${needed}，峰值仅剩 ${this.totalPersonnel - peak}`,
          };
          return await this._commit(
            'request-annotated',
            commandId,
            { requestId, reason, state: blockedState, conflicts: [] },
            state => ({
              status: 409,
              body: {
                error: { code: 'capacity-exhausted', message: reason.message },
                request: publicRequest(state.requests[requestId]),
              },
            }),
          );
        }

        // 确认成功：组织联合检查组，锁定窗口与监测能力。
        const groupCounter = this.state.counters.group + 1;
        const groupId = `GRP-${groupCounter}`;
        const holdExpiresAtMs = this.now() + this.holdTtlMs;
        const merged = members.length > 1;
        const reasons = {};
        for (const member of members) {
          reasons[member.requestId] = [];
          if (merged) {
            reasons[member.requestId].push({
              at,
              code: 'merged',
              message: `并入联合检查组 ${groupId}`,
              relatedRequestIds: members.map(member2 => member2.requestId),
            });
          }
          reasons[member.requestId].push({ at, code: 'confirmed', message: '确认完成，监测窗口与人员已锁定' });
        }
        return await this._commit(
          'request-confirmed',
          commandId,
          {
            groupId,
            groupCounter,
            memberIds: members.map(member => member.requestId),
            startsAt,
            endsAt,
            startMs,
            endMs,
            holdExpiresAt: toUtcIso(holdExpiresAtMs),
            holdExpiresAtMs,
            reasons,
          },
          state => ({
            status: 200,
            body: {
              groupId,
              merged,
              requests: members.map(member => publicRequest(state.requests[member.requestId])),
            },
          }),
        );
      } catch (err) {
        const result = errorResult(err);
        await this._commit('command-rejected', commandId, { op: 'confirm', requestId }, () => result);
        return result;
      }
    });
  }

  approveRequest(requestId, input = {}) {
    return this._enqueue(async () => {
      await this._sweepExpiredLocked();
      const commandId = input.commandId ?? randomUUID();
      const cached = this.state.commands[commandId];
      if (cached) return cached;
      try {
        const request = this._mustFind(requestId);
        if (request.state !== 'window-held') {
          throw new DomainError('invalid-state', `申请 ${requestId} 当前状态为 ${request.state}，只有 window-held 可以批准`);
        }
        const reason = { at: toUtcIso(this.now()), code: 'approved', message: '检查已批准，监测能力保持锁定' };
        return await this._commit(
          'request-approved',
          commandId,
          { requestId, reason },
          state => ({ status: 200, body: { request: publicRequest(state.requests[requestId]) } }),
        );
      } catch (err) {
        const result = errorResult(err);
        await this._commit('command-rejected', commandId, { op: 'approve', requestId }, () => result);
        return result;
      }
    });
  }

  cancelRequest(requestId, input = {}) {
    return this._enqueue(async () => {
      await this._sweepExpiredLocked();
      const commandId = input.commandId ?? randomUUID();
      const cached = this.state.commands[commandId];
      if (cached) return cached;
      try {
        const request = this._mustFind(requestId);
        if (TERMINAL_STATES.has(request.state)) {
          throw new DomainError('invalid-state', `申请 ${requestId} 已处于终态 ${request.state}`);
        }
        const reason = {
          at: toUtcIso(this.now()),
          code: 'cancelled',
          message: typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : '申请已取消，占用已释放',
        };
        return await this._commit(
          'request-cancelled',
          commandId,
          { requestId, reason },
          state => ({ status: 200, body: { request: publicRequest(state.requests[requestId]) } }),
        );
      } catch (err) {
        const result = errorResult(err);
        await this._commit('command-rejected', commandId, { op: 'cancel', requestId }, () => result);
        return result;
      }
    });
  }

  rescheduleRequest(requestId, input = {}) {
    return this._enqueue(async () => {
      await this._sweepExpiredLocked();
      const commandId = input.commandId ?? randomUUID();
      const cached = this.state.commands[commandId];
      if (cached) return cached;
      try {
        const request = this._mustFind(requestId);
        if (TERMINAL_STATES.has(request.state)) {
          throw new DomainError('invalid-state', `申请 ${requestId} 已处于终态 ${request.state}，不能改期`);
        }
        const startMs = toInstant(input.startsAt, 'startsAt');
        const endMs = toInstant(input.endsAt, 'endsAt');
        if (endMs <= startMs) {
          throw new DomainError('invalid-window', 'endsAt 必须晚于 startsAt');
        }
        const at = toUtcIso(this.now());
        const exclude = new Set([requestId]);
        const candidate = {
          requestId,
          startMs,
          endMs,
          topicCodes: request.topicCodes,
          roomId: request.roomId ?? 'default',
        };
        // 改期先校验后落账：冲突或容量不足时原有窗口保持不变。
        const conflicts = this._detectFor(candidate, exclude);
        if (conflicts.length > 0) {
          const reason = { at, code: conflicts[0].kind, message: '改期目标窗口存在冲突，原窗口保持不变', conflicts };
          return await this._commit(
            'request-annotated',
            commandId,
            { requestId, reason },
            state => ({
              status: 409,
              body: {
                error: { code: 'conflict', message: '改期目标窗口存在冲突', conflicts },
                request: publicRequest(state.requests[requestId]),
              },
            }),
          );
        }
        const peak = peakUsage(this._activeLocks(exclude), startMs, endMs);
        if (peak + request.personnelRequired > this.totalPersonnel) {
          const reason = {
            at,
            code: 'capacity-exhausted',
            message: `改期目标窗口可用监测人员不足：需要 ${request.personnelRequired}，峰值仅剩 ${this.totalPersonnel - peak}`,
          };
          return await this._commit(
            'request-annotated',
            commandId,
            { requestId, reason },
            state => ({
              status: 409,
              body: {
                error: { code: 'capacity-exhausted', message: reason.message },
                request: publicRequest(state.requests[requestId]),
              },
            }),
          );
        }

        // 改期成功：原窗口占用随状态切换一并释放，不留幽灵占用。
        const groupCounter = this.state.counters.group + 1;
        const groupId = `GRP-${groupCounter}`;
        const holdExpiresAtMs = this.now() + this.holdTtlMs;
        const reason = { at, code: 'rescheduled', message: '改期成功，原窗口占用已释放，新窗口已锁定' };
        return await this._commit(
          'request-rescheduled',
          commandId,
          {
            requestId,
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            startMs,
            endMs,
            groupId,
            groupCounter,
            holdExpiresAt: toUtcIso(holdExpiresAtMs),
            holdExpiresAtMs,
            reason,
          },
          state => ({ status: 200, body: { request: publicRequest(state.requests[requestId]) } }),
        );
      } catch (err) {
        const result = errorResult(err);
        await this._commit('command-rejected', commandId, { op: 'reschedule', requestId }, () => result);
        return result;
      }
    });
  }

  // ---- 查询 ----

  getRequest(requestId) {
    return this._enqueue(async () => {
      await this._sweepExpiredLocked();
      const request = this.state.requests[requestId];
      if (!request) {
        return { status: 404, body: { error: { code: 'not-found', message: `申请 ${requestId} 不存在` } } };
      }
      return { status: 200, body: { request: publicRequest(request) } };
    });
  }

  listRequests(query = {}) {
    return this._enqueue(async () => {
      await this._sweepExpiredLocked();
      let all = Object.values(this.state.requests);
      if (query.state) all = all.filter(request => request.state === query.state);
      all = all.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.requestId.localeCompare(b.requestId));
      return { status: 200, body: { requests: all.map(publicRequest) } };
    });
  }

  getCalendar(query = {}) {
    return this._enqueue(async () => {
      await this._sweepExpiredLocked();
      try {
        const fromMs = query.from !== undefined ? toInstant(query.from, 'from') : -Infinity;
        const toMs = query.to !== undefined ? toInstant(query.to, 'to') : Infinity;
        if (toMs <= fromMs) throw new DomainError('invalid-window', 'to 必须晚于 from');
        const locks = this._activeLocks()
          .filter(lock => intervalsOverlap(lock.startMs, lock.endMs, fromMs, toMs))
          .map(lock => ({
            groupId: lock.groupId,
            startsAtUtc: toUtcIso(lock.startMs),
            endsAtUtc: toUtcIso(lock.endMs),
            personnel: lock.personnel,
            memberIds: lock.memberIds,
          }));
        const open = Object.values(this.state.requests)
          .filter(request => OPEN_STATES.has(request.state) && intervalsOverlap(request.startMs, request.endMs, fromMs, toMs))
          .map(publicRequest);
        return { status: 200, body: { generatedAt: toUtcIso(this.now()), locks, open } };
      } catch (err) {
        return errorResult(err);
      }
    });
  }

  getCapacity(query = {}) {
    return this._enqueue(async () => {
      await this._sweepExpiredLocked();
      try {
        const locks = this._activeLocks();
        const hasFrom = query.from !== undefined;
        const hasTo = query.to !== undefined;
        if (hasFrom !== hasTo) {
          throw new DomainError('invalid-window', 'from 与 to 必须同时提供');
        }
        if (hasFrom) {
          const fromMs = toInstant(query.from, 'from');
          const toMs = toInstant(query.to, 'to');
          if (toMs <= fromMs) throw new DomainError('invalid-window', 'to 必须晚于 from');
          const locked = peakUsage(locks, fromMs, toMs);
          return {
            status: 200,
            body: {
              from: toUtcIso(fromMs),
              to: toUtcIso(toMs),
              total: this.totalPersonnel,
              locked,
              available: this.totalPersonnel - locked,
            },
          };
        }
        const atMs = query.at !== undefined ? toInstant(query.at, 'at') : this.now();
        const locked = locks
          .filter(lock => lock.startMs <= atMs && atMs < lock.endMs)
          .reduce((sum, lock) => sum + lock.personnel, 0);
        return {
          status: 200,
          body: { at: toUtcIso(atMs), total: this.totalPersonnel, locked, available: this.totalPersonnel - locked },
        };
      } catch (err) {
        return errorResult(err);
      }
    });
  }
}
