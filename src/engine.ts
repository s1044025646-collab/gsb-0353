import type {
  CancelEvent,
  Microtask,
  Op,
  ScheduledEvent,
  ScenarioSpec,
  SimState,
  StepRecord,
  Timer,
} from "./types.js";
import { AppError, fail } from "./errors.js";

export function initialState(): SimState {
  return {
    time: 0,
    nextTimerId: 1,
    seq: 0,
    status: "ready",
    initialPending: true,
    microtasks: [],
    timers: [],
    position: { queue: "none", callback: null, opIndex: 0 },
    stepsRun: 0,
  };
}

export class Engine {
  constructor(public readonly spec: ScenarioSpec, public state: SimState = initialState()) {}

  private get limit(): number {
    return this.spec.microtaskLimit ?? 1000;
  }

  private liveTimers(): Timer[] {
    return this.state.timers
      .filter((t) => t.status === "scheduled")
      .sort((a, b) => a.due - b.due || a.seq - b.seq);
  }

  get done(): boolean {
    if (this.state.status === "finished") return true;
    if (this.state.status === "starved") return false;
    return (
      !this.state.initialPending &&
      this.state.microtasks.length === 0 &&
      !this.state.timers.some((t) => t.status === "scheduled")
    );
  }

  /** 仅查看队列，不改变状态 */
  view() {
    return {
      time: this.state.time,
      status: this.state.status,
      microtaskQueue: this.state.microtasks.map((m) => m.callback),
      timerQueue: this.liveTimers().map((t) => ({
        id: t.id,
        callback: t.callback,
        due: t.due,
        seq: t.seq,
        label: t.label,
      })),
      allTimers: this.state.timers.map((t) => ({
        id: t.id,
        callback: t.callback,
        due: t.due,
        seq: t.seq,
        status: t.status,
        label: t.label,
      })),
      position: this.state.position,
      stepsRun: this.state.stepsRun,
    };
  }

  private snapshotMicro(): string[] {
    return this.state.microtasks.map((m) => m.callback);
  }

  private snapshotTimers(): number[] {
    return this.liveTimers().map((t) => t.id);
  }

  /**
   * 按预算运行。budget=最大宏任务步数（饥饿恢复步也算一步）。
   * maxCallbacks=本次运行所有回调执行次数的硬上限，防止无限运行。
   * 返回本次新增的逐步记录。任何错误都在提交前抛出（错误操作整步回滚）。
   */
  run(budget: number, maxCallbacks = 100_000): StepRecord[] {
    if (!Number.isSafeInteger(budget) || budget < 1) {
      fail("BAD_PARAM", "budget 必须是 >=1 的安全整数");
    }
    if (this.state.status === "finished") {
      fail("ALREADY_FINISHED", "场景已执行完毕，没有可运行任务");
    }
    const records: StepRecord[] = [];
    let used = 0;
    let callbacks = 0;
    const cap = Math.min(maxCallbacks, budget * Math.max(this.limit, 1) + budget);

    while (used < budget) {
      if (this.state.status === "starved") {
        records.push(this.starvedStep());
        used++;
        callbacks += records[records.length - 1]!.microtasksExecuted;
        continue;
      }
      if (this.done) {
        this.state.status = "finished";
        this.state.position = { queue: "none", callback: null, opIndex: 0 };
        break;
      }
      if (callbacks >= maxCallbacks || callbacks >= cap) {
        break;
      }
      records.push(this.macroStep());
      used++;
      callbacks += 1 + records[records.length - 1]!.microtasksExecuted;
    }
    if (this.done && this.state.status !== "starved") {
      this.state.status = "finished";
      this.state.position = { queue: "none", callback: null, opIndex: 0 };
    }
    return records;
  }

  private starvedStep(): StepRecord {
    const record: StepRecord = {
      stepIndex: this.state.stepsRun,
      timeBefore: this.state.time,
      timeAfter: this.state.time,
      jumped: false,
      kind: "starved-drain",
      source: "initial",
      callback: null,
      timerId: null,
      outputs: [],
      scheduled: [],
      cancels: [],
      microtaskQueueBefore: this.snapshotMicro(),
      microtaskQueueAfter: [],
      timerQueueBefore: this.snapshotTimers(),
      timerQueueAfter: [],
      microtasksExecuted: 0,
      starved: true,
    };
    // 深拷贝快照：整步出错时整体回滚
    const backup = this.cloneState();
    try {
      this.drainMicrotasks(record);
      if (this.state.microtasks.length === 0) {
        record.starved = false;
        this.state.status =
          !this.state.initialPending &&
          !this.state.timers.some((t) => t.status === "scheduled")
            ? "finished"
            : "ready";
      }
    } catch (e) {
      this.state = backup;
      throw e;
    }
    record.microtaskQueueAfter = this.snapshotMicro();
    record.timerQueueAfter = this.snapshotTimers();
    record.timeAfter = this.state.time;
    this.state.stepsRun++;
    record.stepIndex = this.state.stepsRun;
    return record;
  }

