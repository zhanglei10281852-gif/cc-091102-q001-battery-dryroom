import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { applyEvent, EMPTY_STATE } from './reducer.js';

// 追加式事件日志（data/events.jsonl）+ 定期快照（data/snapshot.json）。
// 启动时先读快照，再回放其后的日志事件，恢复出一致的状态。
export class EventStore {
  constructor(dir) {
    this.dir = dir;
    this.logPath = join(dir, 'events.jsonl');
    this.snapshotPath = join(dir, 'snapshot.json');
  }

  async load() {
    await fs.mkdir(this.dir, { recursive: true });
    let state = EMPTY_STATE();
    let seq = 0;

    try {
      const snapshot = JSON.parse(await fs.readFile(this.snapshotPath, 'utf8'));
      state = snapshot.state;
      seq = snapshot.seq;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    let raw = '';
    try {
      raw = await fs.readFile(this.logPath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    const lines = raw.split('\n').filter(line => line.trim().length > 0);
    for (let i = 0; i < lines.length; i += 1) {
      let event;
      try {
        event = JSON.parse(lines[i]);
      } catch (err) {
        // 崩溃可能留下最后半行未写完的日志，忽略它；中间的损坏则必须暴露。
        if (i === lines.length - 1) break;
        throw err;
      }
      if (event.seq <= seq) continue;
      applyEvent(state, event);
      seq = event.seq;
    }
    return { state, seq };
  }

  async append(event) {
    await fs.appendFile(this.logPath, `${JSON.stringify(event)}\n`);
  }

  async snapshot(state, seq) {
    const tmp = `${this.snapshotPath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ seq, state }));
    await fs.rename(tmp, this.snapshotPath);
  }
}
