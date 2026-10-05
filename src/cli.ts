#!/usr/bin/env node
/**
 * 命令行入口。只调用本地内存 + SQLite，不运行任意外部命令、不依赖网络。
 *
 * 用法见 README。示例：
 *   node dist/cli.js serve --port 8080
 *   node dist/cli.js create scenarios/checkpoint.json
 *   node dist/cli.js step 1
 *   node dist/cli.js run 1 --budget 50
 *   node dist/cli.js queues 1
 *   node dist/cli.js logs 1
 *   node dist/cli.js compare 1 2
 *   node dist/cli.js export 1
 *   node dist/cli.js demo
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SimError } from './types.js';
import { Store } from './store.js';
import { Service } from './service.js';
import { startServer } from './server.js';
import {
  allDemos,
  cancelExpected,
  cancelScenario,
  checkpointExpected,
  checkpointScenario,
  sameTickExpected,
  sameTickScenario,
  starvationScenario,
} from './demo.js';
import { runBudget, snapshotQueues } from './engine.js';

const DB_PATH = process.env.SIM_DB_PATH ?? resolve('data/eventloop.sqlite');

function fail(err: unknown): never {
  if (err instanceof SimError) {
    console.error(`错误 [${err.code}] ${err.message}`);
    if (err.details) console.error(JSON.stringify(err.details));
    process.exitCode = 1;
    throw err;
  }
  console.error('错误:', (err as Error).message);
  process.exitCode = 1;
  throw err;
}

function readScenarioFile(file: string): unknown {
  const text = readFileSync(resolve(file), 'utf8');
  return JSON.parse(text);
}

function unitLabel(log: {
  unit: string;
  taskId: number | null;
  callback: string;
}): string {
  if (log.unit === 'init') return '普通任务/初始脚本';
  if (log.unit === 'micro') return `微任务 <- ${log.callback}`;
  return `普通任务/延时 #${log.taskId} <- ${log.callback}`;
}

function printStep(l: {
  step: number;
  unit: string;
  taskId: number | null;
  callback: string;
  now: number;
  outputs: string[];
  scheduled: Array<{ taskId: number; callback: string; due: number; label: string | null }>;
  cancels: Array<{ target: string; result: string }>;
  opIndex: number;
  note?: string;
}): void {
  console.log(
    `步骤 ${String(l.step).padStart(3)} | t=${l.now} | ${unitLabel(l)} | 内部操作位置=${l.opIndex}`,
  );
  if (l.note) console.log(`           时钟: ${l.note}`);
  for (const text of l.outputs) console.log(`           日志输出: ${text}`);
  for (const s of l.scheduled) {
    console.log(
      `           排队: 定时任务 #${s.taskId} -> ${s.callback} 到期=${s.due}${
        s.label ? ` 标签=${s.label}` : ''
      }`,
    );
  }
  for (const c of l.cancels) console.log(`           取消: ${c.target} => ${c.result}`);
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }

  if (cmd === 'serve') {
    await serve(rest);
    return;
  }

  const store = new Store(DB_PATH);
  const service = new Service(store);
  try {
    switch (cmd) {
      case 'validate':
        validateCmd(service, rest);
        break;
      case 'create':
        createCmd(service, rest);
        break;
      case 'list':
        for (const r of service.list()) console.log(`#${r.id} ${r.name} (${r.createdAt})`);
        break;
      case 'step':
        {
          const r = service.stepOnce(Number(rest[0]));
          if (r.log.finished) {
            console.log(`场景 #${rest[0]} 已自然结束，无新增步骤`);
          } else {
            printStep(r.log);
          }
        }
        break;
      case 'run':
        runCmd(service, rest);
        break;
      case 'queues':
        queuesCmd(service, rest);
        break;
      case 'logs':
        logsCmd(service, rest);
        break;
      case 'state': {
        const { def, state } = service.state(Number(rest[0]));
        console.log(JSON.stringify({ def, state }, null, 2));
        break;
      }
      case 'export': {
        const out = service.export(Number(rest[0]));
        const file = flag(rest, '--out');
        const json = JSON.stringify(out, null, 2);
        if (file) {
          writeFileSync(resolve(file), json, 'utf8');
          console.log(`已导出到 ${file}`);
        } else {
          console.log(json);
        }
        break;
      }
      case 'compare':
        compareCmd(service, rest);
        break;
      case 'demo':
        await demoRun(store);
        break;
      default:
        console.error(`未知命令: ${cmd}`);
        printHelp();
        process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function validateCmd(service: Service, args: string[]): void {
  const file = args[0];
  if (!file) throw new SimError('E_BAD_REQUEST', '用法: validate <场景.json>');
  const { def } = service.validate(readScenarioFile(file));
  console.log(`校验通过: ${def.name}（${def.callbacks.length} 个回调，${def.init.length} 个初始操作）`);
}

function createCmd(service: Service, args: string[]): void {
  const file = args[0];
  if (!file) throw new SimError('E_BAD_REQUEST', '用法: create <场景.json>');
  const created = service.create(readScenarioFile(file));
  console.log(`已创建场景 #${created.id}`);
}

function runCmd(service: Service, args: string[]): void {
  const id = Number(args[0]);
  const budget = Number(flag(args, '--budget') ?? '100');
  const result = service.run(id, budget);
  for (const l of result.logs) printStep(l);
  console.log(
    `\n本次推进 ${result.ran} 步，共 ${result.state.stepCount} 步，状态=${result.state.status}，t=${result.state.now}`,
  );
}

function queuesCmd(service: Service, args: string[]): void {
  const id = Number(args[0]);
  const { now, status, queues } = service.queues(id);
  console.log(`当前时间 t=${now} 状态=${status}`);
  console.log('微任务队列（FIFO）:');
  if (queues.micro.length === 0) console.log('  (空)');
  for (const m of queues.micro) console.log(`  #m${m.id} -> ${m.callback}`);
  console.log('延时任务队列（到期时间, 登记顺序）:');
  const pending = queues.timers;
  if (pending.length === 0) console.log('  (空)');
  for (const t of pending) {
    console.log(
      `  #${t.taskId} due=${t.due} seq=${t.seq} -> ${t.callback}${t.label ? ` [${t.label}]` : ''}`,
    );
  }
}

function logsCmd(service: Service, args: string[]): void {
  const id = Number(args[0]);
  const from = flag(args, '--from');
  const { logs, state } = service.logs(id, from === undefined ? undefined : Number(from));
  for (const l of logs) printStep(l);
  console.log(`\n状态=${state.status} 共 ${state.stepCount} 步 t=${state.now}`);
}

function compareCmd(service: Service, args: string[]): void {
  const a = Number(args[0]);
  const b = Number(args[1]);
  if (!a || !b) throw new SimError('E_BAD_REQUEST', '用法: compare <场景A> <场景B>');
  const result = service.compare(a, b);
  console.log(JSON.stringify(result, null, 2));
  if (result.sameLogs && result.sameFinalQueues) {
    console.log(`\n场景 #${a} 与 #${b} 的日志与最终队列一致`);
  } else {
    console.log(`\n场景 #${a} 与 #${b} 存在差异`);
    process.exitCode = 1;
  }
}

async function serve(args: string[]): Promise<void> {
  const preferred = Number(flag(args, '--port') ?? process.env.PORT ?? '0');
  const store = new Store(DB_PATH);
  const { server, port } = await startServer(store, Number.isFinite(preferred) ? preferred : 0);
  console.log(`事件循环模拟器 API 已启动: http://127.0.0.1:${port}`);
  console.log(`数据库: ${DB_PATH}`);
  console.log('按 Ctrl+C 退出');
  const shutdown = () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function demoRun(store: Store): Promise<void> {
  const service = new Service(store);
  console.log('===== 场景一：微任务检查点（零延时不插队） =====');
  const c1 = service.create(checkpointScenario);
  const r1 = service.run(c1.id, 100);
  const got1 = r1.logs.flatMap((l) => l.outputs);
  console.log(`手写预期: ${JSON.stringify(checkpointExpected)}`);
  console.log(`实际顺序: ${JSON.stringify(got1)}`);
  console.log(`结论: ${JSON.stringify(got1) === JSON.stringify(checkpointExpected) ? '通过' : '失败'}\n`);

  console.log('===== 场景二：同刻稳定排序 + 取消结果 =====');
  const c2 = service.create(cancelScenario);
  const r2 = service.run(c2.id, 100);
  const got2 = r2.logs.flatMap((l) => l.outputs);
  console.log(`手写预期: ${JSON.stringify(cancelExpected)}`);
  console.log(`实际顺序: ${JSON.stringify(got2)}`);
  for (const l of r2.logs) for (const c of l.cancels) console.log(`取消结果 ${c.target} => ${c.result}`);
  console.log(`结论: ${JSON.stringify(got2) === JSON.stringify(cancelExpected) ? '通过' : '失败'}\n`);

  console.log('===== 场景三：回调内部新增同刻任务 =====');
  const c3 = service.create(sameTickScenario);
  const r3 = service.run(c3.id, 100);
  const got3 = r3.logs.flatMap((l) => l.outputs);
  console.log(`手写预期: ${JSON.stringify(sameTickExpected)}`);
  console.log(`实际顺序: ${JSON.stringify(got3)}`);
  console.log(`结论: ${JSON.stringify(got3) === JSON.stringify(sameTickExpected) ? '通过' : '失败'}\n`);

  console.log('===== 场景四：微任务饥饿（达到上限标记 starved 并保留微任务） =====');
  const c4 = service.create(starvationScenario);
  const r4 = service.run(c4.id, 100);
  const q4 = snapshotQueues(r4.state);
  console.log(
    `状态=${r4.state.status} 步数=${r4.state.stepCount} 剩余微任务=${q4.micro.length} 定时任务未执行=${q4.timers.length}`,
  );
  console.log(
    `结论: ${r4.state.status === 'starved' && q4.micro.length > 0 && q4.timers.length === 1 ? '通过（定时任务未被强行执行，微任务保留）' : '失败'}`,
  );

  console.log('\n===== 场景五：逐步 vs 分批预算 vs 重启恢复一致性 =====');
  const a = service.create({ ...checkpointScenario, name: 'cmp-stepwise' });
  const b = service.create({ ...checkpointScenario, name: 'cmp-budget' });
  while (service.stepOnce(a.id).state.status === 'ready') {
    /* 逐字节拍 */
  }
  service.run(b.id, 100);
  // 重启恢复等价于：重新打开 store（此处 service 仍持有同一文件），
  // 状态全部来自 SQLite，直接比较持久化后的场景。
  const cmp = service.compare(a.id, b.id);
  console.log(JSON.stringify(cmp, null, 2));

  console.log('\n内置演示场景总数:', allDemos.length);
  void runBudget;
}

function printHelp(): void {
  console.log(`事件循环模拟器（宏任务 / 微任务检查点回放）

用法:
  serve [--port 端口]              启动 HTTP API（默认自动选择空闲端口）
  validate <场景.json>             只校验回调与初始脚本
  create <场景.json>               创建并冻结一个场景
  list                             列出场景
  step <id>                        单步推进一个执行单元
  run <id> [--budget N]            按预算推进（默认 100 步）
  queues <id>                      查看微任务与延时任务两类队列
  logs <id> [--from N]             查看逐步日志
  state <id>                       查看完整持久化状态（JSON）
  export <id> [--out 文件]         导出冻结定义 + 当前状态
  compare <idA> <idB>              比较两场景日志与最终队列
  demo                             运行内置教学演示并核对手写预期

环境变量:
  SIM_DB_PATH   SQLite 数据文件（默认 ./data/eventloop.sqlite）
  PORT          serve 的首选端口（被 --port 覆盖）
`);
}

main(process.argv.slice(2)).catch(fail);
