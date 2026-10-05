import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { checkpointScenario } from '../src/demo.js';

async function api(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

test('HTTP API：创建 -> 单步 -> 预算 -> 队列 -> 日志 -> 比较', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-api-'));
  let server: Server | undefined;
  after(() => {
    server?.close();
    for (let i = 0; i < 5; i += 1) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (i + 1));
      }
    }
  });

  const store = new Store(join(dir, 'api.sqlite'));
  server = createApp(store);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const port = (server!.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const val = await api(base, 'POST', '/validate', checkpointScenario);
  assert.equal(val.status, 200);

  const bad = await api(base, 'POST', '/validate', {
    name: 'bad',
    callbacks: [],
    init: [],
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'E_VALIDATION');

  const c1 = await api(base, 'POST', '/scenarios', { ...checkpointScenario, name: 'a' });
  const c2 = await api(base, 'POST', '/scenarios', { ...checkpointScenario, name: 'b' });
  assert.equal(c1.status, 201);
  const id1 = c1.json.data.id;
  const id2 = c2.json.data.id;

  const step1 = await api(base, 'POST', `/scenarios/${id1}/step`);
  assert.equal(step1.json.data.log.outputs[0], 'init-log');
  const queues = await api(base, 'GET', `/scenarios/${id1}/queues`);
  assert.ok(queues.json.data.queues.micro.length >= 1);

  await api(base, 'POST', `/scenarios/${id2}/run`, { budget: 100 });
  while (!step1.json.data.log.finished && step1.json.data.state.status === 'ready') {
    const r = await api(base, 'POST', `/scenarios/${id1}/step`);
    step1.json = r.json;
    if (r.json.data.state.status !== 'ready') break;
  }
  const cmp = await api(base, 'GET', `/scenarios/${id1}/compare/${id2}`);
  assert.equal(cmp.json.data.sameLogs, true);
  assert.equal(cmp.json.data.sameFinalQueues, true);

  const logs = await api(base, 'GET', `/scenarios/${id1}/logs`);
  const order = logs.json.data.logs.flatMap((l: { outputs: string[] }) => l.outputs);
  assert.deepEqual(order, ['init-log', 'microA', 'microB', 'timerZero']);

  const missing = await api(base, 'GET', '/scenarios/9999/queues');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'E_NOT_FOUND');

  store.close();
});
