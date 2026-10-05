import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, linearLog } from "../engine.js";
import { initialState } from "../engine.js";
import { validateSpec } from "../validate.js";
import { AppError } from "../errors.js";
import { Store } from "../store.js";
import { Service } from "../service.js";
import { checkpointDemo, cancelDemo, sameTimeDemo, starvationDemo } from "../demo.js";
import type { ScenarioSpec } from "../types.js";

function runAll(spec: ScenarioSpec, budget = 1000) {
  const engine = new Engine(spec, initialState());
  const records = engine.run(budget);
  return { engine, records, log: linearLog(records) };
}

test("演示一：微任务链（含新入队）先于零延时定时任务", () => {
  const { log, engine } = runAll(checkpointDemo);
  assert.deepEqual(log, [
    "初始脚本：先登记零延时任务 timerA",
    "初始脚本：再排入微任务 micro1",
    "微任务 micro1：排入另一个微任务 micro2",
    "微任务 micro2 执行",
    "零延时定时任务 timerA 最后执行",
  ]);
  assert.equal(engine.state.status, "finished");
  assert.equal(engine.state.time, 0);
});

test("演示二：同刻定时任务按登记顺序；取消只命中指定实例并公开结果", () => {
  const { records, log, engine } = runAll(cancelDemo);
  const cancels = records[0]!.cancels;
  assert.deepEqual(
    cancels.map((c) => c.result),
    ["cancelled", "already_cancelled", "not_found"]
  );
  // first(id=1) 执行、second(id=2) 取消、keeper(id=3) 执行
  const timers = engine.state.timers;
  assert.equal(timers[0]!.status, "executed");
  assert.equal(timers[1]!.status, "cancelled");
  assert.equal(timers[2]!.status, "executed");
  assert.deepEqual(log, ["tick 实例执行", "keeper 未被误删，正常执行"]);
});

test("演示三：回调内部新增同刻任务排在当前宏任务之后，微任务仍先排空", () => {
  const { log, engine } = runAll(sameTimeDemo);
  assert.deepEqual(log, [
    "start 完成",
    "later 开始，新增一个同刻任务",
    "later 的微任务先于 later2",
    "later2 在同刻但登记更晚",
  ]);
  assert.equal(engine.state.time, 0);
});

test("演示四：微任务饥饿时标记未完成、保留状态，定时任务不插队", () => {
  let engine = new Engine(starvationDemo, initialState());
  let recs = engine.run(1);
  assert.equal(engine.state.status, "starved");
  assert.ok(recs[0]!.starved);
  assert.ok(engine.state.microtasks.length > 0);
  // 时间未前进；没有定时任务被执行（场景里没有安排 never，但保证无宏任务被选）
  assert.equal(engine.state.time, 0);
  assert.equal(recs[0]!.timerId, null);
  // 恢复：继续排空仍饥饿（recur 无限递归），但状态完整保留
  recs = engine.run(3);
  assert.equal(engine.state.status, "starved");
  assert.equal(engine.state.time, 0);
});

test("有限递归：提高 microtaskLimit 后饥饿可恢复为 finished", () => {
  const spec: ScenarioSpec = {
    initial: "start",
    microtaskLimit: 2,
    callbacks: {
      start: [
        { op: "queueMicrotask", callback: "recurA" },
        { op: "setTimeout", callback: "t", delay: 3 },
      ],
      recurA: [{ op: "queueMicrotask", callback: "recurB" }],
      recurB: [{ op: "queueMicrotask", callback: "recurC" }],
      recurC: [],
      t: [{ op: "log", text: "timer-after-microtasks" }],
    },
  };
  const engine = new Engine(spec, initialState());
  const r1 = engine.run(1);
  assert.equal(engine.state.status, "starved");
  assert.equal(r1[0]!.microtasksExecuted, 2);
  assert.equal(engine.state.microtasks.length, 1); // recurC 保留，定时任务不能插队
  // 第二个宏步时钟跳到 3
  engine.run(1); // 饥饿恢复排空步（不推进时间）
  engine.run(1); // 下一宏步：时钟跳到 3，执行定时任务
  assert.equal(engine.state.status, "finished");
  assert.equal(engine.state.time, 3);
});

test("时间跳跃：无可执行任务时时钟跳到下一到期时间，不使用真实 sleep", () => {
  const spec: ScenarioSpec = {
    initial: "start",
    callbacks: {
      start: [
        { op: "setTimeout", callback: "b", delay: 10, label: "B" },
        { op: "setTimeout", callback: "a", delay: 10, label: "A" },
      ],
      a: [{ op: "log", text: "A@10" }],
      b: [{ op: "log", text: "B@10" }],
    },
  };
  const { records, log } = runAll(spec);
  assert.equal(records[1]!.jumped, true);
  assert.equal(records[1]!.timeAfter, 10);
  assert.deepEqual(log, ["B@10", "A@10"]); // 同刻按登记顺序
});

