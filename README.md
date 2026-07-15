# acp-bot：通过飞书使用本机 Codex

`acp-bot` 把本机 Codex App Server 接到飞书机器人，并保留一个并行的命令行入口用于测试。飞书是主界面：每次请求只创建一张进度卡，卡片会原地更新；完成后再单独发送最终 Markdown 回复。

## 使用前提

- Node.js 20+
- 已安装 Codex CLI，并能在运行机器上执行 `codex`
- 用运行 `acp-bot` 的同一个系统用户完成过 Codex 登录

检查登录状态：

```powershell
codex login status
```

App Server 直接复用本机 Codex 的登录状态，不需要机器人用户或飞书侧再次登录 ChatGPT。若通过服务账号启动，需要确保它与登录 Codex 时使用相同的 `CODEX_HOME` 和凭证目录。

## 启动

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

填入 `.env`：

```env
FEISHU_APP_ID=cli_xxxxxxxxxxxxx
FEISHU_APP_SECRET=your_app_secret
ACP_BOT_CONFIG=./agents.yaml
```

默认会同时启动：

- 飞书 WebSocket 长连接（配置凭证时）
- 本地测试终端（`console.enabled: true`）

两条入口各自维护当前任务，不会互相切换会话。未配置飞书凭证时，仍可直接在终端测试 Codex。

## Codex 配置

默认 `agents.yaml` 已包含：

```yaml
console:
  enabled: true

agents:
  codex:
    kind: "codex"
    title: "Codex"
    command: "codex"
    args:
      - "app-server"
      - "--listen"
      - "stdio://"
    env: {}

defaults:
  agent: "codex"
  cwd: "."
```

`cwd` 是 Codex 默认工作目录。也可以用 `/new codex D:\dev\project` 为新任务指定目录。已有任务的工作目录不会在运行中改变。

## 飞书应用配置

企业自建应用需要：

- 开启机器人能力
- 使用长连接接收事件
- 订阅 `im.message.receive_v1`
- 订阅 `card.action.trigger`
- 开通机器人收发消息、发送卡片和更新消息所需权限

消息体验：

- 直接发文字时，若没有当前任务会自动创建 Codex thread
- Codex 运行中继续发文字，会通过 steering 追加到当前 turn；若恰好完成，则自动排为下一次请求
- 每个 turn 只有一张进度卡，普通更新最多每 2 秒一次，关键状态最短间隔 500ms
- 当前工具直接展示；成功工具折叠；失败工具展开；文件变更折叠汇总
- 完成后先把进度卡更新为终态，再单独发送最终 Markdown；长代码块会安全分片
- 重启后会恢复原 Codex thread，但不会读取或重发已经发送成功的历史消息
- 卡片的“查看详情”只读取本地有界快照，不会触发 App Server 历史回放

## 命令

- 普通文本：发送给当前 Codex；没有任务时自动创建
- `/new [agent] [cwd]`：创建新任务
- `/sessions`：列出当前入口的任务
- `/switch <session>`：切换当前任务
- `/model`：列出可用模型
- `/model <name>`：切换模型，从下一次请求生效
- `/permissions auto|confirm`：切换权限模式
- `/cancel`：停止当前执行
- `/status`：查看任务、模型、权限、目录和状态
- `/close [session]`：关闭任务
- `/agents`：列出 agent
- `/agent <agent>`：切换默认 agent
- `/use <agent> [cwd]`：切换默认 agent 并创建任务
- `/help`：显示帮助

权限模式：

- `auto`（默认）：Codex 使用 `approvalPolicy=never` 和 `danger-full-access`，工具直接执行
- `confirm`：需要确认的工具会在进度卡中显示按钮，可允许一次、会话内允许、拒绝或取消

## 持久化与恢复

SQLite 默认位于 `./data/acp-bot.sqlite`，保存入口当前任务、Codex thread ID、模型、权限模式、进度快照和最终消息投递账本。

进程重启后的第一次新消息会惰性调用 `thread/resume`。返回值中的历史 turns 不进入展示链路，且 Runtime 只接受本地新启动 turn 的事件；投递账本还会阻止同一最终回复重复发送。App Server 异常退出后不会自动重放 prompt。

## 保留 ACP Agent

未写 `kind` 的 agent 仍按 `acp` 处理：

```yaml
agents:
  example:
    kind: "acp"
    title: "Example ACP Agent"
    command: "node"
    args: ["./examples/example-acp-agent.js"]
```

Codex 是默认入口，原有 ACP agent 仍可通过 `/agent`、`/use` 或 `/new` 选择。
