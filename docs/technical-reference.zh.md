# Agent Bot 技术参考

[English](technical-reference.md) | 简体中文

本文介绍部署、配置、运行机制、持久化和集成细节。安装与日常命令请先阅读 [README](../README.zh.md)。

## 运行架构

Agent Bot 是基于 Node.js 22+、ESM 和 TypeScript 的应用，主要组件如下：

- Supervisor 负责常驻服务和 worker 自动重启
- Worker 启动 Codex/ACP Runtime、飞书传输、Console 传输、本地控制服务和 SQLite
- 飞书事件和 Console 输入统一进入任务控制器
- 展示层为每个 turn 维护一张进度卡，并单独发送 Markdown 最终回答
- Codex Agent 通过 stdio 连接 Codex App Server，其他 Agent 使用 ACP

主要源码目录：

| 目录                | 职责                                       |
| ------------------- | ------------------------------------------ |
| `src/config/`       | YAML 加载、环境变量展开、校验和路径解析    |
| `src/cli/`          | 初始化、应用创建、配置审计及服务/任务命令  |
| `src/feishu/`       | 飞书长连接事件、API、卡片、图片和上下文键  |
| `src/runtime/`      | 通用 Runtime 抽象                          |
| `src/codex/`        | Codex App Server 协议集成                  |
| `src/acp/`          | ACP 进程与 JSON-RPC 集成                   |
| `src/proxy/`        | 任务、turn、steering、队列、分支和命令执行 |
| `src/presentation/` | Turn 状态归并和出站路由                    |
| `src/state/`        | SQLite schema、迁移、路由和投递状态        |
| `src/supervision/`  | 安全重启和重启通知                         |

## 用户数据与路径解析

默认用户数据根目录为 `~/.agent-bot`，可通过 `AGENT_BOT_HOME` 整体替换。

CLI 还支持显式指定目录的 Profile。不使用 `--profile` 时，命令使用主 Profile 以及原有的环境变量路径规则。`--profile <目录>` 会为当前命令及其启动的 Supervisor、Worker 固定 `AGENT_BOT_HOME` 和 `AGENT_BOT_CONFIG`，配置文件固定为 `<目录>/config.yaml`。它还会先清除继承的飞书凭据环境变量，再加载所选 Profile 的 `.env`，避免从主 Agent Bot 进程树中启动辅助实例时误用主机器人的凭据。`--profile` 不能和 `--config` 同时使用。其他 Profile 必须在每次命令中显式选择；Agent Bot 不维护按名称注册的 Profile。

CLI 通过 Node.js 国际化能力读取系统 Locale。以 `zh` 开头的 Locale 使用中文界面；英文及所有未支持 Locale 使用英文。帮助、状态、进度、交互提示和 CLI 自身错误都遵循此规则；JSON 字段名及枚举值不做本地化。系统生成的重启原因仍使用中文，因为它会显示在中文 Lark 状态卡中；显式传入的 `--reason` 保持原样。`agent-bot server status` 会报告运行中 Worker 的 Lark App ID，JSON 字段名为 `feishuAppId`；服务停止或旧版健康协议尚未提供该字段时，CLI 会回退到当前 Profile 配置的 App ID。

| 默认路径                             | 内容                 |
| ------------------------------------ | -------------------- |
| `~/.agent-bot/config.yaml`           | YAML 主配置          |
| `~/.agent-bot/.env`                  | 飞书凭据             |
| `~/.agent-bot/data/agent-bot.sqlite` | 任务和投递持久化状态 |
| `~/.agent-bot/data/inbound-images/`  | 接收图片缓存         |
| `~/.agent-bot/logs/agent-bot.log`    | 结构化运行日志       |

配置文件优先级：

1. CLI `--profile <目录>` 选择 `<目录>/config.yaml`
2. CLI `--config <路径>`
3. `AGENT_BOT_CONFIG`
4. `<AGENT_BOT_HOME>/config.yaml`，默认为 `~/.agent-bot/config.yaml`

默认 `.env` 始终从 Agent Bot 用户目录加载。加载 `.env` 后，YAML 中的 `${NAME}` 会使用进程环境变量展开。

相对形式的 `storage.sqlitePath` 和 `logging.path` 按配置文件所在目录解析；`defaults.cwd` 按进程启动目录解析。

