import type { ScenarioSpec } from "./types.js";

/** 场景一：零延时任务不能在当前回调插队；微任务链必须先全部排空 */
export const checkpointDemo: ScenarioSpec = {
  initial: "start",
  callbacks: {
    start: [
      { op: "log", text: "初始脚本：先登记零延时任务 timerA" },
      { op: "setTimeout", callback: "timerA", delay: 0 },
      { op: "log", text: "初始脚本：再排入微任务 micro1" },
      { op: "queueMicrotask", callback: "micro1" },
    ],
    micro1: [
      { op: "log", text: "微任务 micro1：排入另一个微任务 micro2" },
      { op: "queueMicrotask", callback: "micro2" },
    ],
    micro2: [{ op: "log", text: "微任务 micro2 执行" }],
    timerA: [{ op: "log", text: "零延时定时任务 timerA 最后执行" }],
  },
};

/** 场景二：同刻定时任务按登记顺序；取消只命中指定实例 */
export const cancelDemo: ScenarioSpec = {
  initial: "start",
  callbacks: {
    start: [
      { op: "setTimeout", callback: "tick", delay: 5, label: "first" },
      { op: "setTimeout", callback: "tick", delay: 5, label: "second" },
      { op: "setTimeout", callback: "keeper", delay: 5, label: "keep" },
      { op: "clearTimeout", ref: "second" },
      { op: "clearTimeout", ref: "second" },
      { op: "clearTimeout", ref: 999 },
    ],
    tick: [{ op: "log", text: "tick 实例执行" }],
    keeper: [{ op: "log", text: "keeper 未被误删，正常执行" }],
  },
};

/** 场景三：回调内部新增同刻任务（delay=0），只能排到当前任务之后 */
export const sameTimeDemo: ScenarioSpec = {
  initial: "start",
  callbacks: {
    start: [
      { op: "setTimeout", callback: "later", delay: 0 },
      { op: "log", text: "start 完成" },
    ],
    later: [
      { op: "log", text: "later 开始，新增一个同刻任务" },
      { op: "setTimeout", callback: "later2", delay: 0 },
      { op: "queueMicrotask", callback: "laterMicro" },
    ],
    laterMicro: [{ op: "log", text: "later 的微任务先于 later2" }],
    later2: [{ op: "log", text: "later2 在同刻但登记更晚" }],
  },
};

/** 场景四：微任务不断递归入队 → 饥饿；提高预算后可恢复 */
export const starvationDemo: ScenarioSpec = {
  initial: "start",
  microtaskLimit: 5,
  callbacks: {
    start: [
      { op: "log", text: "start：排入无限递归微任务" },
      { op: "queueMicrotask", callback: "recur" },
    ],
    recur: [
      { op: "log", text: "recur" },
      { op: "queueMicrotask", callback: "recur" },
    ],
    never: [{ op: "log", text: "定时任务在微任务饥饿时绝不能插队" }],
  },
};

export const allDemos: Record<string, ScenarioSpec> = {
  demo_checkpoint: checkpointDemo,
  demo_cancel: cancelDemo,
  demo_sametime: sameTimeDemo,
  demo_starvation: starvationDemo,
};
