# 目标与实施计划：飞书机器人控制本地 ACP Agent

## 目标

实现一个运行在本地的 Feishu ACP Gateway，使用户可以通过飞书机器人控制本机任意支持 Agent Client Protocol（ACP）的 agent 客户端/agent 进程。Gateway 负责连接飞书机器人与本地 ACP agent：飞书侧提供消息入口、交互卡片、会话管理和授权控制；ACP 侧保持协议透明，不因为安全策略额外限制 agent 能力。

## 核心原则

- 飞书机器人侧是唯一的安全控制面，负责用户白名单、会话权限、确认按钮、审计和操作入口控制。
- ACP/agent 侧不做额外能力裁剪，不拦截、不改写、不弱化 agent 按协议请求的文件、终端、MCP 或权限相关能力。
- Gateway 作为 ACP Client，按照 ACP 协议完整实现与 agent 的 JSON-RPC 交互。
- 支持任意 ACP stdio agent，通过配置文件声明启动命令、参数、环境变量和展示名称。
- 优先保证端到端可用性，再逐步增强飞书交互体验、多 agent 管理和稳定性。

## 范围

### 包含

- 飞书企业自建应用机器人接入。
- 飞书长连接事件接收。
- 文本消息命令解析。
- 交互卡片展示 agent 运行状态。
- 本地 ACP agent 子进程启动和生命周期管理。
- ACP `initialize`、`authenticate`、`session/new`、`session/prompt`、`session/cancel` 基础流程。
- ACP `session/update` 到飞书消息/卡片的渲染。
- ACP `session/request_permission` 到飞书按钮交互的映射。
- 飞书 `/xxx` 控制命令，包括创建新会话、选择新会话工作目录、切换 agent、切换会话、取消任务等。
- 多 agent 配置、多会话状态保存和审计日志。

### 不包含

- 在 agent 侧实现额外沙箱或能力限制。
- 对 agent 发起的文件读写、终端命令、MCP 调用做协议层裁剪。
- 在 ACP Client 侧实现 `fs/*`、`terminal/*` 等不必要能力；Gateway 默认不声明这些 capability，让 agent 使用自身内置能力。
- 接管已经打开的第三方 IDE ACP Client。若后续需要，需要额外 IDE 插件或专用控制接口。

## 确定技术栈

- 语言：TypeScript / Node.js。
- 运行时：Node.js LTS。
- 模块系统：ESM。
- 飞书 SDK：`@larksuiteoapi/node-sdk`。
- ACP SDK：`@agentclientprotocol/sdk`。
- 本地进程：Node `child_process`，必要时引入 `node-pty`。
- 状态存储：SQLite，优先使用 `better-sqlite3`。
- 配置文件：`agents.yaml`。
- 配置解析：`yaml`。
- 日志：`pino` 结构化 JSON 日志，便于后续排查和审计。
- 测试：`vitest`。
- 代码质量：`typescript`、`tsx`、`eslint`、`prettier`。

## TypeScript 项目结构

```text
acp-bot/
  package.json
  tsconfig.json
  agents.yaml
  .env.example
  src/
    index.ts
    config/
      loadConfig.ts
      schema.ts
    feishu/
      FeishuConnector.ts
      FeishuMessageClient.ts
      CardRenderer.ts
      types.ts
    commands/
      CommandRouter.ts
      commandTypes.ts
    acp/
      AcpProcessManager.ts
      AcpJsonRpcConnection.ts
      AcpSessionManager.ts
      acpTypes.ts
    proxy/
      ProxySessionController.ts
    state/
      StateStore.ts
      migrations.ts
    logging/
      logger.ts
    utils/
      id.ts
      markdown.ts
  data/
  logs/
  tests/
```

## 首批依赖

```json
{
  "dependencies": {
    "@agentclientprotocol/sdk": "latest",
    "@larksuiteoapi/node-sdk": "latest",
    "better-sqlite3": "latest",
    "dotenv": "latest",
    "pino": "latest",
    "yaml": "latest",
    "zod": "latest"
  },
  "devDependencies": {
    "@types/node": "latest",
    "eslint": "latest",
    "prettier": "latest",
    "tsx": "latest",
    "typescript": "latest",
    "vitest": "latest"
  }
}
```

