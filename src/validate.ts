import type { Op, ScenarioSpec } from "./types.js";
import { fail } from "./errors.js";

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/** 深度校验场景定义，任何未知操作 / 未知回调 / 负延时 / 非法参数都会抛错 */
export function validateSpec(input: unknown): ScenarioSpec {
  if (typeof input !== "object" || input === null) {
    fail("BAD_SPEC", "场景定义必须是 JSON 对象");
  }
  const raw = input as Record<string, unknown>;
  if (!isNonEmptyString(raw.initial)) {
    fail("MISSING_FIELD", "initial 必须是非空字符串（初始脚本回调名）");
  }
  if (typeof raw.callbacks !== "object" || raw.callbacks === null || Array.isArray(raw.callbacks)) {
    fail("MISSING_FIELD", "callbacks 必须是回调名到操作数组的映射对象");
  }
  const callbacks: Record<string, Op[]> = {};
  const cbMap = raw.callbacks as Record<string, unknown>;
  for (const [name, ops] of Object.entries(cbMap)) {
    if (!isNonEmptyString(name)) fail("BAD_SPEC", "回调名必须是非空字符串");
    if (!Array.isArray(ops)) fail("BAD_SPEC", `回调 ${name} 的操作必须是数组`);
    callbacks[name] = ops.map((o, i) => validateOp(o, `${name}[${i}]`));
  }
  if (!(raw.initial in callbacks)) {
    fail("UNKNOWN_CALLBACK", `初始脚本回调 ${raw.initial} 未在 callbacks 中定义`, {
      callback: raw.initial,
    });
  }
  let microtaskLimit = 1000;
  if (raw.microtaskLimit !== undefined) {
    if (!isNonNegativeInt(raw.microtaskLimit) || raw.microtaskLimit < 1) {
      fail("BAD_PARAM", "microtaskLimit 必须是 >=1 的安全整数");
    }
    microtaskLimit = raw.microtaskLimit;
  }
  const spec: ScenarioSpec = { initial: raw.initial, callbacks, microtaskLimit };
  validateRefs(spec);
  return spec;
}

function validateOp(input: unknown, where: string): Op {
  if (typeof input !== "object" || input === null) {
    fail("BAD_PARAM", `${where} 必须是操作对象`);
  }
  const o = input as Record<string, unknown>;
  const kind = o.op;
  switch (kind) {
    case "log":
      if (typeof o.text !== "string") fail("BAD_PARAM", `${where}.text 必须是字符串`);
      return { op: "log", text: o.text };
    case "queueMicrotask":
      if (!isNonEmptyString(o.callback)) {
        fail("BAD_PARAM", `${where}.callback 必须是非空字符串`);
      }
      return { op: "queueMicrotask", callback: o.callback };
    case "setTimeout": {
      if (!isNonEmptyString(o.callback)) {
        fail("BAD_PARAM", `${where}.callback 必须是非空字符串`);
      }
      if (!isNonNegativeInt(o.delay)) {
        fail("NEGATIVE_DELAY", `${where}.delay 必须是非负整数（不允许真实 sleep / 负延时）`, {
          delay: o.delay,
        });
      }
      let label: string | undefined;
      if (o.label !== undefined) {
        if (!isNonEmptyString(o.label)) fail("BAD_PARAM", `${where}.label 必须是非空字符串`);
        label = o.label;
      }
      return { op: "setTimeout", callback: o.callback, delay: o.delay, label };
    }
    case "clearTimeout": {
      if (typeof o.ref !== "number" && typeof o.ref !== "string") {
        fail("BAD_PARAM", `${where}.ref 必须是任务编号（数字）或预登记标签（非空字符串）`);
      }
      if (typeof o.ref === "string" && !isNonEmptyString(o.ref)) {
        fail("BAD_PARAM", `${where}.ref 标签不能为空字符串`);
      }
      if (typeof o.ref === "number" && !Number.isSafeInteger(o.ref)) {
        fail("BAD_PARAM", `${where}.ref 编号必须是安全整数`);
      }
      return { op: "clearTimeout", ref: o.ref };
    }
    default:
      fail("UNKNOWN_OP", `${where} 使用了未知操作 ${JSON.stringify(kind)}（仅允许 log / queueMicrotask / setTimeout / clearTimeout）`, {
        op: kind,
      });
  }
}

/** 第二遍：所有引用的回调名必须已定义 */
function validateRefs(spec: ScenarioSpec): void {
  for (const [name, ops] of Object.entries(spec.callbacks)) {
    for (const [i, op] of ops.entries()) {
      if (
        (op.op === "queueMicrotask" || op.op === "setTimeout") &&
        !(op.callback in spec.callbacks)
      ) {
        fail("UNKNOWN_CALLBACK", `${name}[${i}] 引用了未定义的回调 ${op.callback}`, {
          callback: op.callback,
        });
      }
    }
  }
}
