#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "./store.js";
import { Service } from "./service.js";
import { AppError } from "./errors.js";
import { createApiServer, listen } from "./api.js";
import { Engine } from "./engine.js";
import { allDemos } from "./demo.js";
import type { StepRecord } from "./types.js";

const DATA_DIR = resolve(process.cwd(), "data");
const DB_PATH = resolve(DATA_DIR, "checkpoint.sqlite");

function usage(): void {
  console.log(`检查点回放后端 CLI（仅本地，无外部命令）

用法:
  ckpt validate <spec.json>                         仅校验场景定义
  ckpt create <name> <spec.json>                    创建场景（回调定义冻结）
  ckpt list                                         列出场景
  ckpt step <name> [budget] [--max-callbacks N]    单步/按预算推进（默认 budget=1）
  ckpt queues <name>                                查看微任务队列与定时队列
  ckpt log <name>                                   查询线性日志与逐步记录
  ckpt compare <nameA> <nameB>                      比较日志、逐步记录与最终队列
  ckpt export <name> [out.json]                     导出场景（默认打印到 stdout）
  ckpt serve [--port 0] [--host 127.0.0.1] [--db path]  启动 HTTP API（端口 0=系统选空闲端口，默认 0）
  ckpt demo                                         写入并运行内置教学演示

数据目录: ${DATA_DIR}`);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf-8"));
}

