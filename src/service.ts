import { Store } from "./store.js";
import { Engine } from "./engine.js";
import { validateSpec } from "./validate.js";
import type { ScenarioSpec, StepRecord } from "./types.js";

export interface RunResult {
  records: StepRecord[];
  appendedLog: string[];
  state: ReturnType<Engine["view"]>;
}

export class Service {
  constructor(public readonly store: Store) {}

  validate(input: unknown): { valid: true; spec: ScenarioSpec } {
    return { valid: true, spec: validateSpec(input) };
  }

  create(name: string, input: unknown) {
    const spec = validateSpec(input);
    return this.store.createScenario(name, spec);
  }

  list() {
    return this.store.listScenarios();
  }

  private engine(name: string): { engine: Engine; id: number; spec: ScenarioSpec } {
    const row = this.store.requireScenario(name);
    return { engine: new Engine(row.spec, this.store.loadState(row.id)), id: row.id, spec: row.spec };
  }

  run(name: string, budget: number, maxCallbacks?: number): RunResult {
    const { engine, id } = this.engine(name);
    const records = engine.run(budget, maxCallbacks);
    const oldLog = this.store.loadLog(id);
    const appended: string[] = [];
    for (const r of records) appended.push(...r.outputs);
    this.store.commitSteps(id, engine.state, records, [...oldLog, ...appended]);
    return { records, appendedLog: appended, state: engine.view() };
  }

  queues(name: string) {
    return this.engine(name).engine.view();
  }

  log(name: number | string) {
    const row =
      typeof name === "number"
        ? this.store.listScenarios().find((s) => s.id === name)
        : this.store.getScenarioByName(name);
    if (!row) return null;
    return {
      name: row.name,
      linearLog: this.store.loadLog(row.id),
      steps: this.store.loadSteps(row.id),
    };
  }

  exportScenario(name: string) {
    const row = this.store.requireScenario(name);
    return {
      name: row.name,
      createdAt: row.createdAt,
      spec: row.spec,
      state: this.store.loadState(row.id),
      steps: this.store.loadSteps(row.id),
      linearLog: this.store.loadLog(row.id),
    };
  }

  /** 比较两个场景的线性日志、逐步记录与最终队列/时间 */
  compare(a: string, b: string) {
    const ra = this.store.requireScenario(a);
    const rb = this.store.requireScenario(b);
    const ea = new Engine(ra.spec, this.store.loadState(ra.id));
    const eb = new Engine(rb.spec, this.store.loadState(rb.id));
    const la = this.store.loadLog(ra.id);
    const lb = this.store.loadLog(rb.id);
    const sa = this.store.loadSteps(ra.id);
    const sb = this.store.loadSteps(rb.id);
    return {
      sameLog: JSON.stringify(la) === JSON.stringify(lb),
      sameSteps: JSON.stringify(sa) === JSON.stringify(sb),
      sameFinalState: JSON.stringify(ea.view()) === JSON.stringify(eb.view()),
      a: { name: a, log: la, steps: sa, state: ea.view() },
      b: { name: b, log: lb, steps: sb, state: eb.view() },
    };
  }
}
