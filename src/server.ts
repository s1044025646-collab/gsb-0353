import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { SimError } from './types.js';
import { Service } from './service.js';
import type { Store } from './store.js';

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: (ctx: Ctx) => Promise<unknown> | unknown;
}

interface Ctx {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 2_000_000) {
        reject(new SimError('E_BAD_REQUEST', '请求体超过 2MB'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new SimError('E_BAD_REQUEST', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function createApp(store: Store): Server {
  const service = new Service(store);

  const routes: Route[] = [
    {
      method: 'POST',
      pattern: /^\/validate$/,
      keys: [],
      handler: ({ body }) => service.validate(body),
    },
    {
      method: 'POST',
      pattern: /^\/scenarios$/,
      keys: [],
      handler: ({ body }) => {
        const created = service.create(body);
        return { id: created.id, state: created.state };
      },
    },
    { method: 'GET', pattern: /^\/scenarios$/, keys: [], handler: () => service.list() },
    {
      method: 'GET',
      pattern: /^\/scenarios\/(\d+)$/,
      keys: ['id'],
      handler: ({ params }) => service.export(Number(params.id)).scenario,
    },
    {
      method: 'POST',
      pattern: /^\/scenarios\/(\d+)\/step$/,
      keys: ['id'],
      handler: ({ params }) => service.stepOnce(Number(params.id)),
    },
    {
      method: 'POST',
      pattern: /^\/scenarios\/(\d+)\/run$/,
      keys: ['id'],
      handler: ({ params, body }) => {
        const budget = (body as { budget?: number })?.budget ?? 100;
        return service.run(Number(params.id), Number(budget));
      },
    },
    {
      method: 'GET',
      pattern: /^\/scenarios\/(\d+)\/queues$/,
      keys: ['id'],
      handler: ({ params }) => service.queues(Number(params.id)),
    },
    {
      method: 'GET',
      pattern: /^\/scenarios\/(\d+)\/logs$/,
      keys: ['id'],
      handler: ({ params, query }) => {
        const from = query.get('from');
        const fromStep = from === null ? undefined : Number(from);
        if (from !== null && (fromStep === undefined || !Number.isInteger(fromStep) || fromStep < 1)) {
          throw new SimError('E_BAD_PARAM', 'from 必须是 >= 1 的整数');
        }
        return service.logs(Number(params.id), fromStep);
      },
    },
    {
      method: 'GET',
      pattern: /^\/scenarios\/(\d+)\/state$/,
      keys: ['id'],
      handler: ({ params }) => service.state(Number(params.id)),
    },
    {
      method: 'GET',
      pattern: /^\/scenarios\/(\d+)\/export$/,
      keys: ['id'],
      handler: ({ params }) => service.export(Number(params.id)),
    },
    {
      method: 'GET',
      pattern: /^\/scenarios\/(\d+)\/compare\/(\d+)$/,
      keys: ['a', 'b'],
      handler: ({ params }) => service.compare(Number(params.a), Number(params.b)),
    },
  ];

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const route = routes.find(
        (r) => r.method === req.method && r.pattern.test(path),
      );
      if (!route) {
        json(res, 404, { error: { code: 'E_NOT_FOUND', message: `无此路由: ${req.method} ${path}` } });
        return;
      }
      const match = path.match(route.pattern)!;
      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => {
        params[key] = match[i + 1];
      });
      const body = req.method === 'POST' ? await readBody(req) : {};
      const result = await route.handler({ params, query: url.searchParams, body });
      const status = req.method === 'POST' && path === '/scenarios' ? 201 : 200;
      json(res, status, { data: result });
    } catch (err) {
      if (err instanceof SimError) {
        const httpStatus =
          err.code === 'E_NOT_FOUND'
            ? 404
            : err.code === 'E_STATE_CONFLICT'
              ? 409
              : 400;
        json(res, httpStatus, { error: { code: err.code, message: err.message, details: err.details } });
        return;
      }
      json(res, 500, { error: { code: 'E_BAD_REQUEST', message: (err as Error).message } });
    }
  });

  return server;
}

/** 端口 0 表示由操作系统分配空闲端口 */
export async function pickFreePort(preferred = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on('error', reject);
    probe.listen(preferred, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

export async function startServer(store: Store, preferredPort = 0): Promise<{ server: Server; port: number }> {
  const app = createApp(store);
  const port = await pickFreePort(preferredPort);
  await new Promise<void>((resolve) => app.listen(port, '127.0.0.1', resolve));
  return { server: app, port };
}