  private macroStep(): StepRecord {
    const backup = this.cloneState();
    const record: StepRecord = {
      stepIndex: this.state.stepsRun + 1,
      timeBefore: this.state.time,
      timeAfter: this.state.time,
      jumped: false,
      kind: "macro",
      source: "initial",
      callback: null,
      timerId: null,
      outputs: [],
      scheduled: [],
      cancels: [],
      microtaskQueueBefore: this.snapshotMicro(),
      microtaskQueueAfter: [],
      timerQueueBefore: this.snapshotTimers(),
      timerQueueAfter: [],
      microtasksExecuted: 0,
      starved: false,
    };
    try {
      let cbName: string;
      if (this.state.initialPending) {
        this.state.initialPending = false;
        cbName = this.spec.initial;
        record.source = "initial";
      } else {
        const next = this.liveTimers()[0];
        if (!next) {
          // 理论上不可达（done 判断已覆盖）
          fail("BUDGET_EXHAUSTED", "没有可执行的定时任务");
        }
        if (next.due > this.state.time) {
          record.jumped = true;
          this.state.time = next.due;
        }
        next.status = "executed";
        cbName = next.callback;
        record.source = "timer";
        record.timerId = next.id;
      }
      record.callback = cbName;
      this.state.position = { queue: "macro", callback: cbName, opIndex: 0 };
      this.execCallback(cbName, record);
      // 宏任务完成后的微任务检查点：FIFO 排空，包含新加入的微任务
      this.drainMicrotasks(record);
    } catch (e) {
      // 错误操作回滚：队列、时间、编号、输出全部恢复到本步之前
      this.state = backup;
      if (e instanceof AppError) throw e;
      throw e;
    }
    record.microtaskQueueAfter = this.snapshotMicro();
    record.timerQueueAfter = this.snapshotTimers();
    record.timeAfter = this.state.time;
    this.state.stepsRun++;
    if (record.starved) {
      const head = this.state.microtasks[0];
      this.state.position = { queue: "micro", callback: head?.callback ?? null, opIndex: 0 };
    } else {
      const t = this.liveTimers()[0];
      this.state.position = t
        ? { queue: "macro", callback: t.callback, opIndex: 0 }
        : { queue: "none", callback: null, opIndex: 0 };
    }
    return record;
  }

  /** 微任务检查点：FIFO 排空，执行微任务时新加入的微任务也在本轮排空 */
  private drainMicrotasks(record: StepRecord): void {
    let executed = 0;
    while (this.state.microtasks.length > 0) {
      if (executed >= this.limit && this.state.microtasks.length > 0) {
        // 饥饿：标记未完成并保留状态，绝不跳过剩余微任务去跑定时任务
        record.starved = true;
        record.microtasksExecuted = executed;
        this.state.status = "starved";
        return;
      }
      const task = this.state.microtasks.shift()!;
      executed++;
      this.state.position = { queue: "micro", callback: task.callback, opIndex: 0 };
      this.execCallback(task.callback, record);
    }
    record.microtasksExecuted = executed;
  }

  /** 执行一个命名回调（仅四类操作，零耗时）。任何非法操作抛错触发整步回滚。 */
  private execCallback(name: string, record: StepRecord): void {
    const ops: Op[] | undefined = this.spec.callbacks[name];
    if (!ops) fail("UNKNOWN_CALLBACK", `回调 ${name} 未定义`, { callback: name });
    for (const op of ops) {
      switch (op.op) {
        case "log":
          record.outputs.push(op.text);
          break;
        case "queueMicrotask":
          if (!(op.callback in this.spec.callbacks)) {
            fail("UNKNOWN_CALLBACK", `微任务引用了未定义回调 ${op.callback}`, { callback: op.callback });
          }
          this.state.microtasks.push({ callback: op.callback, seq: ++this.state.seq });
          break;
        case "setTimeout": {
          if (!(op.callback in this.spec.callbacks)) {
            fail("UNKNOWN_CALLBACK", `延时任务引用了未定义回调 ${op.callback}`, { callback: op.callback });
          }
          if (op.label !== undefined) {
            const clash = this.state.timers.find(
              (t) => t.label === op.label && t.status === "scheduled"
            );
            if (clash) {
              fail("LABEL_CONFLICT", `标签 ${op.label} 已被存活定时任务 #${clash.id} 占用（标签仅可在旧持有者执行/取消后重用）`, {
                label: op.label,
                holderId: clash.id,
              });
            }
          }
          const id = this.state.nextTimerId++;
          const timer: Timer = {
            id,
            callback: op.callback,
            due: this.state.time + op.delay,
            seq: ++this.state.seq,
            status: "scheduled",
            label: op.label ?? null,
          };
          this.state.timers.push(timer);
          const ev: ScheduledEvent = {
            id,
            callback: op.callback,
            delay: op.delay,
            due: timer.due,
            label: timer.label,
          };
          record.scheduled.push(ev);
          break;
        }
        case "clearTimeout": {
          record.cancels.push(this.cancelTimer(op.ref));
          break;
        }
      }
    }
  }

  /** 按编号或预登记标签取消；只影响指定的一次任务实例 */
  private cancelTimer(ref: number | string): CancelEvent {
    let timer: Timer | undefined;
    if (typeof ref === "number") {
      timer = this.state.timers.find((t) => t.id === ref);
    } else {
      timer = this.state.timers.find((t) => t.label === ref);
    }
    if (!timer) {
      return { ref, result: "not_found", targetId: null };
    }
    if (timer.status === "executed") {
      return { ref, result: "already_executed", targetId: timer.id };
    }
    if (timer.status === "cancelled") {
      return { ref, result: "already_cancelled", targetId: timer.id };
    }
    timer.status = "cancelled";
    return { ref, result: "cancelled", targetId: timer.id };
  }

  private cloneState(): SimState {
    return structuredClone(this.state);
  }
}

/** 把引擎执行结果串成线性日志（全局顺序） */
export function linearLog(records: StepRecord[]): string[] {
  const out: string[] = [];
  for (const r of records) out.push(...r.outputs);
  return out;
}
