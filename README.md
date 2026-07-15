# Feishu ACP Gateway

一个通过飞书机器人控制本地 ACP agent 的透明代理工具。

## 定位

- Gateway 作为 ACP Client 启动本地 ACP stdio agent。
- 飞书机器人作为控制面，提供 `/xxx` 命令、会话管理和交互确认。
- Gateway 不在 ACP Client 侧实现 `fs/*`、`terminal/*` 等能力，也不会在 `initialize` 中声明这些 capability。
- 文件、终端、MCP、工具调用等能力由 agent 自身负责。

## 本地启动

```powershell
npm install
npm run dev
```

未配置飞书凭证时会进入 console 模式，可以直接在终端输入命令验证代理链路：

```text
/help
/agents
/new example .
hello
/modes
/mode plan
/status
```

## 飞书配置

默认配置使用 `auto` transport：配置了飞书应用凭证时走 SDK 长连接；未配置凭证且允许 fallback 时进入 console 模式，方便本地验证 ACP 链路。

```yaml
feishu:
  transport: "auto"
  appId: "${FEISHU_APP_ID}"
  appSecret: "${FEISHU_APP_SECRET}"
  useConsoleWhenMissingCredentials: true
```

复制 `.env.example` 为 `.env`，填入企业自建应用的凭证：

```env
FEISHU_APP_ID=cli_xxxxxxxxxxxxx
FEISHU_APP_SECRET=your_app_secret
ACP_BOT_CONFIG=./agents.yaml
```

飞书应用需要：

- 开启机器人能力。
- 使用长连接接收事件。
- 订阅 `im.message.receive_v1`。
- 订阅 `card.action.trigger`。
- 具备发送消息和更新卡片所需权限。

## Agent 配置

在 `agents.yaml` 中配置本地 ACP agent：

```yaml
agents:
  codex:
    title: "Codex"
    command: "codex-acp"
    args: []
    env: {}

defaults:
  agent: "codex"
  cwd: "D:\\dev\\your-project"
```

## 命令

- `/agents`：列出 agent。
- `/new [agent] [cwd]`：创建新会话，工作目录只在创建会话时指定。
- `/use <agent> [cwd]`：切换默认 agent，并创建新会话。
- `/agent <agent>`：切换默认 agent。
- `/sessions`：列出会话。
- `/switch <session>`：切换当前会话。
- `/ask <content>`：发送 prompt。
- 普通文本：发送到当前会话。
- `/modes`：查看 agent 声明的模式、配置项和 slash commands。
- `/mode <value>`：切换 agent 声明的模式，优先使用 `session/set_config_option`，否则回退到 `session/set_mode`。
- `/cancel`：取消当前任务。
- `/close [session]`：关闭会话。
- `/status`：查看状态。
- `/help`：查看帮助。

## 工作目录规则

工作目录只在 `/new [agent] [cwd]` 或 `/use <agent> [cwd]` 创建会话时传入 ACP `session/new`。已有 ACP 会话不支持运行中切换工作目录。