## 总体架构

```text
飞书用户
  -> 飞书机器人消息 / 交互卡片
  -> Feishu Connector
  -> Command Router
  -> Session Manager
  -> ACP Client / Process Manager
  -> 本地 ACP Agent 子进程
```

## 模块设计

### 1. Feishu Connector

- 建立飞书长连接。
- 订阅并处理 `im.message.receive_v1`。
- 订阅并处理 `card.action.trigger`。
- 发送文本消息、Markdown 消息和交互卡片。
- 更新已发送卡片。
- 基于 `message_id` 做事件幂等。

### 2. Command Router

支持第一阶段命令：

- `/agents`：列出可用 agent。
- `/new [agent] [cwd]`：使用指定 agent 和工作目录创建新 ACP 会话。
- `/ask <content>`：向当前会话发送 prompt。
- `/sessions`：列出当前用户会话。
- `/switch <session>`：切换当前会话。
- `/agent <agent>`：切换当前默认 agent；后续 `/new` 默认使用该 agent。
- `/use <agent> [cwd]`：切换默认 agent，并使用可选工作目录创建新会话。
- `/cancel`：取消当前会话正在运行的 prompt。
- `/close <session>`：关闭会话和本地 agent 进程。
- `/status`：查看当前 agent、工作目录、会话和运行状态。
- `/modes`：查看当前 agent 声明的 session config、mode 和 slash commands。
- `/mode <value>`：切换当前会话的 agent 工作模式，优先使用 `session/set_config_option`，否则回退到 `session/set_mode`。
- `/help`：查看可用命令。

### 3. ACP Process Manager

- 根据 `agents.yaml` 启动 agent 子进程。
- 管理 stdin/stdout JSON-RPC 消息。
- 捕获 stderr 日志并写入本地日志。
- 处理进程退出、异常和重启。
- 支持多个 agent 实例并行运行。

### 4. ACP Session Manager

- 建立 ACP 连接后执行 `initialize`。
- 如 agent 返回 `authMethods`，支持调用 `authenticate`。
- 创建新会话时调用 `session/new`。
- 用户输入映射为 `session/prompt`。
- 用户取消映射为 `session/cancel`。
- 维护飞书 chat/user/thread 与 ACP session 的绑定关系。

### 5. Proxy Session Controller

- 维护每个飞书用户或群聊的默认 agent、当前会话和每个会话创建时绑定的工作目录。
- 工作目录只在创建会话时通过 `/new [agent] [cwd]` 或 `/use <agent> [cwd]` 指定；已有 ACP 会话不支持运行中切换工作目录。
- 将 `/xxx` 控制命令转换为 Gateway 内部状态变更或 ACP session 生命周期操作。
- 将普通文本消息透明转发为当前 ACP 会话的 `session/prompt`。
- 将 `session/request_permission` 映射到飞书交互卡片按钮。
- 将 `/modes` 和 `/mode` 映射到 ACP session config / mode 能力；不硬编码 `plan`、`goal` 等具体模式。
- 默认不在 `initialize` 中声明 `fs` 和 `terminal` capability。
- 不实现 `fs/*`、`terminal/*` 等不必要的 ACP Client 侧能力；文件、终端和工具能力由 agent 自身负责。
- 不在代理层加入额外安全限制；安全确认由飞书侧流程和权限配置负责。

### 6. Card Renderer

- 将 `agent_message_chunk` 合并为飞书 Markdown 展示。
- 将 `plan` 渲染成计划状态卡片。
- 将 `tool_call` 和 `tool_call_update` 渲染成工具调用状态。
- 将 diff、终端输出等长内容截断展示，并提供查看完整日志的后续能力。
- 控制卡片更新频率，避免触发飞书更新限频。

### 7. State Store

