import type { ScenarioDef } from './types.js';

/**
 * 教学演示场景。所有“预期答案”都是手写的确定顺序，
 * 不依赖本机真实事件循环。
 */

/**
 * 场景一：核心检查点。
 * 初始脚本先登记一个零延时任务，再排一个微任务；
 * 该微任务又排另一个微任务。
 * 预期输出顺序：
 *   init-log -> microA -> microB -> timerZero
 */
export const checkpointScenario: ScenarioDef = {
  name: 'demo-checkpoint',
  description: '初始脚本登记零延时任务后再排微任务，微任务继续排微任务',
  callbacks: [
    {
      name: 'microA',
      ops: [
        { op: 'log', text: 'microA' },
        { op: 'micro', callback: 'microB' },
      ],
    },
    { name: 'microB', ops: [{ op: 'log', text: 'microB' }] },
    { name: 'timerCb', ops: [{ op: 'log', text: 'timerZero' }] },
  ],
  init: [
    { op: 'log', text: 'init-log' },
    { op: 'schedule', callback: 'timerCb', delay: 0, label: 'zero' },
    { op: 'micro', callback: 'microA' },
  ],
};

export const checkpointExpected = ['init-log', 'microA', 'microB', 'timerZero'];

/**
 * 场景二：同刻稳定排序与取消。
 * 同一到期时间登记三个任务（seq 决定顺序），用标签取消第二个；
 * 再演示取消不存在 / 已执行 / 已取消任务的公开结果。
 */
export const cancelScenario: ScenarioDef = {
  name: 'demo-cancel',
  description: '同刻定时任务稳定排序，按标签取消其中一个并覆盖各取消结果',
  callbacks: [
    { name: 't1', ops: [{ op: 'log', text: 't1' }, { op: 'cancel', taskId: 999 }] },
    {
      name: 't2',
      ops: [{ op: 'log', text: 't2-should-not-run' }],
    },
    {
      name: 't3',
      ops: [
        { op: 'log', text: 't3' },
        { op: 'cancel', label: 'middle' }, // 已取消 -> already_cancelled
      ],
    },
  ],
  init: [
    { op: 'schedule', callback: 't1', delay: 5 },
    { op: 'schedule', callback: 't2', delay: 5, label: 'middle' },
    { op: 'schedule', callback: 't3', delay: 5 },
    { op: 'cancel', label: 'middle' }, // 成功取消，只影响该实例
    { op: 'cancel', label: 'never-registered' }, // not_found
  ],
};

export const cancelExpected = ['t1', 't3'];

/**
 * 场景三：回调内部新增同刻任务。
 * 普通任务运行时再登记零延时任务，它必须等当前任务及其微任务排空后才运行，
 * 不能在当前回调中插队。
 */
export const sameTickScenario: ScenarioDef = {
  name: 'demo-same-tick',
  description: '回调内部新增零延时任务与微任务，检验不插队',
  callbacks: [
    {
      name: 'worker',
      ops: [
        { op: 'log', text: 'worker-start' },
        { op: 'schedule', callback: 'later', delay: 0 },
        { op: 'micro', callback: 'pulse' },
      ],
    },
    { name: 'pulse', ops: [{ op: 'log', text: 'pulse' }] },
    { name: 'later', ops: [{ op: 'log', text: 'later' }] },
  ],
  init: [{ op: 'schedule', callback: 'worker', delay: 2 }],
};

export const sameTickExpected = ['worker-start', 'pulse', 'later'];

/**
 * 场景四：微任务饥饿。微任务不断把自己再次入队，
 * 定时任务永远轮不到；达到步数上限标记 starved，保留微任务队列，
 * 绝不清空微任务强行执行定时任务。
 */
export const starvationScenario: ScenarioDef = {
  name: 'demo-starvation',
  description: '微任务无限递归入队导致饥饿，达上限标记 starved 并保留状态',
  callbacks: [
    {
      name: 'loop',
      ops: [
        { op: 'log', text: 'loop' },
        { op: 'micro', callback: 'loop' },
      ],
    },
    { name: 'starvedTimer', ops: [{ op: 'log', text: 'timer-never-runs' }] },
  ],
  init: [
    { op: 'micro', callback: 'loop' },
    { op: 'schedule', callback: 'starvedTimer', delay: 0 },
  ],
  maxSteps: 10,
};

export const allDemos: Array<{ def: ScenarioDef; expected: string[] }> = [
  { def: checkpointScenario, expected: checkpointExpected },
  { def: cancelScenario, expected: cancelExpected },
  { def: sameTickScenario, expected: sameTickExpected },
];
