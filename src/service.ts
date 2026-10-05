import type { QueueSnapshot, ScenarioDef, SimState, StepLog } from './types.js';
import { SimError } from './types.js';
import {
  compareLogs,
  hasWork,
  initialState,
  runBudget,
  snapshotQueues,
  step,
} from './engine.js';
import { validateScenario } from './validation.js';
import type { Store } from './store.js';

export interface StepResult {
  log: StepLog;
  state: SimState;
}

export class Service {
  constructor(private store: Store) {}

  /** 仅校验回调定义，不创建场景 */
  validate(raw: unknown): { valid: true; def: ScenarioDef } {
    return { valid: true, def: validateScenario(raw) };
  }

  create(raw: unknown): { id: number; state: SimState } {
    const def = validateScenario(raw);
    return this.store.createScenario(def.name, def);
  }

  list() {
    return this.store.listScenarios();
  }

  private load(id: number): { def: ScenarioDef; state: SimState } {
    const row = this.store.getScenario(id);
    return { def: row.def, state: this.store.getState(id) };
  }

  stepOnce(id: number): StepResult {
    const { def, state } = this.load(id);
    const log = step(def, state); // 非法操作在此抛出，state 未改动，无落盘即回滚
    this.store.saveState(state);
    return { log, state };
  }

  run(id: number, budget: number): { ran: number; state: SimState; logs: StepLog[] } {
    const { def, state } = this.load(id);
    const before = state.logs.length;
    const logs = runBudget(def, state, budget);
    if (logs.length > 0) this.store.saveState(state);
    return { ran: state.logs.length - before, state, logs };
  }

  queues(id: number): { now: number; status: SimState['status']; queues: QueueSnapshot } {
    const { state } = this.load(id);
    return { now: state.now, status: state.status, queues: snapshotQueues(state) };
  }

  logs(id: number, fromStep?: number): { logs: StepLog[]; state: SimState } {
    const { state } = this.load(id);
    const logs =
      fromStep === undefined ? state.logs : state.logs.filter((l) => l.step >= fromStep);
    return { logs, state };
  }

  state(id: number) {
    return this.load(id);
  }

  export(id: number) {
    return this.store.export(id);
  }

  /** 比较两个场景（常用于逐步 vs 预算 vs 重启恢复） */
  compare(aId: number, bId: number) {
    const a = this.load(aId);
    const b = this.load(bId);
    const firstDiff = compareLogs(a.state.logs, b.state.logs);
    const queueEq = JSON.stringify(snapshotQueues(a.state)) === JSON.stringify(snapshotQueues(b.state));
    return {
      a: aId,
      b: bId,
      sameLength: a.state.logs.length === b.state.logs.length,
      sameLogs: firstDiff === null,
      sameFinalQueues: queueEq,
      sameNow: a.state.now === b.state.now,
      sameStatus: a.state.status === b.state.status,
      firstDiff,
      aWorkLeft: hasWork(a.state),
      bWorkLeft: hasWork(b.state),
    };
  }
}

export { SimError, initialState };