保存：

- 飞书用户与当前会话映射。
- ACP agent 实例信息。
- ACP sessionId。
- 飞书 message_id 与任务状态映射。
- permission request 的 pending 状态。
- 基础审计日志。

## 实施阶段

### 阶段 1：最小可用 POC

- 初始化 TypeScript / Node.js 项目。
- 配置 `package.json`、`tsconfig.json`、`tsx` 开发启动脚本。
- 接入飞书长连接。
- 支持接收文本消息。
- 支持配置并启动一个 ACP agent。
- 完成 `initialize` 和 `session/new`。
- 将飞书文本消息转发为 `session/prompt`。
- 将 agent 文本响应回复到飞书。

交付标准：

- 能在飞书里向本地 ACP agent 发起一次完整对话。
- agent 响应能返回飞书。

### 阶段 2：会话与多 Agent

- 增加 `agents.yaml`。
- 支持 `/agents`、`/new`、`/sessions`、`/switch`。
- 支持多会话状态持久化。
- 支持 agent 进程生命周期管理。

交付标准：

- 可以从飞书选择不同 agent。
- 可以在多个会话之间切换。

### 阶段 3：交互卡片与流式状态

- 实现飞书交互卡片发送和更新。
- 将 `session/update` 渲染为卡片状态。
- 展示计划、工具调用、运行中、完成、失败、取消状态。
- 增加 `/cancel` 和卡片取消按钮。

交付标准：

- 长任务期间飞书卡片能持续展示进度。
- 用户可以从飞书取消当前任务。

### 阶段 4：权限请求闭环

- 实现 ACP `session/request_permission`。
- 将 permission options 映射为飞书按钮。
- 用户点击按钮后，将选择结果返回给 agent。
- 处理 pending permission 超时和取消。

交付标准：

- agent 请求确认时，用户可以在飞书完成允许或拒绝。
- ACP prompt 能在用户选择后继续执行。

### 阶段 5：透明代理控制体验增强

- 增强 `/agent`、`/use`、`/status`、`/modes`、`/mode`、`/help` 等控制命令体验。
- 支持普通消息默认发送到当前会话，无需每次输入 `/ask`。
- 支持在会话卡片上快捷切换、取消、关闭。
- 支持显示当前默认 agent、当前会话工作目录和当前会话。
- 保持 Gateway 为透明代理，不实现 `fs/*`、`terminal/*` 等 ACP Client 侧能力。

交付标准：

- 用户可以只通过飞书 `/xxx` 命令完成 agent 选择、指定新会话工作目录和会话管理。
- 普通消息能稳定转发到当前 ACP 会话。
- Gateway 不依赖、不声明、不实现 ACP Client 侧 `fs/*` 和 `terminal/*` 能力。

### 阶段 6：稳定性与可运维

- 增加结构化日志。
- 增加 SQLite 状态恢复。
- 增加进程异常恢复。
- 增加配置校验。
- 增加常驻运行脚本。
- 增加基础测试。

交付标准：

- Gateway 可以长时间运行。
- 异常退出后可恢复历史会话元数据。
- 本地问题可通过日志定位。

## 配置草案

```yaml
feishu:
  appId: "${FEISHU_APP_ID}"
  appSecret: "${FEISHU_APP_SECRET}"

agents:
  codex:
    title: "Codex"
    command: "codex-acp"
    args: []
    env: {}

  gemini:
    title: "Gemini CLI"
    command: "gemini"
    args: ["--experimental-acp"]
    env: {}

storage:
  sqlitePath: "./data/acp-bot.sqlite"

logging:
  level: "info"
  path: "./logs/acp-bot.log"
```

## 第一版里程碑

第一版以“能通过飞书稳定驱动一个本地 ACP agent 完成真实任务”为目标，建议完成到阶段 5。Gateway 定位为透明代理和控制面：通过飞书 `/xxx` 命令管理 agent、工作目录和会话，不在 ACP Client 侧实现 `fs/*`、`terminal/*` 等不必要能力。