## 初始化

目标文件不存在时，`agent-bot init` 会复制随包提供的 `config.example.yaml` 和 `.env.example`，创建数据和日志目录，并在平台支持时把 `.env` 权限限制为 POSIX `0600`。

凭据处理规则：

- 进程环境变量优先于 `~/.agent-bot/.env`
- `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET` 必须同时存在
- 一键注册还会把授权用户的 `open_id` 保存为 `FEISHU_USER_OPEN_ID`
- 除非使用 `--reconfigure-feishu`，完整凭据不会被替换
- 缺少凭据或只有一项时会重新创建应用
- 新创建的凭据经过 fsync、原子替换写入 `.env`，并在配置权限前读回校验

初始化期间会持有 `~/.agent-bot/init.lock`，避免使用不同配置路径的并发命令重复创建应用。进程异常退出遗留的锁会在下次运行时恢复，凭据写入中断留下的临时文件也会被清理。

没有完整凭据时，初始化会启动飞书一键创建流程，并以文本和二维码显示验证链接。注册中的设备码不会恢复：如果进程在完整凭据持久化前退出，下次会重新创建应用。凭据持久化后会检查应用当前已发布版本；这一权限审计阶段中断后可以安全继续。

缺失配置分两阶段处理：

1. 请求核心配置并轮询，直到基础能力生效；需要手动配置的全部群消息权限允许用户输入 `Y` 显式跳过
2. 请求其余可选配置。CLI 会先显示二维码，随后显示授权链接，然后立即开始最多 5 分钟的轮询。交互式终端只提供 `Y` 选项，用于跳过可选授权并继续；否则用户直接在浏览器中完成授权，轮询会持续进行

一键配置支持的内容会编码到 launcher 的 `addons` 清单中。核心权限 `im:message.group_msg` 不会放入该清单，因为飞书无法通过一键配置新增它。CLI 会改为显示二维码，以及当前应用已筛选该权限的开发者后台直达链接：

```text
https://open.feishu.cn/app/<appId>/auth?q=im%3Amessage.group_msg&op_from=openapi&token_type=tenant
```

用户需要手动新增权限、发布应用版本，并在需要时完成租户管理员审批。核心轮询会在已发布版本中检测到该权限后继续初始化。交互式终端中输入 `Y` 只会跳过这个手动权限的等待，其他缺失的核心权限和消息事件仍会阻塞。初始化会返回部分配置结果，并提示机器人无法响应未 @ 它的普通群消息。

可选配置轮询失败或超时会返回部分配置结果，不会导致初始化失败。stdin 不是交互式终端时无法输入跳过指令，轮询会持续到配置生效或超时。验证链接和提示写入 stderr，因此 `--json` 的最终 stdout 仍可直接供程序读取。

生成的授权链接不包含 App Secret。

`agent-bot --profile <目录> init --reset` 会完整重置显式指定的 Profile。执行前必须先停止该 Profile 的 Server。命令会把当前 `config.yaml`、`.env`、`data/` 和 `logs/` 移入 `<profile>/.reset-backups/` 下唯一的时间戳目录，从随包模板创建干净的新文件和目录，再继续正常初始化。已有重置备份及其他无关文件会保留。备份中可能含有旧 App Secret 和会话数据，应妥善保护 Profile 目录。远端旧飞书应用不会被删除。`--reset --skip-feishu` 可创建干净的 Console-only Profile，`--reset` 不能与 `--reconfigure-feishu` 同时使用。

飞书初始化成功后，CLI 会先释放初始化锁，再通过与 `agent-bot server start` 相同的就绪检查流程启动后台 Supervisor，并等待最多 45 秒，直到 Worker 连接飞书并进入就绪状态。如果当前 Profile 的服务已经运行，不会创建第二个 Supervisor。`--skip-feishu` 会跳过自动启动；`--json` 会把结果写入 `server.status`，不会混入非 JSON 文本。

## 飞书应用要求

基础消息能力依赖以下核心配置：

- 机器人能力
- 长连接事件接收
- `im.message.receive_v1`
- `im:message.group_msg`，用于接收机器人所在群内的全部用户消息
- 接收私聊消息所需的租户权限
- `im:message:send_as_bot` 或覆盖它的更大权限
- `application:application:self_manage`，供初始化检查已发布版本

