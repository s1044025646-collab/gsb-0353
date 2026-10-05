import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ScenarioSpec, SimState, StepRecord } from "./types.js";
import { fail } from "./errors.js";
import { initialState } from "./engine.js";

export interface ScenarioRow {
  id: number;
  name: string;
  spec: ScenarioSpec;
  createdAt: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    const abs = resolve(dbPath);
    mkdirSync(dirname(abs), { recursive: true });
    this.db = new DatabaseSync(abs);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  /** 删除场景及其全部模拟状态（主要给可重复演示使用） */
  deleteScenario(name: string): boolean {
    const row = this.getScenarioByName(name);
    if (!row) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM steps WHERE scenario_id = ?").run(row.id);
      this.db.prepare("DELETE FROM sims WHERE scenario_id = ?").run(row.id);
      this.db.prepare("DELETE FROM scenarios WHERE id = ?").run(row.id);
      this.db.exec("COMMIT");
      return true;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scenarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        spec_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS sims (
        scenario_id INTEGER PRIMARY KEY REFERENCES scenarios(id),
        state_json TEXT NOT NULL,
        log_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS steps (
        scenario_id INTEGER NOT NULL REFERENCES scenarios(id),
        seq INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        PRIMARY KEY (scenario_id, seq)
      );
    `);
  }

  createScenario(name: string, spec: ScenarioSpec): ScenarioRow {
    if (typeof name !== "string" || !/^[A-Za-z0-9_\-.\u4e00-\u9fa5]{1,64}$/.test(name)) {
      fail("BAD_SCENARIO_NAME", "场景名只允许 1-64 个字母、数字、下划线、短横线、点或中文字符");
    }
    const specJson = JSON.stringify(spec);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const info = this.db
        .prepare("INSERT INTO scenarios (name, spec_json) VALUES (?, ?)")
        .run(name, specJson);
      const id = Number(info.lastInsertRowid);
      this.db
        .prepare("INSERT INTO sims (scenario_id, state_json, log_json) VALUES (?, ?, '[]')")
        .run(id, JSON.stringify(initialState()));
      this.db.exec("COMMIT");
      return this.getScenarioByName(name)!;
    } catch (e) {
      this.db.exec("ROLLBACK");
      if (
        (e as NodeJS.ErrnoException).code === "SQLITE_CONSTRAINT_UNIQUE" ||
        /UNIQUE constraint failed/.test((e as Error).message ?? "")
      ) {
        fail("SCENARIO_FROZEN", `场景 ${name} 已存在；修改回调定义请用新名称创建新场景，旧场景保持冻结`);
      }
      throw e;
    }
  }

  private rowToScenario(row: { id: number; name: string; spec_json: string; created_at: string }): ScenarioRow {
    return { id: row.id, name: row.name, spec: JSON.parse(row.spec_json) as ScenarioSpec, createdAt: row.created_at };
  }

  listScenarios(): ScenarioRow[] {
    const rows = this.db.prepare("SELECT * FROM scenarios ORDER BY id").all() as Array<{
      id: number; name: string; spec_json: string; created_at: string;
    }>;
    return rows.map((r) => this.rowToScenario(r));
  }

  getScenarioByName(name: string): ScenarioRow | null {
    const row = this.db.prepare("SELECT * FROM scenarios WHERE name = ?").get(name) as
      | { id: number; name: string; spec_json: string; created_at: string }
      | undefined;
    return row ? this.rowToScenario(row) : null;
  }

  requireScenario(name: string): ScenarioRow {
    const s = this.getScenarioByName(name);
    if (!s) fail("SCENARIO_NOT_FOUND", `场景 ${name} 不存在`);
    return s;
  }

  loadState(id: number): SimState {
    const row = this.db.prepare("SELECT state_json FROM sims WHERE scenario_id = ?").get(id) as
      | { state_json: string }
      | undefined;
    if (!row) fail("SCENARIO_NOT_FOUND", `场景 id=${id} 没有模拟状态`);
    return JSON.parse(row.state_json) as SimState;
  }

  loadLog(id: number): string[] {
    const row = this.db.prepare("SELECT log_json FROM sims WHERE scenario_id = ?").get(id) as
      | { log_json: string }
      | undefined;
    return JSON.parse(row!.log_json) as string[];
  }

  loadSteps(id: number): StepRecord[] {
    const rows = this.db
      .prepare("SELECT record_json FROM steps WHERE scenario_id = ? ORDER BY seq")
      .all(id) as Array<{ record_json: string }>;
    return rows.map((r) => JSON.parse(r.record_json) as StepRecord);
  }

  /** 单步状态与日志原子提交：要么整批步进落盘，要么完全不动 */
  commitSteps(id: number, state: SimState, records: StepRecord[], appendedLog: string[]): void {
    const stateJson = JSON.stringify(state);
    const logJson = JSON.stringify(appendedLog);
    const insertStep = this.db.prepare(
      "INSERT INTO steps (scenario_id, seq, record_json) VALUES (?, ?, ?)"
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE sims SET state_json = ?, log_json = ? WHERE scenario_id = ?").run(
        stateJson,
        logJson,
        id
      );
      for (const r of records) insertStep.run(id, r.stepIndex, JSON.stringify(r));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
