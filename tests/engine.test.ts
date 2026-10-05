import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cancelScenario,
  checkpointExpected,
  checkpointScenario,
  sameTickExpected,
  sameTickScenario,
  starvationScenario,
} from '../src/demo.js';
import {
  compareLogs,
  initialState,
  runAll,
  runBudget,
  snapshotQueues,
  step,
} from '../src/engine.js';
import { validateScenario } from '../src/validation.js';
import { SimError, type ScenarioDef, type SimState } from '../src/types.js';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';

function outputs(state: SimState): string[] {
  return state.logs.flatMap((l) => l.outputs);
}

/** Windows 上 SQLite WAL 文件偶尔延迟释放，清理时做有限重试 */
function removeDir(dir: string): void {
  for (let i = 0; i < 5; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      const wait = 20 * (i + 1);
      // 同步忙等仅用于测试清理
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
}

test('检查点：微任务链先于零延时任务', () => {
  const s = initialState(1);
  runAll(checkpointScenario, s);
  assert.deepEqual(outputs(s), checkpointExpected);
  assert.equal(s.status, 'finished');
});

test('零延时任务不能在当前回调中插队，微任务继续排空', () => {
  const s = initialState(1);
  runAll(sameTickScenario, s);
  assert.deepEqual(outputs(s), sameTickExpected);
});

test('同刻定时任务按登记顺序稳定排序，取消只影响指定实例', () => {
  const s = initialState(1);
  runAll(cancelScenario, s);
  assert.deepEqual(outputs(s), ['t1', 't3']);
  const cancels = s.logs.flatMap((l) => l.cancels);
  assert.deepEqual(
    cancels.map((c) => c.result).sort(),
    ['already_cancelled', 'cancelled', 'not_found', 'not_found'],
  );
  // 被取消的任务实例与另外两个同刻任务实例身份独立
  const statuses = Object.fromEntries(s.timers.map((t) => [t.taskId, t.status]));
  assert.equal(Object.values(statuses).filter((x) => x === 'cancelled').length, 1);
  assert.equal(Object.values(statuses).filter((x) => x === 'executed').length, 2);
});

test('时钟只在没有可执行任务时跳到下一到期时间', () => {
  const def: ScenarioDef = {
    name: 'clock',
    callbacks: [
      {
        name: 'late',
        ops: [{ op: 'log', text: 'late' }],
      },
    ],
    init: [{ op: 'schedule', callback: 'late', delay: 7 }],
  };
  const s = initialState(1);
  step(def, s); // init
  assert.equal(s.now, 0);
  const timerLog = step(def, s); // 时钟跳到 7
  assert.equal(s.now, 7);
  assert.match(timerLog.note ?? '', /7/);
});

test('微任务饥饿：达到上限标记 starved，保留微任务，定时任务不执行', () => {
  const s = initialState(1);
  runBudget(starvationScenario, s, 100);
  assert.equal(s.status, 'starved');
  assert.equal(s.stepCount, 10);
  const q = snapshotQueues(s);
  assert.ok(q.micro.length > 0);
  assert.equal(q.timers.length, 1); // 定时任务仍在，绝不被强行执行
});

test('预算分批运行与一次跑完日志完全一致（预算恢复）', () => {
  const full = initialState(1);
  runAll(checkpointScenario, full);

  const chunked = initialState(2);
  while (chunked.status === 'ready') runBudget(checkpointScenario, chunked, 1);
  assert.equal(compareLogs(full.logs, chunked.logs), null);
  assert.deepEqual(snapshotQueues(full), snapshotQueues(chunked));
});

test('取消已执行任务返回 already_executed', () => {
  const def: ScenarioDef = {
    name: 'cancel-executed',
    callbacks: [{ name: 'c', ops: [{ op: 'log', text: 'ran' }] }],
    init: [
      { op: 'schedule', callback: 'c', delay: 0, label: 'x' },
      { op: 'micro', callback: 'drain' },
    ],
    // micro callback 排在 timer 之前；在 timer 执行后再取消
  };
  def.callbacks.push({ name: 'drain', ops: [{ op: 'log', text: 'drained' }] });
  const s = initialState(1);
  runAll(def, s);
  // 初始脚本中 cancel 标签不存在
  const fresh = initialState(2);
  const def2: ScenarioDef = {
    name: 'cancel-executed2',
    callbacks: [
      { name: 'c', ops: [{ op: 'log', text: 'ran' }, { op: 'cancel', label: 'x' }] },
    ],
    init: [{ op: 'schedule', callback: 'c', delay: 0, label: 'x' }],
  };
  runAll(def2, fresh);
  const result = fresh.logs.find((l) => l.cancels.length > 0)!.cancels[0].result;
  assert.equal(result, 'already_executed');
  void def;
  void s;
});

test('标签重用被拒绝，且错误操作回滚不改变状态', () => {
  const def: ScenarioDef = {
    name: 'label-reuse',
    callbacks: [{ name: 'c', ops: [{ op: 'log', text: 'c' }] }],
    init: [
      { op: 'schedule', callback: 'c', delay: 1, label: 'dup' },
      { op: 'schedule', callback: 'c', delay: 2, label: 'dup' },
    ],
  };
  const s = initialState(1);
  const before = JSON.stringify(s);
  assert.throws(
    () => step(def, s),
    (e: unknown) => e instanceof SimError && e.code === 'E_LABEL_REUSE',
  );
  // 回滚：初始脚本相当于未执行，编号/队列/日志都不变化
  assert.equal(JSON.stringify(s), before);
  assert.equal(s.initDone, false);
  assert.equal(s.stepCount, 0);
});

test('schedule 返回稳定编号，同名回调的多个实例互不干扰', () => {
  const def: ScenarioDef = {
    name: 'identity',
    callbacks: [
      {
        name: 'c',
        ops: [
          { op: 'log', text: 'c' },
          { op: 'schedule', callback: 'c', delay: 1 },
        ],
      },
    ],
    init: [{ op: 'schedule', callback: 'c', delay: 0 }],
  };
  const s = initialState(1);
  runBudget(def, s, 3);
  // 每次 schedule 分配唯一编号，实例不重复执行
  const executedIds = s.logs.filter((l) => l.taskId !== null).map((l) => l.taskId);
  assert.equal(new Set(executedIds).size, executedIds.length);
});

test('校验：拒绝未知操作、未知回调、负延时、非法参数', () => {
  const base: ScenarioDef = {
    name: 'valid',
    callbacks: [{ name: 'c', ops: [] }],
    init: [],
  };
  assert.throws(
    () => validateScenario({ ...base, init: [{ op: 'explode' }] }),
    (e: unknown) => e instanceof SimError && e.code === 'E_UNKNOWN_OP',
  );
  assert.throws(
    () => validateScenario({ ...base, init: [{ op: 'micro', callback: 'nope' }] }),
    (e: unknown) => e instanceof SimError && e.code === 'E_UNKNOWN_CALLBACK',
  );
  assert.throws(
    () => validateScenario({ ...base, init: [{ op: 'schedule', callback: 'c', delay: -1 }] }),
    (e: unknown) => e instanceof SimError && e.code === 'E_NEGATIVE_DELAY',
  );
  assert.throws(
    () => validateScenario({ ...base, init: [{ op: 'schedule', callback: 'c', delay: 1.5 }] }),
    (e: unknown) => e instanceof SimError && e.code === 'E_BAD_PARAM',
  );
  assert.throws(
    () => validateScenario({ ...base, init: [{ op: 'cancel' }] }),
    (e: unknown) => e instanceof SimError && e.code === 'E_BAD_PARAM',
  );
});

test('SQLite 持久化：暂停重启与连续运行一致，微任务不丢失', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-'));
  try {
    const dbPath = join(dir, 't.sqlite');
    const storeA = new Store(dbPath);
    const svcA = new Service(storeA);
    const created = svcA.create({ ...checkpointScenario, name: 'persist' });
    // 只跑 1 步（初始脚本），此时微任务已入队但尚未执行
    svcA.stepOnce(created.id);
    const mid = svcA.queues(created.id);
    assert.ok(mid.queues.micro.length >= 1);
    storeA.close();

    // “重启”：用同一数据库文件新建 Store，状态必须完整恢复
    const storeB = new Store(dbPath);
    const svcB = new Service(storeB);
    svcB.run(created.id, 100);
    const restarted = svcB.state(created.id).state;
    assert.deepEqual(outputs(restarted), checkpointExpected);
    assert.equal(restarted.status, 'finished');

    // 与连续运行的参照场景比较
    const ref = svcB.create({ ...checkpointScenario, name: 'persist-ref' });
    svcB.run(ref.id, 100);
    const cmp = svcB.compare(created.id, ref.id);
    assert.equal(cmp.sameLogs, true);
    assert.equal(cmp.sameFinalQueues, true);
    storeB.close();
  } finally {
    removeDir(dir);
  }
});

test('修改回调定义创建新场景，旧队列不运行新版回调', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-'));
  try {
    const dbPath = join(dir, 't2.sqlite');
    const store = new Store(dbPath);
    const svc = new Service(store);
    const v1 = svc.create({
      name: 'frozen',
      callbacks: [{ name: 'c', ops: [{ op: 'log', text: 'v1' }] }],
      init: [{ op: 'schedule', callback: 'c', delay: 3 }],
    });
    // 同名“新版定义”必须是另一个场景
    const v2 = svc.create({
      name: 'frozen-v2',
      callbacks: [{ name: 'c', ops: [{ op: 'log', text: 'v2' }] }],
      init: [{ op: 'schedule', callback: 'c', delay: 3 }],
    });
    svc.run(v1.id, 100);
    svc.run(v2.id, 100);
    assert.deepEqual(outputs(svc.state(v1.id).state), ['v1']);
    assert.deepEqual(outputs(svc.state(v2.id).state), ['v2']);
    store.close();
  } finally {
    removeDir(dir);
  }
});
