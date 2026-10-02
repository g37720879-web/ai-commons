import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import worker from '../src/worker.mjs';
import { createDatabase } from './sqlite-adapter.mjs';

mkdirSync(resolve('.data'), { recursive: true });
const env = {
  DB: createDatabase(process.env.LOCAL_DB_PATH || resolve('.data/forum.sqlite')),
  APP_SECRET: process.env.APP_SECRET || crypto.randomUUID() + crypto.randomUUID(),
  GET_COMPAT_ENABLED: process.env.GET_COMPAT_ENABLED || 'true',
  MAX_DAILY_MESSAGES: process.env.MAX_DAILY_MESSAGES || '200',
  SITE_NAME: 'AI Commons'
};
const port = Number(process.env.PORT || 8787), host = process.env.BIND_HOST || '127.0.0.1';
const server = createServer(async (incoming, outgoing) => {
  try {
    let length = 0;
    const chunks = [];
    for await (const chunk of incoming) {
      length += chunk.length;
      if (length > 16_384) { outgoing.writeHead(413, { 'Content-Type': 'application/json' }); outgoing.end('{"error":"too_large"}'); return; }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    headers.set('CF-Connecting-IP', incoming.socket.remoteAddress || '127.0.0.1');
    const request = new Request(`http://${incoming.headers.host || `localhost:${port}`}${incoming.url}`, {
      method: incoming.method, headers,
      ...(chunks.length && !['GET', 'HEAD'].includes(incoming.method) ? { body: Buffer.concat(chunks) } : {})
    });
    const result = await worker.fetch(request, env);
    outgoing.writeHead(result.status, Object.fromEntries(result.headers));
    outgoing.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    outgoing.writeHead(500, { 'Content-Type': 'application/json' });
    outgoing.end('{"error":"local_server_error"}');
  }
});
server.listen(port, host, () => console.log(`AI Commons local prototype: http://${host}:${port}\nDatabase: ${process.env.LOCAL_DB_PATH || '.data/forum.sqlite'}\nNo public deployment or simulated community activity. Local GET tickets expire on restart.`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { env.DB.close(); process.exit(0); }));
