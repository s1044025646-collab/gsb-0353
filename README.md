# 宏任务 / 微任务检查点回放模拟器

一个教学用的**单线程事件循环模拟器**后端（只做 API 与 CLI，无界面、不执行任意 JavaScript）。
使用 TypeScript + Node.js + 内置 `node:sqlite` 持久化，可在 Windows 本地直接运行，
不依赖 Docker、WSL、付费服务或任何在线 API。

## 它模拟什么

场景用 JSON 声明：一组**命名回调**和一个**初始脚本**。回调只能包含四类操作：

| 操作 | 含义 |
| --- | --- |
| `{"op":"log","text":"..."}` | 记录一段文字输出 |
| `{"op":"micro","callback":"X"}` | 把回调 X 加入**微任务队列** |
| `{"op":"schedule","callback":"X","delay":n,"label"?:...}` | 登记延时为 n（非负整数）的**普通（定时）任务**，返回稳定任务编号 |
| `{"op":"cancel","taskId"?:k,"label"?:...}` | 按编号或标签取消尚未执行的指定任务 |

模拟规则（也是本项目要教的核心）：

1. **初始脚本是第一个普通任务**。
2. 每个普通任务执行完后，**FIFO 排空整个微任务队列**——包括执行微任务时新加入的微任务（排在队尾继续执行）。
3. 微任务清空后才选下一个普通任务。**零延时任务也不能在当前回调中插队**，也不与微任务共用队列。
4. 延时任务按 **(到期时间, 登记顺序)** 稳定排序；没有可立即执行的任务时，**模拟时钟直接跳到下一到期时间**（不 `sleep`、不启动真实计时器）。
5. 每次 `schedule` 返回**稳定任务编号**；`cancel` 只影响这一个任务实例。回调可再次安排同名回调——**回调定义不等于队列中的一次执行**。
6. 取消结果公开为：`cancelled` / `not_found` / `already_executed` / `already_cancelled`。
7. 标签（label）一经登记**全局唯一、不可重用**（即使旧任务已执行或取消）；引用未登记标签返回 `not_found`，绝不会误取消别的对象。

## 明确的边界与假设

- 不模拟浏览器渲染、真实网络、完整 Promise、Node 各阶段（I/O、setImmediate、nextTick 等）或多线程。
- 回调耗时为 0；模拟时间是非负整数；延时是相对当前时间的非负整数。
- 每个场景有步数上限 `maxSteps`（默认 10000）。微任务无限递归入队会在到达上限时标记为
  `starved`，**保留剩余微任务与队列状态，绝不清空微任务去强行执行定时任务**。
- 场景创建时**冻结回调定义**；修改定义只能创建新场景，旧场景的队列永远跑旧版回调。
- 完整状态（模拟时间、任务编号、两类队列、标签表、初始任务是否完成、逐步日志）以单条 JSON
  存在 SQLite；单步推进与该步日志在**一个数据库事务中原子提交**。暂停/重启后的输出顺序与连续运行完全一致。

## 环境要求

- Node.js **22.5+**（内置 `node:sqlite`；本机开发版本为 Node 25）。
- Windows / macOS / Linux 均可，下面命令以 PowerShell 为例。

## 安装、构建、测试

```powershell
npm install
npm run build     # tsc 编译到 dist/
npm test          # 运行 node:test 测试（引擎 + HTTP API）
```

开发期也可不编译直接用 `tsx`：

```powershell
node --import tsx src/cli.ts demo
```

## 快速演示

```powershell
npm run demo
```

内置演示会用**手写的预期顺序**核对，而不依赖本机真实事件循环：

1. 检查点：初始脚本登记零延时任务并排两级微任务 → `init-log, microA, microB, timerZero`。
2. 同刻定时任务稳定排序、按标签取消其中一个，并覆盖四种取消结果。
3. 回调内部新增同刻（零延时）任务与微任务，验证定时任务不插队。
4. 微任务无限递归导致饥饿，到达上限标记 `starved`，定时任务始终未执行、微任务保留。
5. 逐步运行 vs 分批预算 vs 重启恢复，比较日志与最终队列完全一致。

## CLI 用法

数据文件默认在项目内 `data/eventloop.sqlite`，可用环境变量 `SIM_DB_PATH` 覆盖。