可选配置：

| 配置                              | 启用的行为                  |
| --------------------------------- | --------------------------- |
| `im:chat:create`                  | `/newgroup` 和 `/forkgroup` |
| `im:chat:read`                    | 读取群元数据                |
| `im.chat.updated_v1`              | 同步群标题                  |
| `im:message.reactions:write_only` | 消息处理状态表情            |
| 消息读取和资源权限                | 接收与发送图片              |
| 图片和群权限                      | 生成并设置群头像            |
| `card.action.trigger`             | 交互卡片操作                |

可选授权失败时，最终初始化结果会列出受影响功能。重新运行 `agent-bot init` 会再次审计。

## 配置模型

完整示例见 [config.example.yaml](../config.example.yaml)。主要配置段：

```yaml
feishu:
  appId: "${FEISHU_APP_ID}"
  appSecret: "${FEISHU_APP_SECRET}"
  userOpenId: "${FEISHU_USER_OPEN_ID}"
  respondToAllGroupMessages: true

console:
  enabled: true

agents:
  codex:
    kind: "codex"
    title: "Codex"
    command: "codex"
    args: ["app-server", "--enable", "goals", "--listen", "stdio://"]
    env: {}

defaults:
  agent: "codex"
  cwd: "."

storage:
  sqlitePath: "./data/agent-bot.sqlite"

logging:
  level: "info"
  path: "./logs/agent-bot.log"
```

`feishu.respondToAllGroupMessages` 默认为 `true`。设为 `false` 后，未 @ 当前机器人的群消息会被忽略；Worker 启动时会解析机器人的 Open ID，因此 @ 其他成员不会误触发。私聊始终正常处理。无论该运行时配置如何，初始化都会申请接收全部群消息的权限，之后切换配置无需再次授权。

`agent-bot server start` 要求同时配置飞书 `appId` 和 `appSecret`。Worker 启动 SDK 长连接时不读取 SDK 日志或私有连接状态，随后通过发送启动状态卡片检查出站能力。每张启动卡片都会显示从已安装包元数据读取的 Agent Bot 版本。通知通常发往已知私聊和最近活跃的群聊；数据库里尚无已知会话时，改用 `feishu.userOpenId`，按 `open_id` 私聊发送。存在通知目标时，至少一张卡片发送成功后 Server 才报告就绪，单个目标发送失败仍相互隔离。如果既没有已知会话，也没有 `feishu.userOpenId`，启动会跳过出站检查并继续。缺少凭据时仍会启动失败并提示先初始化。`agent-bot console` 是明确的纯本地入口，不需要飞书凭据。

必须至少配置一个 Agent，`defaults.agent` 必须指向已配置的 Agent。

## Agent Runtime

`kind: "codex"` 使用 Codex App Server。Agent Bot 通过 App Server 协议传递项目目录、模型、思考强度、权限模式、文字输入和本地图片。

`kind: "acp"` 或未填写 `kind` 的 Agent 作为 ACP 进程启动。Agent 配置中的 `env` 会加入其环境变量。

所有 Agent 子进程都会收到：

```text
AGENT_BOT=1
```

内置 Skill 使用该环境变量判断自己是否运行在 Agent Bot 中。

## 聊天路由

消息路由决定当前任务：

- 私聊正文按飞书 chat ID 隔离
- 群正文按飞书 chat ID 隔离
- 带 thread ID 的消息按独立话题上下文隔离
- Console 使用独立的本地上下文

命令、卡片回调、进度卡和最终回答都保留在来源路由。

从已映射的用户消息、进度卡或最终回答创建飞书话题时，会从其关联的已完成 Codex turn 创建分支。无法可靠确定已完成来源 turn 时会直接失败，不会选择任意分支点。

`/forkgroup` 会根据话题状态选择来源。话题尚未绑定任务，或者已绑定任务但尚未完成过自己的 turn 时，直接从话题原始锚点 turn fork，不创建中间话题任务。话题任务完成过 turn 后，使用本地持久化的最近完成 turn；更晚的执行中 turn 不会阻塞命令，也不会成为 fork 点。

新群欢迎消息会显示分支任务持久化后的模型、思考强度和权限类型；权限类型显示为自动执行或执行前确认。

