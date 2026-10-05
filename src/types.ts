/** 场景定义（冻结的回调定义 + 初始脚本） */

export type Op =
  | { op: "log"; text: string }
  | { op: "queueMicrotask"; callback: string }
  | { op: "setTimeout"; callback: string; delay: number; label?: string }
  | { op: "clearTimeout"; ref: number | string };

export interface ScenarioSpec {
  /** 初始脚本回调名，作为第一个普通（宏）任务执行 */
  initial: string;
  /** 命名回调定义：回调仅是四类操作的有序序列，不能执行任意 JavaScript */
  callbacks: Record<string, Op[]>;
  /** 单次执行预算内允许运行的微任务回调数量上限，默认 1000 */
  microtaskLimit?: number;
}

export type TimerStatus = "scheduled" | "executed" | "cancelled";

export interface Timer {
  /** 稳定任务编号（安排延时任务时返回） */
  id: number;
  callback: string;
  due: number;
  /** 登记序号，同刻定时任务按它稳定排序 */
  seq: number;
  status: TimerStatus;
  label: string | null;
}

export interface Microtask {
  callback: string;
  seq: number;
}

/** 回调内部执行位置：原子提交时始终停在边界，崩溃回滚不会停在回调中间 */
export interface Position {
  queue: "none" | "macro" | "micro";
  callback: string | null;
  opIndex: number;
}

export type RunStatus = "ready" | "finished" | "starved";

export interface SimState {
  time: number;
  nextTimerId: number;
  seq: number;
  status: RunStatus;
  initialPending: boolean;
  microtasks: Microtask[];
  timers: Timer[];
  position: Position;
  /** 本次已消耗的宏任务步数累计 */
  stepsRun: number;
}

export interface ScheduledEvent {
  id: number;
  callback: string;
  delay: number;
  due: number;
  label: string | null;
}

export interface CancelEvent {
  ref: number | string;
  /** cancelled=成功取消；not_found=编号/标签未登记；already_executed；already_cancelled */
  result: "cancelled" | "not_found" | "already_executed" | "already_cancelled";
  targetId: number | null;
}

export interface StepRecord {
  stepIndex: number;
  timeBefore: number;
  timeAfter: number;
  jumped: boolean;
  /** macro | micro-drain | starved-drain */
  kind: "macro" | "micro-drain" | "starved-drain";
  source: "initial" | "timer";
  callback: string | null;
  timerId: number | null;
  outputs: string[];
  scheduled: ScheduledEvent[];
  cancels: CancelEvent[];
  microtaskQueueBefore: string[];
  microtaskQueueAfter: string[];
  timerQueueBefore: number[];
  timerQueueAfter: number[];
  microtasksExecuted: number;
  starved: boolean;
}
