/**
 * 纯函数模拟引擎：不触碰数据库、不使用真实计时器、不 sleep。
 *
 * 关键规则：
 *  1. 初始脚本是第一个普通任务（unit='init'）。
 *  2. 每个普通任务执行完后，FIFO 排空微任务队列——包括执行微任务时
 *     新加入的微任务（排在队尾继续执行）。
 *  3. 微任务队列清空后才选择下一个延时任务；零延时任务也不能在当前
 *     回调中插队，也不与微任务共用队列。
 *  4. 延时任务按 (due, seq) 排序；没有可执行任务时时钟跳到下一到期时间。
 *  5. 每个 schedule 返回稳定任务编号；cancel 只影响指定任务实例。
 */
import type {
  CancelResult,
  Operation,
  QueueSnapshot,
  ScenarioDef,
  SimState,
  StepLog,
} from './types.js';
import { SimError } from './types.js';

export const DEFAULT_MAX_STEPS = 10_000;

export function initialState(scenarioId: number): SimState {
  return {
    scenarioId,
    now: 0,
    nextTaskId: 1,
    nextMicroId: 1,
    nextSeq: 1,
    timers: [],
    micros: [],
    labels: {},
    initDone: false,
    stepCount: 0,
    status: 'ready',
    logs: [],
  };
}

export function snapshotQueues(s: SimState): QueueSnapshot {
  return {
    micro: s.micros.map((m) => ({ id: m.id, callback: m.callback })),
    timers: s.timers
      .filter((t) => t.status === 'scheduled')
      .sort(timerOrder)
      .map((t) => ({
        taskId: t.taskId,
        callback: t.callback,
        due: t.due,
        seq: t.seq,
        label: t.label,
      })),
    labels: { ...s.labels },
  };
}

function timerOrder(
  a: { due: number; seq: number },
  b: { due: number; seq: number },
): number {
  return a.due - b.due || a.seq - b.seq;
}

/** 是否还有未来可执行的工作 */
export function hasWork(s: SimState): boolean {
  if (!s.initDone) return true;
  if (s.micros.length > 0) return true;
  return s.timers.some((t) => t.status === 'scheduled');
}

/**
 * 推进一个执行单元（一个普通任务或一个微任务），原子地追加一条日志。
 * 若回调内操作非法（例如重用标签），抛出 SimError 且状态保持不变（回滚）。
 */
export function step(def: ScenarioDef, state: SimState): StepLog {
  if (state.status === 'finished') {
    throw new SimError('E_STATE_CONFLICT', '场景已结束，没有可执行任务');
  }
  const maxSteps = def.maxSteps ?? DEFAULT_MAX_STEPS;
  if (state.stepCount >= maxSteps) {
    throw new SimError(
      'E_STATE_CONFLICT',
      `已达到步数上限 ${maxSteps}，场景标记为 ${state.status}`,
    );
  }

  // 在试算副本上执行；只有成功才整体提交，保证错误操作回滚。
  const draft = cloneState(state);

  let unit: StepLog['unit'];
  let callback: string;
  let taskId: number | null = null;
  let ops: Operation[];
  let note: string | undefined;

  if (!draft.initDone) {
    unit = 'init';
    callback = '<init>';
    ops = def.init;
    draft.initDone = true;
  } else if (draft.micros.length > 0) {
    // 微任务检查点：普通任务完成后，微任务优先于所有延时任务。
    const micro = draft.micros.shift()!;
    unit = 'micro';
    callback = micro.callback;
    ops = mustGetCallback(def, micro.callback).ops;
  } else {
    const ready = draft.timers
      .filter((t) => t.status === 'scheduled')
      .sort(timerOrder);
    if (ready.length === 0) {
      // 走到这里说明 init 已完成、微任务已排空、也没有定时任务：
      // 这属于“运行到自然结束”，幂等返回，不重复推进、不报错。
      return { finished: true } as StepLog;
    }
    const next = ready[0];
    // 无可立即执行的任务时，时钟跳到下一到期时间（绝不使用真实 sleep）。
    if (next.due > draft.now) {
      draft.now = next.due;
      note = `时钟跳转到到期时间 ${next.due}`;
    }
    next.status = 'executed';
    unit = 'timer';
    callback = next.callback;
    taskId = next.taskId;
    ops = mustGetCallback(def, next.callback).ops;
  }

  const queuesBefore = snapshotQueues(draft);
  const outputs: string[] = [];
  const scheduled = [] as StepLog['scheduled'];
  const cancels = [] as StepLog['cancels'];
  let opIndex = -1;

  ops.forEach((op, i) => {
    opIndex = i;
    applyOp(draft, op, outputs, scheduled, cancels);
  });

  draft.stepCount += 1;

  // 判定终态：步数上限到达时区分“微任务饥饿”与“普通任务到限”，
  // 绝不清空微任务、绝不强行先跑定时任务。
  let statusAfter = draft.status;
  if (draft.stepCount >= maxSteps && hasWork(draft)) {
    statusAfter = draft.micros.length > 0 ? 'starved' : 'step_limit';
  } else if (!hasWork(draft)) {
    statusAfter = 'finished';
  }
  draft.status = statusAfter;
  const finished = statusAfter === 'finished';

  const log: StepLog = {
    step: draft.stepCount,
    unit,
    taskId,
    callback,
    now: draft.now,
    outputs,
    scheduled,
    cancels,
    opIndex,
    queuesBefore,
    queuesAfter: snapshotQueues(draft),
    ...(finished ? { finished: true } : {}),
    ...(note ? { note } : {}),
  };
  draft.logs.push(log);

  commit(state, draft);
  return log;
}