```powershell
node dist/cli.js help
node dist/cli.js validate scenarios/checkpoint.json   # 只校验定义
node dist/cli.js create scenarios/checkpoint.json     # 创建并冻结场景，打印场景 id
node dist/cli.js list                                 # 列出场景
node dist/cli.js step 1                               # 单步推进一个执行单元
node dist/cli.js run 1 --budget 50                    # 按预算推进
node dist/cli.js queues 1                             # 查看微任务/延时任务两类队列
node dist/cli.js logs 1                               # 查看逐步日志（类型、排队来源、输出）
node dist/cli.js state 1                              # 完整持久化状态 JSON
node dist/cli.js export 1 --out data/scene1.json      # 导出冻结定义 + 当前状态
node dist/cli.js compare 1 2                          # 比较两个场景的日志与最终队列
```

每步展示：步骤号、模拟时间、单元类型（初始脚本/微任务/延时任务）、排队来源（任务编号、回调名、
到期时间、标签）、取消结果、回调内部操作位置，以及队列前后快照（可通过 `state`/`logs` 查看）。

## HTTP API

启动服务（`--port` 可配置；**不传或传 0 时自动选择空闲端口**，启动后会打印实际端口）：

```powershell
npm start                       # 自动空闲端口
node dist/cli.js serve --port 8080
```

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/validate` | 只校验回调定义 |
| POST | `/scenarios` | 创建场景（201，返回 id 与初始状态） |
| GET | `/scenarios` | 列出场景 |
| GET | `/scenarios/:id` | 读取冻结定义 |
| POST | `/scenarios/:id/step` | 单步推进 |
| POST | `/scenarios/:id/run` | body `{"budget":100}` 按预算推进 |
| GET | `/scenarios/:id/queues` | 两类队列 + 当前时间/状态 |
| GET | `/scenarios/:id/logs?from=N` | 逐步日志 |
| GET | `/scenarios/:id/state` | 完整状态 |
| GET | `/scenarios/:id/export` | 导出定义 + 状态 |
| GET | `/scenarios/:a/compare/:b` | 比较两场景 |

成功响应包一层 `{"data": ...}`；错误为 `{"error":{"code","message","details"}}`。

示例（PowerShell）：

```powershell
$body = Get-Content scenarios/checkpoint.json -Raw
$r = Invoke-RestMethod -Uri http://127.0.0.1:8080/scenarios -Method Post -ContentType 'application/json' -Body $body
Invoke-RestMethod -Uri "http://127.0.0.1:8080/scenarios/$($r.data.id)/run" -Method Post -ContentType 'application/json' -Body '{"budget":100}'
```

## 错误码

| code | 触发条件 |
| --- | --- |
| `E_UNKNOWN_OP` | 操作不是 log/micro/schedule/cancel |
| `E_UNKNOWN_CALLBACK` | micro/schedule 引用了未定义的回调 |
| `E_NEGATIVE_DELAY` | 延时为负数 |
| `E_BAD_PARAM` | 参数类型/取值非法（如 delay 非整数、cancel 同时或未给目标） |
| `E_VALIDATION` | 场景结构非法（无名字、callbacks 为空、回调重名等） |
| `E_LABEL_REUSE` | 标签被重复登记 |
| `E_STATE_CONFLICT` | 场景已结束/达到步数上限、场景名冲突等 |
| `E_NOT_FOUND` | 场景/资源不存在（HTTP 404） |
| `E_BAD_REQUEST` | 请求体不是合法 JSON 等 |

取消类“失败”（未登记、已执行、已取消）**不是异常**，而是每步日志里的公开结果；
真正非法的操作（如标签重用、负延时）会抛错且**当步整体回滚**，编号、队列、日志均不改变。

## 项目结构

```
src/
  types.ts       数据类型与错误码
  validation.ts  场景/操作的静态校验
  engine.ts      纯函数模拟引擎（检查点、时钟跳转、取消、回滚、比较）
  store.ts       SQLite 持久化（冻结定义 + 原子状态提交）
  service.ts     编排：校验 -> 引擎 -> 原子落盘
  server.ts      HTTP API + 空闲端口选择
  demo.ts        内置教学场景与手写预期
  cli.ts         命令行入口
scenarios/checkpoint.json   示例场景
tests/           node:test 测试
```
