import { createServer, request as httpRequest } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from 'wrangler';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOOPBACK = '127.0.0.1';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK, () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function startStubOrigin(routes) {
  const sockets = new Set();
  const server = createServer((request, response) => {
    const chunks = [];
    let closed = false;
    response.on('close', () => {
      closed = true;
    });
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const path = new URL(request.url ?? '/', `http://${LOOPBACK}`).pathname;
      const route = routes[path];
      if (!route) {
        response.writeHead(404).end();
        return;
      }
      const reply =
        typeof route === 'function'
          ? route({ body: Buffer.concat(chunks).toString('utf8') })
          : route;
      setTimeout(() => {
        if (closed || response.destroyed) {
          reply.onSettled?.('dropped');
          return;
        }
        response.writeHead(reply.status, reply.headers);
        response.end(reply.body, () => reply.onSettled?.('sent'));
      }, reply.delayMilliseconds ?? 0);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const port = await listen(server);
  return {
    origin: `http://${LOOPBACK}:${port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    },
  };
}

export async function startIdleCutProxy({ targetPort, idleMilliseconds }) {
  const connections = new Set();
  let cuts = 0;
  const server = createTcpServer((client) => {
    const upstream = connect(targetPort, LOOPBACK);
    let timer;
    const cut = () => {
      cuts += 1;
      client.destroy();
      upstream.destroy();
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(cut, idleMilliseconds);
    };
    const end = () => {
      clearTimeout(timer);
      client.destroy();
      upstream.destroy();
      connections.delete(end);
    };
    connections.add(end);
    client.on('data', (chunk) => {
      if (timer === undefined) arm();
      upstream.write(chunk);
    });
    upstream.on('data', (chunk) => {
      arm();
      client.write(chunk);
    });
    client.on('close', end);
    upstream.on('close', end);
    client.on('error', end);
    upstream.on('error', end);
  });
  const port = await listen(server);
  return {
    port,
    cuts: () => cuts,
    close: async () => {
      for (const end of connections) end();
      await closeServer(server);
    },
  };
}

export function postJson({ port, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const startedAt = Date.now();
    const outgoing = httpRequest(
      {
        host: LOOPBACK,
        port,
        path,
        method: 'POST',
        agent: false,
        headers: { ...headers, 'Content-Length': String(payload.byteLength) },
      },
      (incoming) => {
        const headersAfterMilliseconds = Date.now() - startedAt;
        const received = [];
        const arrivals = [];
        incoming.on('data', (chunk) => {
          received.push(chunk);
          arrivals.push({ afterMilliseconds: Date.now() - startedAt, bytes: chunk.byteLength });
        });
        incoming.on('end', () =>
          resolve({
            status: incoming.statusCode ?? 0,
            headersAfterMilliseconds,
            contentType: incoming.headers['content-type'] ?? null,
            body: Buffer.concat(received).toString('utf8'),
            arrivals,
          }),
        );
        incoming.on('error', reject);
        incoming.on('close', () => {
          if (!incoming.complete)
            reject(new Error('The connection closed before the answer ended.'));
        });
      },
    );
    outgoing.on('error', (error) =>
      reject(new Error(`The connection closed before the answer ended: ${error.message}`)),
    );
    outgoing.end(payload);
  });
}

export function postJsonUntilFirstByte({ port, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const outgoing = httpRequest(
      {
        host: LOOPBACK,
        port,
        path,
        method: 'POST',
        agent: false,
        headers: { ...headers, 'Content-Length': String(payload.byteLength) },
      },
      (incoming) => {
        incoming.once('data', (chunk) => {
          outgoing.destroy();
          resolve({ status: incoming.statusCode ?? 0, firstBytes: chunk.toString('utf8') });
        });
        incoming.on('error', () => undefined);
      },
    );
    outgoing.on('error', (error) => {
      if (!outgoing.destroyed) reject(error);
    });
    outgoing.end(payload);
  });
}

export function postWithheldBody({ port, path, headers, firstChunk, declaredBytes }) {
  const sent = Buffer.from(firstChunk);
  let outgoing;
  const answered = new Promise((resolve, reject) => {
    outgoing = httpRequest(
      {
        host: LOOPBACK,
        port,
        path,
        method: 'POST',
        agent: false,
        headers: { ...headers, 'Content-Length': String(declaredBytes) },
      },
      (incoming) => {
        const received = [];
        incoming.on('data', (chunk) => received.push(chunk));
        incoming.on('end', () =>
          resolve({
            status: incoming.statusCode ?? 0,
            body: Buffer.concat(received).toString('utf8'),
          }),
        );
        incoming.on('error', reject);
      },
    );
    outgoing.on('error', reject);
  });
  answered.catch(() => undefined);
  outgoing.flushHeaders();
  outgoing.write(sent);
  let bytesSent = sent.byteLength;
  return {
    answered,
    bytesSent: () => bytesSent,
    finish: () => {
      const rest = Buffer.alloc(declaredBytes - bytesSent, ' ');
      bytesSent = declaredBytes;
      outgoing.end(rest);
    },
  };
}

async function wranglerCompatibilityDate() {
  const manifest = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const match = /^compatibility_date\s*=\s*"([^"]+)"/m.exec(manifest);
  if (!match) throw new Error('wrangler.toml declares no compatibility_date.');
  return match[1];
}

export async function startWorker(vars) {
  const server = createTestHarness({
    root: REPOSITORY_ROOT,
    workers: [
      {
        config: {
          name: 'app-ai-network-test',
          main: 'src/index.ts',
          compatibility_date: await wranglerCompatibilityDate(),
          rules: [{ type: 'Text', globs: ['**/*.md'], fallthrough: true }],
          durable_objects: {
            bindings: [{ name: 'AUDIT_SESSIONS', class_name: 'AuditSessionAuthority' }],
          },
          migrations: [{ tag: 'network-test', new_sqlite_classes: ['AuditSessionAuthority'] }],
          vars,
        },
      },
    ],
  });
  const { url } = await server.listen();
  return {
    port: Number(url.port),
    logs: () => server.getLogs().map((log) => log.message),
    close: () => server.close(),
  };
}
