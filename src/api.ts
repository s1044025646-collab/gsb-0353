import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AppError } from "./errors.js";
import { Service } from "./service.js";

export interface ApiDeps {
  service: Service;
}

interface Route {
  method: string;
  pattern: RegExp;
  groups: string[];
  handle: (params: Record<string, string>, body: unknown) => unknown | Promise<unknown>;
}

function route(method: string, path: string, handle: Route["handle"]): Route {
  const groups: string[] = [];
  const pattern = new RegExp(
    "^" +
      path.replace(/:[A-Za-z]+/g, (m) => {
        groups.push(m.slice(1));
        return "([^/]+)";
      }) +
      "$"
  );
  return { method, pattern, groups, handle };
}

export function createApiServer({ service }: ApiDeps): Server {
  const routes: Route[] = [
    route("POST", "/scenarios", (_p, body) => {
      const b = body as { name?: string; spec?: unknown };
      if (!b || typeof b.name !== "string") {
        const e = new AppError("MISSING_FIELD", "body.name 为必填字符串");
        throw e;
      }
      return service.create(b.name, b.spec);
    }),
    route("POST", "/validate", (_p, body) => service.validate(body)),
    route("GET", "/scenarios", () => service.list()),
    route("POST", "/scenarios/:name/run", (p, body) => {
      const b = (body ?? {}) as { budget?: number; maxCallbacks?: number };
      const budget = b.budget ?? 1;
      return service.run(p.name!, budget, b.maxCallbacks);
    }),
    route("GET", "/scenarios/:name/queues", (p) => service.queues(p.name!)),
    route("GET", "/scenarios/:name/log", (p) => service.log(p.name!)),
    route("GET", "/scenarios/:name/export", (p) => service.exportScenario(p.name!)),
    route("GET", "/compare/:a/:b", (p) => service.compare(p.a!, p.b!)),
  ];

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const match = routes.find(
        (r) => r.method === req.method && r.pattern.test(url.pathname)
      );
      if (!match) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "路由不存在" } }));
        return;
      }
      const m = url.pathname.match(match.pattern)!;
      const params: Record<string, string> = {};
      match.groups.forEach((g, i) => (params[g] = decodeURIComponent(m[i + 1]!)));
      let body: unknown = undefined;
      if (req.method === "POST") {
        const raw = await readBody(req);
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw);
          } catch {
            throw new AppError("BAD_PARAM", "请求体必须是合法 JSON");
          }
        }
      }
      const data = await match.handle(params, body);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, data }));
    } catch (e) {
      const err = e as AppError;
      const status = err instanceof AppError ? 400 : 500;
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: err.code ?? "INTERNAL", message: err.message, details: err.details },
        })
      );
    }
  });
  return server;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new AppError("BAD_PARAM", "请求体超过 1MB 限制"));
        req.destroy();
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** 端口为 0 时由操作系统选择空闲端口 */
export function listen(server: Server, port: number, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("无法获取监听端口"));
    });
  });
}