## Turn 与消息行为

- 路由没有当前任务时，普通文本会自动创建任务
- Codex turn 活跃时收到的文字通过 steering 追加
- Steering 与 turn 完成发生竞态时，文字变为下一条排队请求
- `/nosteer` 始终创建持久化 FIFO 队列项
- 队列卡操作可以取消单个待执行项
- 完整斜杠命令名优先；否则在解析参数前展开唯一的命令名前缀或已登记的复合命令首字母缩写，匹配多个命令时会拒绝并列出候选命令。当前缩写为 `fg` → `forkgroup`、`ng` → `newgroup`、`ns` → `nosteer`
- 未知斜杠命令会被拒绝，不会作为 Prompt 转发

每个 turn 只有一张进度卡。普通更新最多每两秒一次，关键更新最短间隔 500 毫秒。完成时先把进度卡更新为终态，再单独发送 Markdown 最终回答。

完成持久化消息去重占位后，Agent Bot 会等待 `OnIt` 表情添加成功，再进行聊天信息持久化、图片下载、队列等待、命令执行或 Runtime 调用。Turn 成功、失败或取消时分别替换为 `DONE`、`ERROR` 或 `CrossMark`。表情操作失败会记录日志，但不会阻塞任务。

富文本图片会下载到输入图片缓存，并以 `localImage` 传给 Codex。纯图片消息使用默认 Prompt `请分析这张图片。`。ACP Runtime 不支持图片输入时会明确报错。

## 任务、项目与外部 Codex 工作

`/sessions` 通过 `thread/list` 读取 Codex 任务，可发现同一 `CODEX_HOME` 下由 Codex Desktop、CLI、Agent Bot 或其他 App Server 客户端创建的任务。

每个任务条目都提供 `NewGroup` 和 `ForkGroup` 回调。回调数据保留所选任务 ID 与来源上下文，并使用飞书操作者的 `open_id` 邀请用户进入新群。`NewGroup` 解析所选任务的项目和执行设置；`ForkGroup` 解析该任务最新可用的已完成 turn。

Agent Bot 内部保留本地路由键以关联飞书卡片和投递状态，但对用户展示 Codex 任务 ID。没有明确用户操作时，不会续写、steer、停止或分支其他客户端正在运行的 Codex 工作。

项目规则：

- `/new --dir <路径>` 创建项目任务
- `/new --nodir` 创建 Projectless 任务
- `/new` 继承当前任务的项目或 Projectless 形态
- 首个 Projectless 任务创建在 `~/Documents/Codex/<日期>/<任务名>`
- 已有任务的工作目录不可变

分支使用最新可用的已完成 turn，不会中断来源任务的活动 turn。

## 持久化与恢复

SQLite 保存：

- 每条路由的当前任务和上一个任务
- 本地任务标识与 Codex task/thread 标识
- 模型、思考强度和权限模式
- 排队 Prompt
- 进度快照和消息绑定
- 最终消息投递记录

启动时，Agent Bot 通过 `thread/read` 将持久化的活动工作与 Codex 状态校准。Turn 标识变化、收到终态通知或控制请求失败时也会重新校准。

最终消息投递账本用于避免重复发送成功回答。App Server 请求使用有限超时，避免阻塞的请求永久占用消息路由。

## Supervisor 与重启

`agent-bot server start` 启动后台 supervisor。Worker 意外退出后会自动拉起；连续崩溃时使用 1 到 30 秒的指数退避。

Supervisor 的崩溃诊断文件按当前 Profile 隔离：

- `logs/supervisor.log` 持久记录 Worker PID、退出码、运行时长、重启延迟和诊断文件路径
- `logs/worker.stderr.log` 保存后台进程原本会丢失的 Node/V8 fatal 输出；两类诊断日志达到 10 MiB 时轮转，保留三个备份
- `data/last-crash.json` 指向最近一次 Worker 异常退出，带时间戳的 `data/crash-reports/crash-*.json` 保留历史记录
- Node 能生成报告时，写入 `data/crash-reports/report.*.json`

Supervisor、Worker、替换 Supervisor 和 Console Worker 默认启用 Node fatal error 与未捕获异常报告。Node 版本支持时还会排除环境变量和网络接口，避免凭据进入报告。主动重启退出码 `75` 和停止退出码 `76` 不会创建崩溃清单。

