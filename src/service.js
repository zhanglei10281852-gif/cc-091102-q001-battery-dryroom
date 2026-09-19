// 业务编排：所有写操作走 EventStore 的串行幂等事务，领域判定全部基于归一时刻。
// 任何读取前先做一次过期清扫，保证取消、过期、改期都不会留下幽灵占用。

import { randomUUID } from 'node:crypto';
import {
  ApiError, ACTIVE_STATES, DEFAULT_ROOM, HOLD_TTL_MS,
  normalizeWindow, decide, evaluateWindow, findAlternatives, availabilityOf, roomLoad,
  occupants, overlaps, intersect, uniqSorted, windowView, toUtc,
} from './domain.js';

const newId = (prefix) => `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;

export class InspectionService {
  constructor(store, { clock = () => Date.now(), holdTtlMs = HOLD_TTL_MS } = {}) {
    this.store = store;
    this.clock = clock;
    this.holdTtlMs = holdTtlMs;
  }

  get state() { return this.store.state; }

  // -- 内部工具 -------------------------------------------------------------

  requireRequest(requestId) {
    const rec = this.state.requests.get(requestId);
    if (!rec) throw new ApiError(404, 'not-found', `申请 ${requestId} 不存在`, { requestId });
    return rec;
  }

  requireProposal(proposalId) {
    const prop = this.state.proposals.get(proposalId);
    if (!prop) throw new ApiError(404, 'not-found', `合并提案 ${proposalId} 不存在`, { proposalId });
    return prop;
  }

  checkRevision(rec, expected) {
    if (expected !== undefined && expected !== null && Number(expected) !== rec.revision) {
      throw new ApiError(409, 'revision-conflict', `申请已被其他操作更新（当前 revision=${rec.revision}）`, {
        requestId: rec.requestId, currentRevision: rec.revision, expectedRevision: Number(expected),
      });
    }
  }

  activeProposalOf(rec) {
    if (!rec.proposalId) return null;
    const prop = this.state.proposals.get(rec.proposalId);
    return prop && (prop.state === 'proposed' || prop.state === 'accepted') ? prop : null;
  }

  // 过期清扫：暂留超时释放；未确认申请越过其申请窗口即过期；悬而未决的
  // 合并提案越过窗口即作废。作为无命令号内部事务串行入链。
  async sweep() {
    return this.store.transaction(null, 'sweep', async ({ append }) => {
        const now = this.clock();
        const expired = [];
        for (const prop of [...this.state.proposals.values()]) {
          if (prop.state === 'proposed' && prop.window.end <= now) {
            await append('proposal-rejected', { proposalId: prop.proposalId, reason: 'window-expired' });
            expired.push(prop.proposalId);
          }
        }
        for (const rec of this.state.requests.values()) {
          if (rec.state === 'window-held' && rec.holdExpiresAt <= now) {
            await append('request-expired', { requestId: rec.requestId, reason: 'hold-ttl' });
            expired.push(rec.requestId);
            continue;
          }
          if ((rec.state === 'submitted' || rec.state === 'negotiating')
            && !this.activeProposalOf(rec) && rec.preferredWindow.end <= now) {
            await append('request-expired', { requestId: rec.requestId, reason: 'window-passed' });
            expired.push(rec.requestId);
          }
        }
        // 提案作废后回到 submitted、或仍在协商且无活跃提案的成员，按当前日历重新评估。
        for (const rec of this.state.requests.values()) {
          if ((rec.state === 'submitted' || rec.state === 'negotiating')
            && !this.activeProposalOf(rec) && rec.preferredWindow.end > now) {
            await this._reevaluate(append, rec, now);
          }
        }
        return { expired };
      });
  }

  // 评估并落到对应状态：无冲突→暂留窗口；有冲突→记录协商/受阻原因与备选窗口。
  // force=false（清扫路径）：仅在结论翻转（冲突解除→可暂留）时写事件，避免日志膨胀；
  // force=true（新提交/改期/提案拆散）：无论结论是否变化都刷新评估报告。
  async _reevaluate(append, rec, now = this.clock(), { force = false } = {}) {
    if (rec.preferredWindow.end <= now) {
      await append('request-expired', { requestId: rec.requestId, reason: 'window-passed' });
      return { outcome: 'expired', conflicts: [], alternatives: [], evaluatedAt: now };
    }
    const verdict = decide(this.state, rec, rec.preferredWindow, now);
    if (verdict.outcome === 'held') {
      if (!force && rec.state === 'window-held') return verdict;
      await append('request-held', {
        requestId: rec.requestId,
        window: { ...rec.preferredWindow, roomId: rec.preferredRoomId },
        holdExpiresAt: now + this.holdTtlMs,
      });
    } else {
      if (!force && rec.state === 'negotiating' && rec.conflictReport) return verdict;
      await append('request-evaluated', {
        requestId: rec.requestId,
        state: 'negotiating',
        window: null,
        conflictReport: verdict,
      });
    }
    return verdict;
  }

  // -- 基础数据 -------------------------------------------------------------

  async registerRoom(payload) {
    const roomId = payload.roomId || DEFAULT_ROOM;
    const capacity = Math.floor(payload.capacity ?? 1);
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new ApiError(400, 'invalid-capacity', 'capacity 必须是不小于 1 的整数');
    }
    await this.sweep();
    return this.store.transaction(payload.commandId, 'register-room', async ({ append }) => {
      if (this.state.rooms.has(roomId)) throw new ApiError(409, 'already-exists', `房间 ${roomId} 已登记`);
      await append('room-registered', { roomId, displayName: payload.displayName || roomId, capacity });
      return this.state.rooms.get(roomId);
    });
  }

  async registerPerson(payload) {
    const personId = payload.personId;
    if (!personId) throw new ApiError(400, 'missing-person', 'personId 必填');
    await this.sweep();
    return this.store.transaction(payload.commandId, 'register-person', async ({ append }) => {
      if (this.state.personnel.has(personId)) throw new ApiError(409, 'already-exists', `人员 ${personId} 已登记`);
      await append('person-registered', { personId, displayName: payload.displayName || personId });
      return this.state.personnel.get(personId);
    });
  }

  async addAvailability(personId, payload) {
    await this.sweep();
    return this.store.transaction(payload.commandId, 'add-availability', async ({ append }) => {
      if (!this.state.personnel.has(personId)) throw new ApiError(404, 'not-found', `人员 ${personId} 未登记`);
      const windows = (Array.isArray(payload.windows) ? payload.windows : [payload.window]).filter(Boolean);
      if (!windows.length) throw new ApiError(400, 'missing-window', 'window 或 windows 必填');
      const added = [];
      for (const item of windows) {
        const win = normalizeWindow(item, { label: '可用时间' });
        await append('availability-added', { personId, ...win });
        added.push(win);
      }
      return { personId, added: added.map(windowView) };
    });
  }

  async addProtectedPeriod(payload) {
    const win = normalizeWindow(payload.window, { label: '保护时段' });
    const periodId = payload.periodId || newId('BAN');
    await this.sweep();
    return this.store.transaction(payload.commandId, 'add-protected-period', async ({ append }) => {
      if (this.state.protectedPeriods.has(periodId)) throw new ApiError(409, 'already-exists', `保护时段 ${periodId} 已存在`);
      await append('protected-period-added', {
        periodId, roomId: payload.roomId || null, reason: payload.reason || null, ...win,
      });
      return this.state.protectedPeriods.get(periodId);
    });
  }

  // -- 检查申请 -------------------------------------------------------------

  async submitRequest(payload) {
    if (!payload.commandId) throw new ApiError(400, 'missing-command-id', 'commandId 必填，用于幂等去重');
    const topicCodes = uniqSorted(payload.topicCodes || []);
    const personIds = uniqSorted(payload.personIds || []);
    if (!topicCodes.length) throw new ApiError(400, 'missing-topic', 'topicCodes 至少包含一个材料主题');
    if (!personIds.length) throw new ApiError(400, 'missing-people', 'personIds 至少包含一名参与人员');
    const win = normalizeWindow(payload.window, { label: '申请窗口' });
    const roomId = payload.roomId || DEFAULT_ROOM;
    const requestId = payload.requestId || newId('DRY');

    await this.sweep();
    return this.store.transaction(payload.commandId, 'submit-request', async ({ append }) => {
      if (this.state.requests.has(requestId)) throw new ApiError(409, 'already-exists', `申请 ${requestId} 已存在`);
      if (!this.state.rooms.has(roomId)) throw new ApiError(422, 'unknown-room', `房间 ${roomId} 尚未登记，请先配置监测能力`);
      for (const personId of personIds) {
        if (!this.state.personnel.has(personId)) {
          throw new ApiError(422, 'unknown-person', `人员 ${personId} 尚未登记`, { personId });
        }
      }
      await append('request-submitted', {
        requestId, topicCodes, personIds, preferredRoomId: roomId, preferredWindow: win,
      });
      const rec = this.state.requests.get(requestId);
      await this._reevaluate(append, rec, this.clock(), { force: true });
      return this.requestView(this.state.requests.get(requestId));
    });
  }

  async confirmRequest(requestId, payload = {}) {
    if (!payload.commandId) throw new ApiError(400, 'missing-command-id', 'commandId 必填，用于幂等去重');
    await this.sweep();
    return this.store.transaction(payload.commandId, 'confirm-request', async ({ append }) => {
      const rec = this.requireRequest(requestId);
      this.checkRevision(rec, payload.revision);
      const prop = this.activeProposalOf(rec);
      if (prop && prop.state === 'proposed') {
        throw new ApiError(409, 'proposal-pending', '该申请属于待表决的合并提案，请在提案上统一表决确认', {
          proposalId: prop.proposalId, pendingResponders: this._pendingResponders(prop),
        });
      }
      if (rec.state === 'approved') return this.requestView(rec);
      if (rec.state === 'cancelled' || rec.state === 'expired') {
        throw new ApiError(409, 'request-inactive', `申请当前为 ${rec.state}，无法确认`);
      }
      if (rec.state !== 'window-held' || !rec.window) {
        throw new ApiError(409, 'no-held-window', '当前没有可确认的暂留窗口，请改期或等待协商结果', {
          conflictReport: rec.conflictReport,
        });
      }
      // 确认前复检：暂留期间日历可能变化。
      const conflicts = evaluateWindow(this.state, {
        selfRequestId: rec.requestId, roomId: rec.window.roomId,
        start: rec.window.start, end: rec.window.end,
        topicCodes: rec.topicCodes, personIds: rec.personIds,
      });
      if (conflicts.length) {
        await append('request-evaluated', { requestId, state: 'negotiating', window: null, conflictReport: {
          outcome: 'negotiating', conflicts, alternatives: findAlternatives(this.state, {
            roomId: rec.window.roomId, start: rec.window.start, end: rec.window.end,
            topicCodes: rec.topicCodes, personIds: rec.personIds,
          }, this.clock()), evaluatedAt: this.clock(),
        } });
        throw new ApiError(409, 'window-no-longer-available', '暂留窗口在确认时已不再可用', { conflicts });
      }
      await append('request-approved', { requestId, window: rec.window, proposalId: rec.proposalId || null });
      return this.requestView(this.state.requests.get(requestId));
    });
  }

  async cancelRequest(requestId, payload = {}) {
    if (!payload.commandId) throw new ApiError(400, 'missing-command-id', 'commandId 必填，用于幂等去重');
    await this.sweep();
    return this.store.transaction(payload.commandId, 'cancel-request', async ({ append }) => {
      const rec = this.requireRequest(requestId);
      this.checkRevision(rec, payload.revision);
      if (rec.state === 'cancelled') return this.requestView(rec);
      if (rec.state === 'expired') throw new ApiError(409, 'request-inactive', '申请已过期，无需取消');
      if (rec.state === 'approved' && rec.window && rec.window.end <= this.clock()) {
        throw new ApiError(409, 'request-inactive', '已完成的检查窗口不能取消');
      }
      const prop = rec.proposalId ? this.state.proposals.get(rec.proposalId) : null;
      const proposalWasActive = !!(prop && (prop.state === 'proposed' || prop.state === 'accepted'));
      if (proposalWasActive) {
        // 任一参与方退出：待表决或已锁定的提案整体作废，其余申请回到各自日历重新评估。
        await append('proposal-cancelled', { proposalId: prop.proposalId, by: requestId });
      }
      await append('request-cancelled', { requestId, reason: payload.reason || null });
      if (proposalWasActive) {
        for (const id of prop.requestIds) {
          if (id === requestId) continue;
          const other = this.state.requests.get(id);
          if (other && other.state === 'submitted' && other.preferredWindow.end > this.clock()) {
            await this._reevaluate(append, other, this.clock(), { force: true });
          }
        }
      }
      return this.requestView(this.state.requests.get(requestId));
    });
  }

  async rescheduleRequest(requestId, payload) {
    if (!payload.commandId) throw new ApiError(400, 'missing-command-id', 'commandId 必填，用于幂等去重');
    const win = normalizeWindow(payload.window, { label: '新窗口' });
    const roomId = payload.roomId || null;
    await this.sweep();
    return this.store.transaction(payload.commandId, 'reschedule-request', async ({ append }) => {
      const rec = this.requireRequest(requestId);
      this.checkRevision(rec, payload.revision);
      if (!ACTIVE_STATES.includes(rec.state)) {
        throw new ApiError(409, 'request-inactive', `申请当前为 ${rec.state}，不能改期，请重新提交`);
      }
      const prop = rec.proposalId ? this.state.proposals.get(rec.proposalId) : null;
      const proposalWasActive = !!(prop && (prop.state === 'proposed' || prop.state === 'accepted'));
      if (proposalWasActive) {
        await append('proposal-cancelled', { proposalId: prop.proposalId, reason: 'member-rescheduled', by: requestId });
      }
      const targetRoom = roomId || rec.preferredRoomId || DEFAULT_ROOM;
      if (!this.state.rooms.has(targetRoom)) throw new ApiError(422, 'unknown-room', `房间 ${targetRoom} 尚未登记`);
      await append('request-rescheduled', { requestId, roomId: targetRoom, window: win });
      const updated = this.state.requests.get(requestId);
      // 旧窗口/暂留在事件中已清空——不会留下幽灵占用。
      await this._reevaluate(append, updated, this.clock(), { force: true });
      if (proposalWasActive) {
        for (const id of prop.requestIds) {
          if (id === requestId) continue;
          const other = this.state.requests.get(id);
          if (other && other.state === 'submitted' && other.preferredWindow.end > this.clock()) {
            await this._reevaluate(append, other, this.clock(), { force: true });
          }
        }
      }
      return this.requestView(this.state.requests.get(requestId));
    });
  }

  // -- 合并提案 -------------------------------------------------------------

  _pendingResponders(prop) {
    const required = this._requiredResponders(prop);
    return required.filter((personId) => prop.responses[personId]?.decision !== 'accepted');
  }

  _requiredResponders(prop) {
    const set = new Set();
    for (const id of prop.requestIds) {
      const rec = this.state.requests.get(id);
      if (rec) rec.personIds.forEach((p) => set.add(p));
    }
    return [...set].sort();
  }

  async createProposal(payload) {
    if (!payload.commandId) throw new ApiError(400, 'missing-command-id', 'commandId 必填，用于幂等去重');
    const requestIds = uniqSorted(payload.requestIds || []);
    if (requestIds.length < 2) throw new ApiError(400, 'not-enough-requests', '合并提案至少需要两份申请');
    await this.sweep();
    return this.store.transaction(payload.commandId, 'create-proposal', async ({ append }) => {
      const recs = requestIds.map((id) => this.requireRequest(id));
      for (const rec of recs) {
        if (!ACTIVE_STATES.includes(rec.state)) {
          throw new ApiError(409, 'request-inactive', `申请 ${rec.requestId} 当前为 ${rec.state}，不能参与合并`);
        }
        const prop = this.activeProposalOf(rec);
        if (prop) throw new ApiError(409, 'proposal-pending', `申请 ${rec.requestId} 已在提案 ${prop.proposalId} 中`);
      }
      const topics = recs.reduce((acc, rec) => intersect(acc.length ? acc : rec.topicCodes, rec.topicCodes));
      const allPeople = uniqSorted(recs.flatMap((r) => r.personIds));
      const sharedPeople = allPeople.filter((p) => recs.filter((r) => r.personIds.includes(p)).length > 1);
      if (!topics.length && !sharedPeople.length) {
        throw new ApiError(422, 'no-overlap', '申请之间既无材料主题重合也无共同人员，不构成联合检查');
      }
      // 公共窗口 = 各申请偏好窗口（绝对时刻）的交集；客户端也可显式指定。
      let window;
      let roomId;
      if (payload.window) {
        window = normalizeWindow(payload.window, { label: '合并窗口' });
        roomId = payload.roomId || recs[0].preferredRoomId;
      } else {
        const start = Math.max(...recs.map((r) => r.preferredWindow.start));
        const end = Math.min(...recs.map((r) => r.preferredWindow.end));
        if (start >= end) {
          throw new ApiError(422, 'no-common-window', '各申请偏好窗口在绝对时间轴上没有公共交集，请显式给出合并窗口', {
            preferredWindows: recs.map((r) => ({ requestId: r.requestId, ...windowView(r.preferredWindow) })),
          });
        }
        window = { start, end, startsAt: toUtc(start), endsAt: toUtc(end) };
        const rooms = uniqSorted(recs.map((r) => r.preferredRoomId));
        roomId = payload.roomId || (rooms.length === 1 ? rooms[0] : null);
        if (!roomId) throw new ApiError(400, 'missing-room', '申请分布在不同房间，合并窗口必须指定 roomId');
      }
      if (!this.state.rooms.has(roomId)) throw new ApiError(422, 'unknown-room', `房间 ${roomId} 尚未登记`);
      window = { ...window, roomId };
      const candidate = {
        selfRequestId: null, groupRequestIds: requestIds, roomId,
        start: window.start, end: window.end, topicCodes: topics, personIds: allPeople,
      };
      const conflicts = evaluateWindow(this.state, candidate);
      if (conflicts.length) {
        throw new ApiError(409, 'proposal-window-conflict', '合并窗口存在冲突，无法发起联合确认', {
          conflicts,
          alternatives: findAlternatives(this.state, candidate, this.clock()),
        });
      }
      const proposalId = payload.proposalId || newId('PROP');
      if (this.state.proposals.has(proposalId)) throw new ApiError(409, 'already-exists', `提案 ${proposalId} 已存在`);
      await append('proposal-created', {
        proposalId, requestIds, window,
        responses: Object.fromEntries(allPeople.map((p) => [p, null])),
      });
      return this.proposalView(this.state.proposals.get(proposalId));
    });
  }

  async respondProposal(proposalId, payload) {
    if (!payload.commandId) throw new ApiError(400, 'missing-command-id', 'commandId 必填，用于幂等去重');
    const decision = payload.decision === 'accept' ? 'accepted' : payload.decision === 'decline' ? 'declined' : null;
    if (!decision) throw new ApiError(400, 'invalid-decision', "decision 必须是 'accept' 或 'decline'");
    const personId = payload.personId;
    if (!personId) throw new ApiError(400, 'missing-person', 'personId 必填');
    await this.sweep();
    return this.store.transaction(payload.commandId, 'respond-proposal', async ({ append }) => {
      const prop = this.requireProposal(proposalId);
      if (prop.state !== 'proposed') throw new ApiError(409, 'proposal-not-open', `提案当前为 ${prop.state}`);
      if (!(personId in prop.responses)) {
        throw new ApiError(422, 'not-a-responder', `人员 ${personId} 不是该提案的确认方`);
      }
      if (prop.responses[personId]?.decision) {
        throw new ApiError(409, 'already-responded', `人员 ${personId} 已表决`, { response: prop.responses[personId] });
      }
      await append('proposal-responded', { proposalId, personId, decision, reason: payload.reason || null });

      if (decision === 'declined') {
        await append('proposal-rejected', { proposalId, reason: payload.reason || 'declined', by: personId });
        for (const id of prop.requestIds) {
          const rec = this.state.requests.get(id);
          if (rec && rec.state === 'submitted' && rec.preferredWindow.end > this.clock()) {
            await this._reevaluate(append, rec, this.clock(), { force: true });
          }
        }
        return this.proposalView(this.state.proposals.get(proposalId));
      }

      const pending = this._pendingResponders(this.state.proposals.get(proposalId));
      if (pending.length) return this.proposalView(this.state.proposals.get(proposalId));

      // 全员接受：复检窗口后统一锁定一个监测能力位。
      const allTopics = uniqSorted(prop.requestIds.flatMap((id) => this.state.requests.get(id)?.topicCodes || []));
      const allPeople = uniqSorted(prop.requestIds.flatMap((id) => this.state.requests.get(id)?.personIds || []));
      const conflicts = evaluateWindow(this.state, {
        selfRequestId: null, groupRequestIds: prop.requestIds, roomId: prop.window.roomId,
        start: prop.window.start, end: prop.window.end, topicCodes: allTopics, personIds: allPeople,
      });
      if (conflicts.length) {
        await append('proposal-rejected', { proposalId, reason: 'conflict-changed' });
        for (const id of prop.requestIds) {
          const rec = this.state.requests.get(id);
          if (rec && rec.state === 'submitted' && rec.preferredWindow.end > this.clock()) {
            await this._reevaluate(append, rec, this.clock(), { force: true });
          }
        }
        throw new ApiError(409, 'window-no-longer-available', '全员确认时窗口已发生变化，提案作废', { conflicts });
      }
      await append('proposal-accepted', { proposalId });
      for (const id of prop.requestIds) {
        await append('request-approved', { requestId: id, window: prop.window, proposalId });
      }
      return this.proposalView(this.state.proposals.get(proposalId));
    });
  }

  // -- 查询 -----------------------------------------------------------------

  requestView(rec) {
    let verdict = rec.state;
    if (rec.state === 'submitted' || rec.state === 'negotiating') {
      // 协商/受阻是同一存储状态下的评估结论，由冲突报告区分。
      verdict = rec.conflictReport?.outcome === 'blocked' ? 'blocked'
        : rec.conflictReport ? 'negotiating' : 'submitted';
    }
    return {
      requestId: rec.requestId,
      state: rec.state,
      verdict,
      revision: rec.revision,
      topicCodes: rec.topicCodes,
      personIds: rec.personIds,
      proposalId: rec.proposalId,
      preferredRoomId: rec.preferredRoomId,
      preferredWindow: rec.preferredWindow
        ? windowView({ ...rec.preferredWindow, roomId: rec.preferredRoomId })
        : null,
      window: windowView(rec.window),
      holdExpiresAt: rec.holdExpiresAt ? toUtc(rec.holdExpiresAt) : null,
      conflictReport: rec.conflictReport ? {
        outcome: rec.conflictReport.outcome,
        evaluatedAt: rec.conflictReport.evaluatedAt ? toUtc(rec.conflictReport.evaluatedAt) : null,
        conflicts: rec.conflictReport.conflicts,
        alternatives: rec.conflictReport.alternatives,
      } : null,
      reasons: this._reasons(rec),
      history: rec.history,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
    };
  }

  // 负责人视角：这份申请为何获准 / 协商 / 受阻。
  _reasons(rec) {
    if (rec.state === 'approved') {
      return [{ code: 'approved', message: rec.proposalId
        ? `联合检查已确认，占用房间 ${rec.window?.roomId} 的一个监测位（提案 ${rec.proposalId}）`
        : `窗口无冲突，监测能力已锁定：房间 ${rec.window?.roomId}` }];
    }
    if (rec.state === 'window-held') {
      return [{ code: 'window-held', message: '窗口无冲突已暂留，需在保留期内确认锁定', holdExpiresAt: rec.holdExpiresAt ? toUtc(rec.holdExpiresAt) : null }];
    }
    if (rec.state === 'cancelled') return [{ code: 'cancelled', message: '申请已取消，占用已释放' }];
    if (rec.state === 'expired') return [{ code: 'expired', message: '窗口过期或暂留超时未确认，占用已释放' }];
    const report = rec.conflictReport;
    if (!report) return [{ code: 'pending-evaluation', message: '等待日历评估' }];
    const reasons = report.conflicts.map((c) => ({ code: c.kind, message: c.message, suggestion: c.suggestion, details: c }));
    if (report.alternatives?.length) {
      reasons.push({ code: 'alternatives-available', message: `存在 ${report.alternatives.length} 个无冲突备选窗口`, alternatives: report.alternatives });
    }
    if (report.outcome === 'blocked' && !report.alternatives.length) {
      reasons.push({ code: 'blocked', message: '近期没有可合并对象或可用窗口，申请受阻' });
    }
    return reasons;
  }

  proposalView(prop) {
    const required = this._requiredResponders(prop);
    const responses = Object.fromEntries(Object.entries(prop.responses).map(([k, v]) => [k, v || { decision: 'pending' }]));
    const acceptedCount = Object.values(prop.responses).filter((r) => r?.decision === 'accepted').length;
    return {
      proposalId: prop.proposalId,
      state: prop.state,
      requestIds: [...prop.requestIds],
      roomId: prop.window.roomId,
      window: windowView(prop.window),
      responders: required,
      responses,
      acceptedCount,
      requiredCount: required.length,
      pendingResponders: required.filter((p) => prop.responses[p]?.decision !== 'accepted'),
      history: prop.history,
      createdAt: prop.createdAt,
      updatedAt: prop.updatedAt,
    };
  }

  async listRequests({ state = null } = {}) {
    await this.sweep();
    let items = [...this.state.requests.values()];
    if (state) items = items.filter((r) => r.state === state);
    return items.map((r) => this.requestView(r));
  }

  async getRequest(requestId) {
    await this.sweep();
    return this.requestView(this.requireRequest(requestId));
  }

  async listProposals() {
    await this.sweep();
    return [...this.state.proposals.values()].map((p) => this.proposalView(p));
  }

  async getProposal(proposalId) {
    await this.sweep();
    return this.proposalView(this.requireProposal(proposalId));
  }

  async calendar(query = {}) {
    await this.sweep();
    const now = this.clock();
    const start = query.from ? Date.parse(query.from) : now;
    const end = query.to ? Date.parse(query.to) : now + 7 * 24 * 60 * 60 * 1000;
    if (Number.isNaN(start) || Number.isNaN(end) || start >= end) {
      throw new ApiError(400, 'invalid-range', 'from/to 必须是有效时间且 from < to');
    }
    const slots = occupants(this.state)
      .filter((o) => (!query.roomId || o.roomId === query.roomId) && overlaps(o, { start, end }))
      .map((o) => ({
        kind: o.kind, id: o.id, requestIds: o.requestIds, roomId: o.roomId,
        window: windowView(o), topicCodes: o.topicCodes, personIds: o.personIds,
      }));
    const rooms = [...this.state.rooms.values()].map((room) => {
      const load = roomLoad(this.state, room.roomId, start, end);
      return { ...load, window: { startsAtUtc: toUtc(start), endsAtUtc: toUtc(end) } };
    });
    return { from: toUtc(start), to: toUtc(end), slots, rooms };
  }

  async availability(query = {}) {
    await this.sweep();
    const now = this.clock();
    const start = query.from ? Date.parse(query.from) : now;
    const end = query.to ? Date.parse(query.to) : now + 24 * 60 * 60 * 1000;
    if (Number.isNaN(start) || Number.isNaN(end) || start >= end) {
      throw new ApiError(400, 'invalid-range', 'from/to 必须是有效时间且 from < to');
    }
    let personIds = null;
    if (query.personIds) {
      personIds = String(query.personIds).split(',').map((s) => s.trim()).filter(Boolean);
    }
    const result = availabilityOf(this.state, { start, end, personIds });
    return {
      from: toUtc(start), to: toUtc(end),
      availableCount: result.availableCount,
      total: result.total,
      available: result.available,
      busy: result.busy,
      unavailable: result.unavailable,
    };
  }
}
