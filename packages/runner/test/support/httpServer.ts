import http from 'node:http';
import type { Socket } from 'node:net';

export interface Recorded {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  /** Parsed JSON, or the raw text when it is not JSON, or undefined when empty. */
  body: unknown;
}

export type Handler = (
  req: Recorded,
  res: http.ServerResponse,
  raw: http.IncomingMessage,
) => void | Promise<void>;

export interface TestServer {
  url: string;
  port: number;
  requests: Recorded[];
  /** Sockets the server saw close, to assert a client hung up. */
  closedSockets: () => number;
  close(): Promise<void>;
}

/** Replies with a JSON body. */
export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// A local node:http server on port 0 that records every request before calling the handler.
export async function startServer(handler: Handler, host = '127.0.0.1'): Promise<TestServer> {
  const requests: Recorded[] = [];
  const sockets = new Set<Socket>();
  let closed = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body: unknown = text === '' ? undefined : text;
      try {
        if (text !== '') body = JSON.parse(text);
      } catch {
        // keep the raw text
      }
      const rec: Recorded = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body,
      };
      requests.push(rec);
      Promise.resolve(handler(rec, res, req)).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => {
      sockets.delete(s);
      closed++;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    port,
    requests,
    closedSockets: () => closed,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const s of sockets) s.destroy();
      }),
  };
}
