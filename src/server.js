import { createServer } from 'node:http';
const server = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ service: 'dryroom-inspection', status: 'running' })); });
server.listen(Number(process.env.PORT || 8080));