function applyOp(
  s: SimState,
  op: Operation,
  outputs: string[],
  scheduled: StepLog['scheduled'],
  cancels: StepLog['cancels'],
): void {
  switch (op.op) {
    case 'log':
      outputs.push(op.text);
      return;
    case 'micro':
      s.micros.push({ id: s.nextMicroId, callback: op.callback, seq: s.nextSeq++ });
      s.nextMicroId += 1;
      return;
    case 'schedule': {
      if (op.label !== undefined) {
        if (Object.prototype.hasOwnProperty.call(s.labels, op.label)) {
          // 标签一经登记全局唯一，禁止重用（即使旧任务已执行/取消）。
          throw new SimError(
            'E_LABEL_REUSE',
            `标签已被登记，不能重用: ${op.label}（已指向任务 #${s.labels[op.label]}）`,
          );
        }
      }
      const taskId = s.nextTaskId++;
      const due = s.now + op.delay;
      s.timers.push({
        taskId,
        callback: op.callback,
        kind: 'timer',
        due,
        seq: s.nextSeq++,
        label: op.label ?? null,
        status: 'scheduled',
      });
      if (op.label !== undefined) s.labels[op.label] = taskId;
      scheduled.push({ taskId, callback: op.callback, due, label: op.label ?? null });
      return;
    }
    case 'cancel': {
      let target: string;
      let taskId: number | undefined;
      if (op.label !== undefined) {
        target = `label:${op.label}`;
        // 引用未登记标签：公开 not_found，不能默默取消别的对象。
        if (!Object.prototype.hasOwnProperty.call(s.labels, op.label)) {
          cancels.push({ target, result: 'not_found' });
          return;
        }
        taskId = s.labels[op.label];
      } else {
        taskId = op.taskId!;
        target = `task:#${taskId}`;
      }
      const task = s.timers.find((t) => t.taskId === taskId);
      let result: CancelResult;
      if (!task) {
        result = 'not_found';
      } else if (task.status === 'executed') {
        result = 'already_executed';
      } else if (task.status === 'cancelled') {
        result = 'already_cancelled';
      } else {
        task.status = 'cancelled';
        result = 'cancelled';
      }
      cancels.push({ target, result });
      return;
    }
  }
}

function mustGetCallback(def: ScenarioDef, name: string) {
  const cb = def.callbacks.find((c) => c.name === name);
  if (!cb) throw new SimError('E_UNKNOWN_CALLBACK', `未定义回调: ${name}`);
  return cb;
}

/**
 * 按预算运行最多 budget 个执行单元。
 * 返回新增的日志；遇到 finished/starved/step_limit 即停止。
 */
export function runBudget(def: ScenarioDef, state: SimState, budget: number): StepLog[] {
  if (!Number.isInteger(budget) || budget <= 0) {
    throw new SimError('E_BAD_PARAM', 'budget 必须是正整数');
  }
  const out: StepLog[] = [];
  for (let i = 0; i < budget; i += 1) {
    if (state.status === 'finished' || state.status === 'starved' || state.status === 'step_limit') {
      break;
    }
    const l = step(def, state);
    if (l.finished) break; // 自然结束（无实际工作），不计入预算
    out.push(l);
  }
  return out;
}

/** 一路运行到结束或步数上限（教学/测试便捷方法） */
export function runAll(def: ScenarioDef, state: SimState): StepLog[] {
  const max = def.maxSteps ?? DEFAULT_MAX_STEPS;
  return runBudget(def, state, max);
}

function cloneState(s: SimState): SimState {
  return {
    scenarioId: s.scenarioId,
    now: s.now,
    nextTaskId: s.nextTaskId,
    nextMicroId: s.nextMicroId,
    nextSeq: s.nextSeq,
    timers: s.timers.map((t) => ({ ...t })),
    micros: s.micros.map((m) => ({ ...m })),
    labels: { ...s.labels },
    initDone: s.initDone,
    stepCount: s.stepCount,
    status: s.status,
    logs: s.logs.map((l) => structuredClone(l)),
  };
}

function commit(target: SimState, draft: SimState): void {
  target.now = draft.now;
  target.nextTaskId = draft.nextTaskId;
  target.nextMicroId = draft.nextMicroId;
  target.nextSeq = draft.nextSeq;
  target.timers = draft.timers;
  target.micros = draft.micros;
  target.labels = draft.labels;
  target.initDone = draft.initDone;
  target.stepCount = draft.stepCount;
  target.status = draft.status;
  target.logs = draft.logs;
}

/** 比较两个场景的逐步结果，返回第一个不一致的步骤；一致返回 null */
export function compareLogs(
  a: StepLog[],
  b: StepLog[],
): { index: number; a: StepLog; b: StepLog } | null {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (!a[i] || !b[i]) return { index: i, a: a[i] as StepLog, b: b[i] as StepLog };
    const x = comparable(a[i]);
    const y = comparable(b[i]);
    if (JSON.stringify(x) !== JSON.stringify(y)) {
      return { index: i, a: a[i], b: b[i] };
    }
  }
  return null;
}

/** 比较时只看确定性的执行事实，不看队列快照里的冗余标签表 */
function comparable(l: StepLog) {
  return {
    step: l.step,
    unit: l.unit,
    taskId: l.taskId,
    callback: l.callback,
    now: l.now,
    outputs: l.outputs,
    scheduled: l.scheduled,
    cancels: l.cancels,
  };
}
