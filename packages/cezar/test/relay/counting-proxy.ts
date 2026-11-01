// A byte-blind WebSocket proxy that counts what the cezar socket sends, for the idle count:
//   tsx test/relay/counting-proxy.ts <listen port> <relay port>
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

const [listen, relay] = process.argv.slice(2).map(Number);
const server = createServer();
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on('upgrade', (request, socket, head) => {
  const url = request.url ?? '/';
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => name.startsWith('x-cezar-relay'))) as Record<string, string>;
  const upstream = new WebSocket(`ws://127.0.0.1:${relay}${url}`, { headers, perMessageDeflate: false });
  const pending: [Buffer, boolean][] = [];
  upstream.on('unexpected-response', (_request, response) => {
    socket.write(`HTTP/1.1 ${response.statusCode} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  });
  upstream.on('error', () => socket.destroy());
  wss.handleUpgrade(request, socket, head, (client) => {
    const cezar = url.startsWith('/v1/cezar/');
    client.on('message', (data, isBinary) => {
      if (cezar) {
        const text = isBinary ? `binary ${(data as Buffer).length}` : String(data).slice(0, 40);
        console.log(`${new Date().toISOString()} cezar->relay ${text}`);
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data as Buffer, { binary: isBinary });
      else pending.push([data as Buffer, isBinary]);
    });
    upstream.on('open', () => {
      for (const [data, isBinary] of pending.splice(0)) upstream.send(data, { binary: isBinary });
    });
    upstream.on('message', (data, isBinary) => client.send(data as Buffer, { binary: isBinary }));
    client.on('close', (code) => upstream.close(code >= 3000 || code === 1000 ? code : 1000));
    upstream.on('close', (code) => client.close(code >= 3000 || code === 1000 ? code : 1000));
  });
});
server.listen(listen, '127.0.0.1');