安全重启会等待：

1. 活动任务完成
2. 最终回答完成投递
3. 连续 15 秒没有新消息

新消息会重置静默计时。`--immediate` 和 `--force` 跳过这些检查。退出码 `75` 表示主动 worker 重启。

首次安全重启状态卡会延迟 3 秒发送，让任务最终回答尽可能先到达；延迟期间的状态变化会合并到首张卡片。该延迟不阻塞调度器轮询，真正关闭前会立即 flush 尚未发送的卡片。

等待中的安全重启状态卡底部带有 `Cancel` 操作。回调会携带调度器单调递增的计划 ID，因此旧卡片不会取消较新的重启。取消成功后，所有已发送的状态卡都会原地更新并移除按钮；调度器进入不可逆的正在重启阶段后也不再显示该按钮。

本地控制服务负责修改任务和请求服务重启；只读任务查询直接访问 SQLite。

## 权限模式

- `auto`：Codex 使用 `approvalPolicy=never` 和 `danger-full-access`
- `confirm`：通过卡片提供单次允许、会话允许、拒绝和取消任务操作

创建或分支任务时，会按适用场景继承模型、思考强度、权限模式和项目形态。

## 受管系统 Skill

随包提供的 Agent Bot Skill 可安装到共享 Agent Skill 目录：

```powershell
agent-bot skills install
agent-bot skills status
agent-bot skills uninstall
```

默认目标为 `~/.agents/skills`，可通过 `AGENT_BOT_SKILLS_DIR` 或 `--target` 修改。安装使用受管复制；卸载不会删除无关的同名目录。

## npm 包与发布

公开包名为 `@keyou007/agent-bot`，安装后的可执行命令仍为 `agent-bot`。包使用 `files` 白名单，只发布运行代码、模板、受管 Skill、源码和用户文档，不包含测试及内部设计计划。

CLI 随包发布 `npm-shrinkwrap.json`，以固定传递运行依赖；直接运行依赖和开发依赖也使用精确版本。

包生命周期：

- `prepublishOnly` 执行类型检查和完整测试
- `prepack` 清理并构建 `dist/`，然后检查 tarball 清单
- `npm run package:smoke` 打包项目、在临时目录安装 tarball、运行 CLI，并执行仅 Console 的初始化

在干净工作树中准备下一个 patch 版本：

```powershell
npm run release
git add package.json npm-shrinkwrap.json CHANGELOG.md
git commit -m "release: v0.1.1"
git push origin master
```

`npm run release` 默认递增 patch 版本，并把当前 `Unreleased` 条目归档到带日期的版本小节。可以使用 `npm run release -- minor`、`npm run release -- major` 或 `npm run release -- 0.2.0` 指定其他稳定版本。工作树不干净或 `Unreleased` 没有内容时，命令会拒绝修改文件。

推送完成后无需再执行本地发布命令。本仓库自身对 `master` 的 push 通过 CI 后，`publish.yml` 会查询 npm 中的包版本：版本已存在时正常跳过；发现尚未发布的稳定版本时，要求 `CHANGELOG.md` 存在匹配小节，并在发布前再次执行完整验证和包安装 smoke test。npm 接受新包后，workflow 自动创建对应的 `v<包版本>` GitHub Release。

需要补跑时，可以在 **GitHub Actions → Publish to npm → Run workflow** 中选择 `master` 手动执行。Pull Request、外部 fork、CI 失败以及其他分支的 push 都不能进入发布 job。

npm Trusted Publisher 配置为：

- GitHub 所有者：`keyou`
- 仓库：`agent-bot`
- Workflow：`publish.yml`
- 允许操作：`npm publish`

发布 workflow 使用 GitHub OIDC，不保存长期 npm token，并从 GitHub 托管的 Node.js 24 runner 发布。

## 开发与源码安装

```powershell
npm ci
npm run dev
npm run typecheck
npm test
npm run build
npm link
```

`npm link` 会把当前 checkout 的 `agent-bot` 命令注册到全局。未执行时，可通过 `npm run cli --` 调用构建后的 CLI。`npm run dev` 运行单个前台 worker，`npm start` 在当前终端运行 supervisor。
