// 启动入口：加载持久化状态后开始受理请求。DATA_DIR 默认 ./data。
import { EventStore } from './store.js';
import { InspectionService } from './service.js';
import { createApp } from './http.js';

const dataDir = process.env.DATA_DIR || new URL('../data/', import.meta.url).pathname;
const port = Number(process.env.PORT || 8080);

const store = new EventStore(dataDir, { snapshotEvery: Number(process.env.SNAPSHOT_EVENTS || 200) });
await store.load();
const service = new InspectionService(store);
const server = createApp(service);

server.listen(port, () => {
  console.log(JSON.stringify({ service: 'dryroom-inspection', status: 'listening', port, dataDir, seq: store.state.seq }));
});

const shutdown = (signal) => {
  console.log(JSON.stringify({ event: 'shutdown', signal }));
  server.close(() => process.exit(0));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
