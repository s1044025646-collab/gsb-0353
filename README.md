# 宏任务 / 微任务检查点回放后端

教学用**单线程事件循环模拟器**，用 JSON 定义命名回调和初始脚本，严格演示：

- 每个**普通（宏）任务**执行完后，按 FIFO **排空微任务队列**（包括执行微任务时新加入的微任务），然后才选择下一个宏任务；
- **零延时定时任务也不能在当前回调中插队**，它与微任务是两条不同队列；
- 定时任务按**到期时间、再按登记顺序**稳定排序；无可执行任务时，模拟时钟直接**跳到下一到期时间**（不使用真实 sleep，也不启动真实计时器决定结果）；
- 每次安排定时任务返回**稳定任务编号**，可取消；取消按**任务实例身份**生效，不连带同名回调的其他实例；
- 回调可再次安排同名回调运行，队列中每次登记都是独立实例。

只做后端：TypeScript + Node.js + 内置 SQLite（`node:sqlite`，免本地编译）。不模拟浏览器渲染、真实网络、完整 Promise、Node 各阶段或多线程。

## 环境要求

- Windows（已在 Node.js v25.5.0 上验证），Node.js `>= 22.5.0`（需要内置 `node:sqlite`）。
- 无需 Docker、WSL、付费服务或外部在线 API。运行时会出现 `ExperimentalWarning: SQLite is an experimental feature`，可忽略，或用 `node --no-warnings` 抑制。

## 安装、构建、测试

```powershell
npm install
npm run build
npm test
```

测试全部通过后再启动。13 个手写断言覆盖：检查点顺序、同刻稳定排序、定向取消、回调内新增同刻任务、微任务饥饿与预算恢复、错误操作整步回滚、逐步 vs 分批 vs 重启恢复一致性、任务实例不重复执行、场景冻结。

## 快速演示

```powershell
npm run demo
```

演示会在项目内 `data/checkpoint.sqlite` 写入 4 个内置场景并逐步打印中文说明（`demo` 可重复运行，会先重置这 4 个内置场景）：

1. `demo_checkpoint`：初始脚本先登记零延时任务再排微任务，微任务链（含新入队）全部先于定时任务；
2. `demo_cancel`：同刻多任务稳定排序，按标签取消其中一个，重复取消与取消未登记编号的公开结果；
3. `demo_sametime`：回调内部新增同刻任务，排在当前宏任务之后，其微任务仍先排空；
4. `demo_starvation`：微任务递归入队触发饥饿（`microtaskLimit=5`），状态保留、时间不前进、定时任务不插队，再给预算继续恢复。

## CLI

```powershell
# 校验回调定义（不写库）
node dist/cli.js validate examples/checkpoint.spec.json

# 创建场景（同名场景拒绝覆盖：回调定义冻结；修改请用新名称）
node dist/cli.js create mycase examples/checkpoint.spec.json

# 单步推进；给数字即为按预算一次推进多步
node dist/cli.js step mycase 1
node dist/cli.js step mycase 10 --max-callbacks 100000

# 查看两类队列、全部任务实例（含 executed/cancelled）、回调内部位置
node dist/cli.js queues mycase

# 查询线性日志与每步详情
node dist/cli.js log mycase

# 比较两个场景（线性日志 / 逐步记录 / 最终队列与时间是否完全一致）
node dist/cli.js compare mycase other

# 导出（stdout 或文件）
node dist/cli.js export mycase out.json

# HTTP API（默认端口 0 = 操作系统选择空闲端口；可显式指定）
node dist/cli.js serve
node dist/cli.js serve --port 8080 --host 127.0.0.1 --db data/checkpoint.sqlite

node dist/cli.js list
```

也可 `npm start`、`npm run cli -- <参数>`。

## HTTP API

仅监听 `127.0.0.1`，JSON 收发，统一响应包络 `{"ok":true,"data":...}` / `{"ok":false,"error":{code,message,details}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/validate` | 仅校验 spec |
| POST | `/scenarios` | body: `{"name":"...","spec":{...}}`，创建冻结场景 |
| GET | `/scenarios` | 场景列表 |
| POST | `/scenarios/:name/run` | body: `{"budget":1,"maxCallbacks":100000}`，单步/按预算推进 |
| GET | `/scenarios/:name/queues` | 两类队列 + 全部任务实例 + 回调内部位置 |
| GET | `/scenarios/:name/log` | 线性日志与逐步记录 |
| GET | `/scenarios/:name/export` | 导出 spec/state/steps/log |
| GET | `/compare/:a/:b` | 比较两场景 |

PowerShell 下调用示例（中文建议用文件传 body，避免引号转义）：

```powershell
$json = '{"name":"api_demo","spec":' + (Get-Content -Raw examples/checkpoint.spec.json) + '}'
Set-Content -Encoding UTF8 data/req.json $json
curl.exe -s -X POST http://127.0.0.1:<端口>/scenarios -H "Content-Type: application/json" --data-binary "@data/req.json"
Set-Content -Encoding UTF8 data/run.json '{"budget":10}'
curl.exe -s -X POST http://127.0.0.1:<端口>/scenarios/api_demo/run -H "Content-Type: application/json" --data-binary "@data/run.json"
```

## 场景 JSON 规范