function fmtRecord(r: StepRecord): string {
  const lines: string[] = [];
  const kind =
    r.kind === "macro" ? "宏任务" : r.kind === "starved-drain" ? "饥饿恢复排空" : "微任务排空";
  lines.push(
    `── 第 ${r.stepIndex} 步 [${kind}] 来源=${r.source}${r.timerId !== null ? ` #${r.timerId}` : ""} 回调=${r.callback ?? "(继续排空)"}`
  );
  lines.push(
    `   时间 ${r.timeBefore} → ${r.timeAfter}${r.jumped ? "（无可执行任务，时钟跳到下一到期时间）" : ""}`
  );
  lines.push(`   微任务队列前 [${r.microtaskQueueBefore.join(", ")}]`);
  lines.push(`   微任务队列后 [${r.microtaskQueueAfter.join(", ")}]（本轮执行 ${r.microtasksExecuted} 个）`);
  lines.push(`   定时队列前 [${r.timerQueueBefore.join(", ")}]`);
  lines.push(`   定时队列后 [${r.timerQueueAfter.join(", ")}]`);
  for (const s of r.scheduled) {
    lines.push(
      `   安排定时 #${s.id} -> ${s.callback}（delay=${s.delay}, due=${s.due}${s.label ? `, label=${s.label}` : ""}）`
    );
  }
  for (const c of r.cancels) {
    const map: Record<string, string> = {
      cancelled: "已取消",
      not_found: "未登记（未取消任何对象）",
      already_executed: "已执行",
      already_cancelled: "已取消过",
    };
    lines.push(`   取消引用 ${String(c.ref)} => ${map[c.result]}`);
  }
  for (const o of r.outputs) lines.push(`   日志#${r.stepIndex}> ${o}`);
  if (r.starved) lines.push("   ⚠ 微任务达到本轮上限：标记饥饿(starved)，保留剩余微任务，不执行定时任务");
  return lines.join("\n");
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") {
    usage();
    return;
  }

  if (cmd === "serve") {
    const portArg = flagValue(rest, "--port");
    const host = flagValue(rest, "--host") ?? "127.0.0.1";
    const dbPath = flagValue(rest, "--db") ?? DB_PATH;
    const store = new Store(dbPath);
    const server = createApiServer({ service: new Service(store) });
    const port = await listen(server, portArg ? Number(portArg) : 0, host);
    console.log(`HTTP API 已启动: http://${host}:${port}`);
    console.log(`数据库: ${dbPath}`);
    return;
  }

  const store = new Store(DB_PATH);
  const service = new Service(store);
  try {
    switch (cmd) {
      case "validate": {
        const spec = service.validate(readJson(rest[0]!)).spec;
        console.log(`校验通过：${Object.keys(spec.callbacks).length} 个回调，initial=${spec.initial}，microtaskLimit=${spec.microtaskLimit}`);
        break;
      }
      case "create": {
        const row = service.create(rest[0]!, readJson(rest[1]!));
        console.log(`已创建冻结场景 #${row.id} ${row.name}`);
        break;
      }
      case "list": {
        for (const s of service.list()) {
          const st = store.loadState(s.id);
          console.log(`#${s.id} ${s.name}  time=${st.time} status=${st.status} callbacks=${Object.keys(s.spec.callbacks).length}`);
        }
        break;
      }
      case "step": {
        const budget = Number(rest[1] ?? "1");
        const max = Number(flagValue(rest.slice(2), "--max-callbacks") ?? "100000");
        const result = service.run(rest[0]!, budget, max);
        for (const r of result.records) console.log(fmtRecord(r) + "\n");
        console.log(`本批新增日志 ${result.appendedLog.length} 条；状态 status=${result.state.status} time=${result.state.time}`);
        break;
      }
      case "queues": {
        const v = service.queues(rest[0]!);
        console.log(`时间=${v.time} 状态=${v.status}`);
        console.log(`微任务队列 FIFO: [${v.microtaskQueue.join(", ")}]`);
        console.log("定时队列（按到期时间, 登记顺序）:");
        for (const t of v.timerQueue) {
          console.log(`  #${t.id} ${t.callback} due=${t.due} seq=${t.seq}${t.label ? ` label=${t.label}` : ""}`);
        }
        console.log("全部任务实例（含已执行/已取消）:");
        for (const t of v.allTimers) {
          console.log(`  #${t.id} ${t.callback} due=${t.due} ${t.status}${t.label ? ` label=${t.label}` : ""}`);
        }
        console.log(`回调内部位置: queue=${v.position.queue} callback=${v.position.callback ?? "-"} opIndex=${v.position.opIndex}`);
        break;
      }
      case "log": {
        const data = service.log(rest[0]!);
        if (!data) throw new AppError("SCENARIO_NOT_FOUND", `场景 ${rest[0]} 不存在`);
        for (const r of data.steps) console.log(fmtRecord(r) + "\n");
        console.log(`线性日志（全局顺序，共 ${data.linearLog.length} 条）:`);
        data.linearLog.forEach((l, i) => console.log(`  ${i + 1}. ${l}`));
        break;
      }
      case "compare": {
        const c = service.compare(rest[0]!, rest[1]!);
        console.log(`日志一致: ${c.sameLog}`);
        console.log(`逐步记录一致: ${c.sameSteps}`);
        console.log(`最终队列/时间一致: ${c.sameFinalState}`);
        console.log(`A ${c.a.name}: time=${c.a.state.time} status=${c.a.state.status} log=${c.a.log.length} 条`);
        console.log(`B ${c.b.name}: time=${c.b.state.time} status=${c.b.state.status} log=${c.b.log.length} 条`);
        break;
      }
      case "export": {
        const data = service.exportScenario(rest[0]!);
        const json = JSON.stringify(data, null, 2);
        if (rest[1]) {
          writeFileSync(resolve(rest[1]), json, "utf-8");
          console.log(`已导出到 ${rest[1]}`);
        } else {
          console.log(json);
        }
        break;
      }
      case "demo":
        await runDemo(service);
        break;
      default:
        usage();
    }
  } finally {
    store.close();
  }
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function runDemo(service: Service): Promise<void> {
  const names = Object.keys(allDemos);
  for (const name of names) {
    // demo 可重复运行：先删除同名旧演示场景（仅影响 demo_ 前缀的内置场景）
    service.store.deleteScenario(name);
    service.create(name, allDemos[name]!);
  }
  console.log("=== 演示1：检查点顺序（零延时任务必须等微任务链排空）===");
  const r1 = service.run("demo_checkpoint", 10);
  for (const rec of r1.records) console.log(fmtRecord(rec));
  console.log("线性日志:", r1.appendedLog);

  console.log("\n=== 演示2：同刻稳定排序与定向取消 ===");
  const r2 = service.run("demo_cancel", 10);
  for (const rec of r2.records) console.log(fmtRecord(rec));

  console.log("\n=== 演示3：回调内部新增同刻任务 ===");
  const r3 = service.run("demo_sametime", 10);
  for (const rec of r3.records) console.log(fmtRecord(rec));

  console.log("\n=== 演示4：微任务饥饿（默认 microtaskLimit=5）===");
  const r4 = service.run("demo_starvation", 1);
  for (const rec of r4.records) console.log(fmtRecord(rec));
  console.log("饥饿后状态保留，再给预算继续排空（不会跑定时任务）:");
  const r4b = service.run("demo_starvation", 3);
  console.log(`status=${r4b.state.status} time=${r4b.state.time} 微任务剩余=${r4b.state.microtaskQueue.length}`);
}

main(process.argv.slice(2)).catch((e: unknown) => {
  const err = e as AppError;
  console.error(`错误 [${err.code ?? "INTERNAL"}]: ${err.message}`);
  if (err.details) console.error("详情:", JSON.stringify(err.details));
  process.exitCode = 1;
});
