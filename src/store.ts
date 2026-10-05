/**
 * SQLite 持久化层。
 *
 * scenarios 表保存创建时冻结的回调定义；运行后修改定义只会创建新场景，
 * 旧场景的队列继续运行旧版回调。
 * states 表以单行 JSON 保存完整模拟状态（模拟时间、编号、两类队列、
 * 标签表、回调内部位置所在的日志、日志本身），单步与日志在一个事务中
 * 原子提交——暂停/重启与连续运行结果完全一致。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ScenarioDef, SimState } from './types.js';
import { SimError } from './types.js';
import { initialState } from './engine.js';

export interface ScenarioRow {
  id: number;
  name: string;
  def: ScenarioDef;
  createdAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scenarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        def_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS states (
        scenario_id INTEGER PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (scenario_id) REFERENCES scenarios(id)
      );
    `);
  }

  createScenario(name: string, def: ScenarioDef): { id: number; state: SimState } {
    const existing = this.db.prepare('SELECT id FROM scenarios WHERE name = ?').get(name);
    if (existing) {
      throw new SimError('E_STATE_CONFLICT', `场景名已存在: ${name}`);
    }
    const insert = this.db.prepare('INSERT INTO scenarios (name, def_json) VALUES (?, ?)');
    const insState = this.db.prepare(
      "INSERT INTO states (scenario_id, state_json) VALUES (?, ?)",
    );
    let id = 0;
    this.tx(() => {
      const info = insert.run(name, JSON.stringify({ ...def, name }));
      id = Number(info.lastInsertRowid);
      insState.run(id, JSON.stringify(initialState(id)));
    });
    return { id, state: initialState(id) };
  }

  listScenarios(): Array<Pick<ScenarioRow, 'id' | 'name' | 'createdAt'>> {
    const rows = this.db
      .prepare('SELECT id, name, created_at as createdAt FROM scenarios ORDER BY id')
      .all() as Array<{ id: number; name: string; createdAt: string }>;
    return rows;
  }

  getScenario(id: number): ScenarioRow {
    const row = this.db
      .prepare('SELECT id, name, def_json, created_at FROM scenarios WHERE id = ?')
      .get(id) as
      | { id: number; name: string; def_json: string; created_at: string }
      | undefined;
    if (!row) throw new SimError('E_NOT_FOUND', `场景不存在: #${id}`);
    return {
      id: row.id,
      name: row.name,
      def: JSON.parse(row.def_json) as ScenarioDef,
      createdAt: row.created_at,
    };
  }

  /** 冻结定义 + 当前状态的完整导出 */
  export(id: number): { scenario: ScenarioRow; state: SimState } {
    const scenario = this.getScenario(id);
    return { scenario, state: this.getState(id) };
  }

  getState(id: number): SimState {
    this.getScenario(id); // 确保存在，抛 E_NOT_FOUND
    const row = this.db
      .prepare('SELECT state_json FROM states WHERE scenario_id = ?')
      .get(id) as { state_json: string } | undefined;
    if (!row) throw new SimError('E_NOT_FOUND', `状态不存在: #${id}`);
    return JSON.parse(row.state_json) as SimState;
  }

  /**
   * 原子地保存状态。调用方应先在内存副本上推进（step 内部已保证失败回滚），
   * 这里用数据库事务保证单步状态与其日志同时落盘。
   */
  saveState(state: SimState): void {
    const stmt = this.db.prepare(
      `UPDATE states
       SET state_json = ?, updated_at = datetime('now')
       WHERE scenario_id = ?`,
    );
    this.tx(() => {
      stmt.run(JSON.stringify(state), state.scenarioId);
    });
  }

  close(): void {
    this.db.close();
  }

  /** 显式事务，异常时回滚并原样抛出 */
  private tx(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      if (err instanceof SimError) throw err;
      throw new SimError('E_STATE_CONFLICT', `数据库事务失败: ${(err as Error).message}`);
    }
  }
}
