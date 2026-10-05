import type { Operation, ScenarioDef } from './types.js';
import { SimError } from './types.js';

const KNOWN_OPS = new Set(['log', 'micro', 'schedule', 'cancel']);

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/**
 * 静态校验场景定义。任何非法定义都会抛出带错误码的 SimError，
 * 非法场景不会被创建，也就不存在“带病入队”。
 */
export function validateScenario(def: unknown): ScenarioDef {
  if (typeof def !== 'object' || def === null) {
    throw new SimError('E_VALIDATION', '场景定义必须是对象');
  }
  const d = def as Partial<ScenarioDef>;
  if (typeof d.name !== 'string' || d.name.trim() === '') {
    throw new SimError('E_VALIDATION', 'name 必须是非空字符串');
  }
  if (!Array.isArray(d.callbacks) || d.callbacks.length === 0) {
    throw new SimError('E_VALIDATION', 'callbacks 必须是非空数组');
  }
  if (!Array.isArray(d.init)) {
    throw new SimError('E_VALIDATION', 'init 必须是数组');
  }
  if (d.maxSteps !== undefined && (!isInt(d.maxSteps) || d.maxSteps <= 0)) {
    throw new SimError('E_BAD_PARAM', 'maxSteps 必须是正整数');
  }

  const names = new Set<string>();
  for (const cb of d.callbacks) {
    if (typeof cb !== 'object' || cb === null) {
      throw new SimError('E_VALIDATION', '回调定义必须是对象');
    }
    if (typeof cb.name !== 'string' || cb.name.trim() === '') {
      throw new SimError('E_VALIDATION', '回调 name 必须是非空字符串');
    }
    if (names.has(cb.name)) {
      throw new SimError('E_VALIDATION', `回调名重复: ${cb.name}`);
    }
    names.add(cb.name);
    if (!Array.isArray(cb.ops)) {
      throw new SimError('E_VALIDATION', `回调 ${cb.name} 的 ops 必须是数组`);
    }
  }
  // 第二遍才校验操作，允许回调之间前向相互引用（如 microA 引用后定义的 microB）
  for (const cb of d.callbacks) {
    cb.ops.forEach((op, i) => validateOp(op, names, `${cb.name}.ops[${i}]`));
  }
  d.init.forEach((op, i) => validateOp(op, names, `init[${i}]`));
  return d as ScenarioDef;
}

function validateOp(op: unknown, callbackNames: Set<string>, path: string): Operation {
  if (typeof op !== 'object' || op === null) {
    throw new SimError('E_BAD_PARAM', `${path} 必须是对象`);
  }
  const o = op as Record<string, unknown>;
  if (typeof o.op !== 'string' || !KNOWN_OPS.has(o.op)) {
    throw new SimError('E_UNKNOWN_OP', `${path} 的 op 非法: ${String(o.op)}`, {
      allowed: [...KNOWN_OPS],
    });
  }
  switch (o.op) {
    case 'log':
      if (typeof o.text !== 'string') {
        throw new SimError('E_BAD_PARAM', `${path}.text 必须是字符串`);
      }
      break;
    case 'micro':
      if (typeof o.callback !== 'string') {
        throw new SimError('E_BAD_PARAM', `${path}.callback 必须是字符串`);
      }
      if (!callbackNames.has(o.callback)) {
        throw new SimError('E_UNKNOWN_CALLBACK', `${path} 引用了未定义回调: ${o.callback}`);
      }
      break;
    case 'schedule':
      if (typeof o.callback !== 'string') {
        throw new SimError('E_BAD_PARAM', `${path}.callback 必须是字符串`);
      }
      if (!callbackNames.has(o.callback)) {
        throw new SimError('E_UNKNOWN_CALLBACK', `${path} 引用了未定义回调: ${o.callback}`);
      }
      if (!isInt(o.delay)) {
        throw new SimError('E_BAD_PARAM', `${path}.delay 必须是整数`);
      }
      if (o.delay < 0) {
        throw new SimError('E_NEGATIVE_DELAY', `${path}.delay 不能为负: ${o.delay}`);
      }
      if (o.label !== undefined && (typeof o.label !== 'string' || o.label.trim() === '')) {
        throw new SimError('E_BAD_PARAM', `${path}.label 必须是非空字符串`);
      }
      break;
    case 'cancel':
      if (o.label === undefined && o.taskId === undefined) {
        throw new SimError('E_BAD_PARAM', `${path} 必须提供 label 或 taskId 之一`);
      }
      if (o.label !== undefined && o.taskId !== undefined) {
        throw new SimError('E_BAD_PARAM', `${path} 不能同时提供 label 与 taskId`);
      }
      if (o.label !== undefined && (typeof o.label !== 'string' || o.label.trim() === '')) {
        throw new SimError('E_BAD_PARAM', `${path}.label 必须是非空字符串`);
      }
      if (o.taskId !== undefined && (!isInt(o.taskId) || o.taskId <= 0)) {
        throw new SimError('E_BAD_PARAM', `${path}.taskId 必须是正整数`);
      }
      break;
  }
  return o as unknown as Operation;
}
