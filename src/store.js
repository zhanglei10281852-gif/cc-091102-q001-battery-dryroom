// 持久化与恢复：JSONL 仅追加事件日志 + 周期快照。
// 所有写操作经由单一链条串行提交；命令幂等记录本身也是事件，重启后依然生效。
// 快照写临时文件后 rename 原子替换；启动时读最新快照再重放其后的事件。

import { mkdir, readFile, readdir, rename, appendFile, writeFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 1;
const SNAPSHOT_PREFIX = 'snapshot-';
const LOG_FILE = 'events.log';

export function createInitialState() {
  return {
    version: SCHEMA_VERSION,
    seq: 0,
    requests: new Map(), // requestId -> 申请记录
    proposals: new Map(), // proposalId -> 合并提案
    rooms: new Map(), // roomId -> { roomId, displayName, capacity }
    personnel: new Map(), // personId -> { personId, displayName, windows: [{start,end}] }
    protectedPeriods: new Map(), // periodId -> { periodId, roomId, start, end, reason }
    index: {
      command: new Map(), // commandId -> { op, result, at }
    },
  };
}

// 事件回放：所有状态变更只允许通过事件发生，保证重启后日历一致。
// 事件信封：{ seq, at, type, data }；type 在信封上，载荷在 data。
export function applyEvent(state, event) {
  state.seq = event.seq;
  const e = event.data;
  switch (event.type) {
    case 'room-registered':
      state.rooms.set(e.roomId, { roomId: e.roomId, displayName: e.displayName, capacity: e.capacity });
      break;
    case 'person-registered':
      state.personnel.set(e.personId, { personId: e.personId, displayName: e.displayName, windows: [] });
      break;
    case 'availability-added': {
      const person = state.personnel.get(e.personId);
      if (person) person.windows.push({ start: e.start, end: e.end });
      break;
    }
    case 'protected-period-added':
      state.protectedPeriods.set(e.periodId, {
        periodId: e.periodId, roomId: e.roomId || null, start: e.start, end: e.end, reason: e.reason || null,
      });
      break;
    case 'request-submitted':
      state.requests.set(e.requestId, {
        requestId: e.requestId,
        topicCodes: e.topicCodes,
        personIds: e.personIds,
        preferredRoomId: e.preferredRoomId,
        preferredWindow: e.preferredWindow,
        state: 'submitted',
        window: null,
        revision: 0,
        proposalId: null,
        history: [{ revision: 0, at: event.at, action: 'submitted' }],
        conflictReport: null,
        createdAt: event.at,
        updatedAt: event.at,
      });
      break;
    case 'request-evaluated': {
      const rec = state.requests.get(e.requestId);
      if (rec) {
        rec.state = e.state;
        rec.window = e.window;
        rec.conflictReport = e.conflictReport;
        rec.updatedAt = event.at;
        rec.history.push({ revision: rec.revision + 1, at: event.at, action: 'evaluated', state: e.state });
        rec.revision += 1;
      }
      break;
    }
    case 'request-held': {
      const rec = state.requests.get(e.requestId);
      if (rec) {
        rec.state = 'window-held';
        rec.window = e.window;
        rec.holdExpiresAt = e.holdExpiresAt;
        rec.updatedAt = event.at;
        rec.history.push({ revision: rec.revision + 1, at: event.at, action: 'window-held' });
        rec.revision += 1;
      }
      break;
    }
    case 'request-approved': {
      const rec = state.requests.get(e.requestId);
      if (rec) {
        rec.state = 'approved';
        rec.window = e.window;
        rec.holdExpiresAt = null;
        rec.approvedAt = event.at;
        rec.updatedAt = event.at;
        rec.history.push({ revision: rec.revision + 1, at: event.at, action: 'approved', proposalId: e.proposalId || null });
        rec.revision += 1;
      }
      break;
    }
    case 'request-cancelled': {
      const rec = state.requests.get(e.requestId);
      if (rec) {
        rec.state = 'cancelled';
        rec.holdExpiresAt = null;
        rec.proposalId = null;
        rec.updatedAt = event.at;
        rec.history.push({ revision: rec.revision + 1, at: event.at, action: 'cancelled', reason: e.reason || null });
        rec.revision += 1;
      }
      break;
    }
    case 'request-expired': {
      const rec = state.requests.get(e.requestId);
      if (rec) {
        rec.state = 'expired';
        rec.window = null;
        rec.holdExpiresAt = null;
        rec.proposalId = null;
        rec.updatedAt = event.at;
        rec.history.push({ revision: rec.revision + 1, at: event.at, action: 'expired' });
        rec.revision += 1;
      }
      break;
    }
    case 'request-rescheduled': {
      const rec = state.requests.get(e.requestId);
      if (rec) {
        rec.preferredWindow = e.window;
        rec.preferredRoomId = e.roomId;
        rec.window = null;
        rec.holdExpiresAt = null;
        rec.conflictReport = null;
        rec.state = 'submitted';
        rec.updatedAt = event.at;
        rec.history.push({ revision: rec.revision + 1, at: event.at, action: 'rescheduled' });
        rec.revision += 1;
      }
      break;
    }
    case 'proposal-created':
      state.proposals.set(e.proposalId, {
        proposalId: e.proposalId,
        requestIds: [...e.requestIds],
        window: e.window,
        state: 'proposed',
        responses: e.responses,
        createdAt: event.at,
        updatedAt: event.at,
        history: [{ at: event.at, action: 'created' }],
      });
      for (const id of e.requestIds) {
        const rec = state.requests.get(id);
        if (rec) {
          rec.proposalId = e.proposalId;
          rec.state = 'negotiating';
          rec.updatedAt = event.at;
        }
      }
      break;
    case 'proposal-responded': {
      const prop = state.proposals.get(e.proposalId);
      if (prop) {
        prop.responses[e.personId] = { decision: e.decision, at: event.at, reason: e.reason || null };
        prop.updatedAt = event.at;
        prop.history.push({ at: event.at, action: 'responded', personId: e.personId, decision: e.decision });
      }
      break;
    }
    case 'proposal-accepted': {
      const prop = state.proposals.get(e.proposalId);
      if (prop) {
        prop.state = 'accepted';
        prop.updatedAt = event.at;
        prop.history.push({ at: event.at, action: 'accepted' });
      }
      break;
    }
    case 'proposal-rejected': {
      const prop = state.proposals.get(e.proposalId);
      if (prop) {
        prop.state = 'rejected';
        prop.updatedAt = event.at;
        prop.history.push({ at: event.at, action: 'rejected', reason: e.reason || null });
        for (const id of prop.requestIds) {
          const rec = state.requests.get(id);
          if (rec && rec.proposalId === e.proposalId) {
            rec.proposalId = null;
            rec.state = 'submitted';
            rec.updatedAt = event.at;
          }
        }
      }
      break;
    }
    case 'proposal-cancelled': {
      const prop = state.proposals.get(e.proposalId);
      if (prop) {
        const wasAccepted = prop.state === 'accepted';
        prop.state = 'cancelled';
        prop.updatedAt = event.at;
        prop.history.push({ at: event.at, action: 'cancelled' });
        for (const id of prop.requestIds) {
          const rec = state.requests.get(id);
          if (rec && rec.proposalId === e.proposalId) {
            rec.proposalId = null;
            if (rec.state === 'negotiating') rec.state = 'submitted';
            // 已锁定的联合检查被拆散：其余获批成员回到未决并释放联合窗口，随后按个人日历重评。
            if (wasAccepted && rec.state === 'approved') {
              rec.state = 'submitted';
              rec.window = null;
              rec.holdExpiresAt = null;
              rec.history.push({ revision: rec.revision + 1, at: event.at, action: 'reopened', reason: 'joint-proposal-dissolved' });
              rec.revision += 1;
            }
            rec.updatedAt = event.at;
          }
        }
      }
      break;
    }
    case 'command-recorded':
      // 幂等回执：同一 commandId 重放（含重启后）直接返回首次结果。
      state.index.command.set(e.commandId, { op: e.op, result: e.result, at: event.at });
      break;
    default:
      // 未知事件跳过而非崩溃，前向兼容旧日志。
      break;
  }
  return state;
}

function serializeState(state) {
  return JSON.stringify({
    version: state.version,
    seq: state.seq,
    requests: [...state.requests.values()],
    proposals: [...state.proposals.values()],
    rooms: [...state.rooms.values()],
    personnel: [...state.personnel.values()],
    protectedPeriods: [...state.protectedPeriods.values()],
    commandIndex: [...state.index.command.entries()].map(([commandId, entry]) => [commandId, entry]),
  });
}

function deserializeState(json) {
  const state = createInitialState();
  const data = JSON.parse(json);
  state.version = data.version;
  state.seq = data.seq;
  for (const rec of data.requests || []) state.requests.set(rec.requestId, rec);
  for (const prop of data.proposals || []) state.proposals.set(prop.proposalId, prop);
  for (const room of data.rooms || []) state.rooms.set(room.roomId, room);
  for (const person of data.personnel || []) state.personnel.set(person.personId, person);
  for (const period of data.protectedPeriods || []) state.protectedPeriods.set(period.periodId, period);
  for (const [commandId, entry] of data.commandIndex || []) state.index.command.set(commandId, entry);
  return state;
}

export class EventStore {
  constructor(dataDir, { snapshotEvery = 200, clock = () => Date.now() } = {}) {
    this.dataDir = dataDir;
    this.snapshotEvery = snapshotEvery;
    this.clock = clock;
    this.state = createInitialState();
    this.logPath = path.join(dataDir, LOG_FILE);
    this.eventsSinceSnapshot = 0;
    this.chain = Promise.resolve();
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true });
    let state = createInitialState();
    let afterSeq = 0;
    let replayedAfterSnapshot = 0;

    const files = await readdir(this.dataDir).catch(() => []);
    const snapshots = files
      .filter((f) => f.startsWith(SNAPSHOT_PREFIX) && f.endsWith('.json'))
      .sort()
      .reverse();
    for (const file of snapshots) {
      try {
        const json = await readFile(path.join(this.dataDir, file), 'utf8');
        state = deserializeState(json);
        afterSeq = state.seq;
        break;
      } catch {
        // 损坏快照忽略，尝试更早的快照。
      }
    }

    if (existsSync(this.logPath)) {
      const raw = await readFile(this.logPath, 'utf8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          continue; // 末尾被截断的半行跳过
        }
        if (!event || typeof event.seq !== 'number') continue;
        if (event.seq <= afterSeq) continue; // 快照已覆盖
        applyEvent(state, event);
        replayedAfterSnapshot += 1;
      }
    }
    this.state = state;
    this.eventsSinceSnapshot = afterSeq ? replayedAfterSnapshot : state.seq;
    return state;
  }

  // 内部：调用方必须已持有串行链条。
  async _append(type, data) {
    const event = { seq: this.state.seq + 1, at: new Date(this.clock()).toISOString(), type, data };
    await appendFile(this.logPath, JSON.stringify(event) + '\n', { encoding: 'utf8' });
    applyEvent(this.state, event);
    this.eventsSinceSnapshot += 1;
    if (this.eventsSinceSnapshot >= this.snapshotEvery) {
      await this._snapshot();
      this.eventsSinceSnapshot = 0;
    }
    return event;
  }

  // 无命令号的内部事件（如自动过期）。
  commit(type, data) {
    const run = this.chain.then(() => this._append(type, data));
    this.chain = run.catch(() => {});
    return run;
  }

  // 带幂等键的串行事务：同一 commandId 重复到达只生效一次，重启后仍记得回执。
  // op 不同而 commandId 相同视为调用方错误（409）。对调用方透明：重放也返回首次结果。
  transaction(commandId, op, fn) {
    const run = this.chain.then(async () => {
      if (commandId) {
        const seen = this.state.index.command.get(commandId);
        if (seen) {
          if (seen.op !== op) {
            const err = new Error(`commandId ${commandId} 已用于操作 ${seen.op}，不能复用于 ${op}`);
            err.statusCode = 409;
            err.code = 'command-id-reuse';
            throw err;
          }
          return seen.result;
        }
      }
      const result = await fn({ append: (type, data) => this._append(type, data) });
      if (commandId) {
        await this._append('command-recorded', { commandId, op, result });
      }
      return result;
    });
    this.chain = run.catch(() => {});
    return run;
  }

  getCommand(commandId) {
    return this.state.index.command.get(commandId) || null;
  }

  async _snapshot() {
    const seq = this.state.seq;
    const tmp = path.join(this.dataDir, `${SNAPSHOT_PREFIX}${seq}.json.tmp`);
    const final = path.join(this.dataDir, `${SNAPSHOT_PREFIX}${seq}.json`);
    await writeFile(tmp, serializeState(this.state), { encoding: 'utf8' });
    await rename(tmp, final);
    // 只保留最新两个快照。
    const files = await readdir(this.dataDir).catch(() => []);
    const old = files.filter((f) => f.startsWith(SNAPSHOT_PREFIX) && f.endsWith('.json')).sort().reverse().slice(2);
    await Promise.all(old.map((f) => rm(path.join(this.dataDir, f), { force: true }).catch(() => {})));
  }

  async stats() {
    const s = await stat(this.logPath).catch(() => ({ size: 0 }));
    return { seq: this.state.seq, logBytes: s.size, dataDir: this.dataDir };
  }
}
