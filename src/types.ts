/**
 * 核心数据类型定义。
 *
 * 本模拟器只建模事件循环的两个队列：
 *  - 普通（宏）任务中的延时任务队列 timers（按到期时间、登记顺序排序）
 *  - 微任务队列 microtasks（FIFO，回调内新加入的微任务排在队尾并继续排空）
 *
 * 初始脚本是第一个普通任务；普通任务执行完后必须先排空微任务队列，
 * 然后才能选择下一个普通（延时）任务。
 */

/** 允许的四类操作 */
export type OpType = 'log' | 'micro' | 'schedule' | 'cancel';

export interface LogOp {
  op: 'log';
  text: string;
}

export interface MicroOp {
  op: 'micro';
  /** 要作为微任务入队的回调名 */
  callback: string;
}

export interface ScheduleOp {
  op: 'schedule';
  /** 要登记的回调名 */
  callback: string;
  /** 非负整数延时（相对当前模拟时间，到期时间 = now + delay） */
  delay: number;
  /** 可选：用户预先指定的唯一标签，用于后续 cancel 引用 */
  label?: string;
}

export interface CancelOp {
  op: 'cancel';
  /** 通过用户标签取消（与 taskId 二选一） */
  label?: string;
  /** 通过稳定任务编号取消（与 label 二选一） */
  taskId?: number;
}

export type Operation = LogOp | MicroOp | ScheduleOp | CancelOp;

/** 命名回调定义：只允许包含四类操作的有序列表，不能是任意 JavaScript */
export interface CallbackDef {
  name: string;
  ops: Operation[];
}

/** 场景定义 */
export interface ScenarioDef {
  name: string;
  description?: string;
  /** 冻结的命名回调表 */
  callbacks: CallbackDef[];
  /** 初始脚本（第一个普通任务）的操作序列 */
  init: Operation[];
  /** 单个场景允许执行的步数上限，防止微任务无限递归导致永久饥饿 */
  maxSteps?: number;
}

/** 队列中一次具体执行的任务实例（回调定义 ≠ 队列中的一次执行） */
export interface TaskInstance {
  /** 稳定任务编号：schedule 时分配，全局单调递增 */
  taskId: number;
  /** 引用的回调名 */
  callback: string;
  kind: 'timer';
  /** 到期模拟时间 */
  due: number;
  /** 登记顺序（同刻稳定排序的依据） */
  seq: number;
  /** 用户标签（可选，全局唯一） */
  label: string | null;
  status: 'scheduled' | 'executed' | 'cancelled';
}

export interface MicroTask {
  /** 微任务自身的稳定序号，便于日志展示排队来源 */
  id: number;
  callback: string;
  /** 登记顺序 */
  seq: number;
}

/** 取消操作的公开结果 */
export type CancelResult =
  | 'cancelled'
  | 'not_found'
  | 'already_executed'
  | 'already_cancelled';

/** 一条逐步日志 */
export interface StepLog {
  step: number;
  /** 当前执行的单元类型：普通任务（init/timer）或微任务 */
  unit: 'init' | 'timer' | 'micro';
  taskId: number | null;
  callback: string;
  /** 当前模拟时间 */
  now: number;
  /** 本步内回调产生的文字输出，按顺序 */
  outputs: string[];
  /** 本步内 schedule 分配的任务编号（按操作顺序） */
  scheduled: Array<{ taskId: number; callback: string; due: number; label: string | null }>;
  /** 本步内每次 cancel 的结果 */
  cancels: Array<{ target: string; result: CancelResult }>;
  /** 本步回调内部位置（执行到回调的第几个操作，0 基） */
  opIndex: number;
  /** 本步开始前的队列快照 */
  queuesBefore: QueueSnapshot;
  /** 本步结束后的队列快照 */
  queuesAfter: QueueSnapshot;
  /** 自然结束标记：本步之后已无任何待执行任务（仅最后一步可能为 true） */
  finished?: boolean;
  note?: string;
}

export interface QueueSnapshot {
  /** 待执行微任务（队首在前） */
  micro: Array<{ id: number; callback: string }>;
  /** 待执行延时任务（按到期时间、登记顺序） */
  timers: Array<{ taskId: number; callback: string; due: number; seq: number; label: string | null }>;
  /** 已登记标签 -> 任务编号 */
  labels: Record<string, number>;
}

/** 模拟器完整可持久化状态 */
export interface SimState {
  scenarioId: number;
  now: number;
  /** 下一个可分配的稳定任务编号 */
  nextTaskId: number;
  /** 下一个微任务序号 */
  nextMicroId: number;
  /** 下一个登记顺序号 */
  nextSeq: number;
  timers: TaskInstance[];
  micros: MicroTask[];
  /** 标签 -> 任务编号（标签一经登记全局唯一，不可重用） */
  labels: Record<string, number>;
  /** 初始脚本是否已经作为首个普通任务执行 */
  initDone: boolean;
  /** 已执行步数 */
  stepCount: number;
  status: 'ready' | 'finished' | 'starved' | 'step_limit';
  logs: StepLog[];
}

export interface ApiError {
  code:
    | 'E_VALIDATION'
    | 'E_UNKNOWN_OP'
    | 'E_UNKNOWN_CALLBACK'
    | 'E_NEGATIVE_DELAY'
    | 'E_BAD_PARAM'
    | 'E_LABEL_REUSE'
    | 'E_CANCEL_TARGET_UNKNOWN'
    | 'E_NOT_FOUND'
    | 'E_STATE_CONFLICT'
    | 'E_BAD_REQUEST';
  message: string;
  details?: unknown;
}

export class SimError extends Error {
  code: ApiError['code'];
  details?: unknown;
  constructor(code: ApiError['code'], message: string, details?: unknown) {
    super(message);
    this.name = 'SimError';
    this.code = code;
    this.details = details;
  }
}