test("错误操作整步回滚：未知操作/未知回调/负延时/标签冲突", () => {
  const badUnknown = { initial: "s", callbacks: { s: [{ op: "eval" }] } };
  assert.throws(() => validateSpec(badUnknown), (e: unknown) => (e as AppError).code === "UNKNOWN_OP");
  const badCb = { initial: "s", callbacks: { s: [{ op: "queueMicrotask", callback: "x" }] } };
  assert.throws(() => validateSpec(badCb), (e: unknown) => (e as AppError).code === "UNKNOWN_CALLBACK");
  const badDelay = { initial: "s", callbacks: { s: [{ op: "setTimeout", callback: "s", delay: -1 }] } };
  assert.throws(() => validateSpec(badDelay), (e: unknown) => (e as AppError).code === "NEGATIVE_DELAY");

  // 标签冲突在执行时触发，整步回滚：日志、编号、时间、队列全部恢复
  const spec: ScenarioSpec = {
    initial: "s",
    callbacks: {
      s: [
        { op: "setTimeout", callback: "t", delay: 5, label: "L" },
        { op: "log", text: "before-conflict" },
        { op: "setTimeout", callback: "t", delay: 5, label: "L" },
      ],
      t: [{ op: "log", text: "t" }],
    },
  };
  const engine = new Engine(spec, initialState());
  assert.throws(() => engine.run(1), (e: unknown) => (e as AppError).code === "LABEL_CONFLICT");
  assert.equal(engine.state.nextTimerId, 1);
  assert.equal(engine.state.timers.length, 0);
  assert.equal(engine.state.stepsRun, 0);
  assert.equal(engine.state.initialPending, true);
});

test("未登记标签取消返回 not_found，不会误取消别的对象", () => {
  const spec: ScenarioSpec = {
    initial: "s",
    callbacks: {
      s: [
        { op: "setTimeout", callback: "t", delay: 1, label: "real" },
        { op: "clearTimeout", ref: "ghost" },
      ],
      t: [],
    },
  };
  const { records } = runAll(spec);
  assert.equal(records[0]!.cancels[0]!.result, "not_found");
});

function newService(): Service {
  const dir = mkdtempSync(join(tmpdir(), "ckpt-"));
  return new Service(new Store(join(dir, "test.sqlite")));
}

test("SQLite 持久化：逐步运行与一次性预算运行的日志和最终队列一致", () => {
  const svc = newService();
  svc.create("stepwise", sameTimeDemo);
  svc.create("budgeted", sameTimeDemo);
  for (let i = 0; i < 10; i++) {
    const r = svc.run("stepwise", 1);
    if (r.state.status === "finished") break;
  }
  svc.run("budgeted", 10);
  const cmp = svc.compare("stepwise", "budgeted");
  assert.equal(cmp.sameLog, true);
  assert.equal(cmp.sameSteps, true);
  assert.equal(cmp.sameFinalState, true);
});

test("暂停重启恢复：重新加载后输出顺序与连续运行完全一致，微任务不丢失", () => {
  const dir = mkdtempSync(join(tmpdir(), "ckpt-restart-"));
  const dbPath = join(dir, "r.sqlite");
  const spec = checkpointDemo;
  let store = new Store(dbPath);
  let svc = new Service(store);
  svc.create("c", spec);
  svc.run("c", 1); // 初始脚本后微任务尚未排空（微任务在第1步内已排空，队列应为空，timer 存活）
  store.close();

  // 重新打开同一数据库继续
  store = new Store(dbPath);
  svc = new Service(store);
  const cont = svc.run("c", 10);
  store.close();
  const fullLog = svc;
  void fullLog;
  assert.deepEqual(cont.appendedLog, ["零延时定时任务 timerA 最后执行"]);

  // 连续运行对照组
  const ref = newService();
  ref.create("ref", spec);
  ref.run("ref", 10);
  const allLog = new Service(new Store(dbPath)).log("c")!.linearLog;
  assert.deepEqual(allLog, ref.log("ref")!.linearLog);
});

test("微任务饥饿状态持久化：重启后仍是 starved 且保留剩余微任务", () => {
  const dir = mkdtempSync(join(tmpdir(), "ckpt-starve-"));
  const dbPath = join(dir, "s.sqlite");
  let store = new Store(dbPath);
  let svc = new Service(store);
  svc.create("s", starvationDemo);
  svc.run("s", 1);
  store.close();

  store = new Store(dbPath);
  svc = new Service(store);
  const view = svc.queues("s");
  assert.equal(view.status, "starved");
  assert.ok(view.microtaskQueue.includes("recur"));
  assert.equal(view.time, 0);
  store.close();
});

test("任务实例不会重复执行：执行后再取消返回 already_executed", () => {
  const spec: ScenarioSpec = {
    initial: "s",
    callbacks: {
      s: [{ op: "setTimeout", callback: "t", delay: 0, label: "x" }],
      t: [{ op: "clearTimeout", ref: 1 }],
    },
  };
  const { records } = runAll(spec);
  assert.equal(records[1]!.cancels[0]!.result, "already_executed");
});

test("修改回调定义必须创建新场景，旧场景名拒绝覆盖（冻结）", () => {
  const svc = newService();
  svc.create("f", checkpointDemo);
  assert.throws(() => svc.create("f", cancelDemo), (e: unknown) => (e as AppError).code === "SCENARIO_FROZEN");
});