```jsonc
{
  "initial": "start",          // 必填：初始脚本回调名，作为第一个宏任务
  "microtaskLimit": 1000,      // 可选，默认 1000：单次宏任务后的微任务排空上限
  "callbacks": {               // 命名回调 = 有序操作数组，无表达式、不能执行任意 JS
    "start": [
      { "op": "log", "text": "任意文字" },
      { "op": "queueMicrotask", "callback": "microA" },
      { "op": "setTimeout", "callback": "onTimer", "delay": 0, "label": "可选唯一标签" },
      { "op": "clearTimeout", "ref": 1 },          // ref 为任务编号数字
      { "op": "clearTimeout", "ref": "first-timer" } // 或预先登记的标签字符串
    ]
  }
}
```

### 操作语义

- `log`：向本步记录追加文字，最终按全局执行顺序形成线性日志。
- `queueMicrotask`：向微任务队列尾部登记一个实例，**当前回调结束前不会执行**。
- `setTimeout`：`delay` 必须是**非负整数**；返回从 1 起单调递增的稳定编号 `id`；到期时间 = 当前模拟时间 + delay。
- `clearTimeout`：按编号或标签取消，返回四种结果之一：
  - `cancelled`：成功取消该实例；
  - `not_found`：编号/标签从未登记（不会默默取消别的对象）；
  - `already_executed`：目标已执行（任务实例不重复执行）；
  - `already_cancelled`：目标已被取消。

### 标签规则（明确约定）

- 标签是 `setTimeout` 的**可选**别名；同一时刻一个标签只能指向一个**存活（scheduled）**实例。
- 标签在对应任务**执行后或取消后**才可被新任务重用；对仍存活标签再次登记报 `LABEL_CONFLICT`，并**整步回滚**。
- `clearTimeout` 引用未登记标签返回 `not_found`，不产生任何副作用。

### 微任务饥饿与预算

- 每个宏任务完成后排空微任务；本轮执行数量达到 `microtaskLimit` 且队列仍非空时，标记 `status="starved"`，**保留剩余微任务与全部状态**，时间不前进、不选择定时任务。
- 下一次 `run`（给预算）执行一个**饥饿恢复排空步**（`kind="starved-drain"`）继续 FIFO 排空；排空后若队列清空则恢复 `ready`，再继续宏任务。
- 无限递归微任务会反复进入饥饿，`--max-callbacks`（默认 100000）作为本次运行回调执行总硬上限兜底，不会死循环；任何时刻都不会跳过剩余微任务强行执行定时任务。

### 原子性与持久化（SQLite）

表：`scenarios`（冻结 spec JSON）、`sims`（当前 state + 线性日志）、`steps`（每步快照）。

- 一批 `run` 的**状态与日志在单个 SQLite 事务中原子提交**：任一回调操作非法（未知操作/未知回调/负延时/标签冲突等）时，该步在内存中整体回滚，数据库保持上一步状态——时间、队列、任务编号计数器、输出均不变。
- 冻结保存的内容：回调定义、初始任务、当前模拟时间、回调内部位置（提交点始终停在任务边界）、下一任务编号、两类队列与全部任务实例（含 executed/cancelled）。
- **暂停重启后继续与连续运行结果完全一致**：微任务队列与饥饿状态都持久化，不只存输出。
- 修改回调定义必须创建**新场景名**；旧场景的队列继续运行其冻结版本，不会突然跑新代码。同名创建报 `SCENARIO_FROZEN`。

## 错误码

| code | 触发条件 |
| --- | --- |
| `UNKNOWN_OP` | 操作不在四类白名单内（禁止任意 JS） |
| `UNKNOWN_CALLBACK` | 引用了未定义的回调名 |
| `NEGATIVE_DELAY` | delay 为负数或非整数 |
| `BAD_PARAM` | 参数类型/取值非法（如 text 非字符串、ref 非法） |
| `LABEL_CONFLICT` | 存活标签被重复登记 |
| `BAD_SPEC` / `MISSING_FIELD` | 场景结构非法或缺 initial/callbacks |
| `BAD_SCENARIO_NAME` | 场景名不匹配 `[A-Za-z0-9_-.中文]{1,64}` |
| `SCENARIO_NOT_FOUND` / `SCENARIO_FROZEN` | 场景不存在 / 同名重复创建 |
| `ALREADY_FINISHED` | 对已完成场景继续 run |
| `BUDGET_EXHAUSTED` | 预算参数非法或无可执行任务 |

HTTP 层所有应用错误返回 400 与上述 code；未知路由 404；服务器内部错误 500。

## 目录结构

```
src/
  types.ts    场景/状态/逐步记录类型
  errors.ts   错误码
  validate.ts 场景深度校验
  engine.ts   事件循环模拟引擎（检查点、排序、跳钟、饥饿、回滚）
  store.ts    SQLite 存储与原子提交
  service.ts  用例编排（run/queues/log/compare/export）
  api.ts      HTTP API（默认空闲端口，仅 127.0.0.1）
  cli.ts      中文 CLI 与内置演示
  demo.ts     4 个教学场景
  test/       node:test 手写预期断言
examples/    示例 spec
data/        运行后生成：checkpoint.sqlite（WAL 模式）
```

## 合理假设（未明确之处）

- 回调零耗时；模拟时间只被“跳到到期时间”推进，`log/queueMicrotask/clearTimeout` 不推进时间。
- 任务编号从 1 开始单调递增，取消或回滚不重用编号；同刻任务按全局登记序号 `seq` 排序。
- 已执行/已取消实例保留在 `allTimers` 中以便审计，但不再出现在存活定时队列。
- 回调内部位置在提交点始终是任务边界（下一个待运行宏任务 opIndex=0，或饥饿时队首微任务 opIndex=0）；单步原子性保证不会半执行落盘。
- 比较接口按完整 JSON 结构判定一致；导出为单个 JSON 文档，可自行 diff。
