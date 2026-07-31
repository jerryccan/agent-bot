# Agent Bot

通过飞书使用本机上的 Codex 和 ACP Agent。

[English](README.md) | 简体中文

Agent Bot 运行在你的电脑上，把飞书机器人连接到本机 Codex 环境。发送消息即可开始工作；执行过程中机器人会更新进度卡，完成后发送 Markdown 最终回答。

## 可以做什么

- 在飞书中使用本机已有的 Codex 登录
- 创建、继续、切换、分支和停止任务
- 使用文字、图片、群聊和话题协作
- 排队后续 Prompt，或在任务运行中追加指令
- Agent Bot 重启后继续已有工作
- 不使用飞书时通过本地 Console UI 运行

## 快速开始

### 使用前提

- Node.js 22 或更高版本
- 已安装 Codex CLI，并可直接执行 `codex`
- 已完成本机 Codex 登录

确认登录状态：

```powershell
codex login status
```

### 安装

```powershell
npm install --global @keyou007/agent-bot
agent-bot --version
agent-bot --help
```

该命令会全局安装 `agent-bot`。系统语言为中文时显示中文帮助，否则显示英文帮助。从源码安装的方法见[技术参考](docs/technical-reference.zh.md#开发与源码安装)。

### 初始化

```powershell
agent-bot init
```

打开命令显示的链接或扫描二维码，完成飞书机器人创建和授权。初始化会准备 `~/.agent-bot`、保存机器人凭据和授权用户、检查所需权限，并自动启动 Agent Bot。

只有 App ID 和 App Secret 都已保存到本地才视为机器人创建成功。如果初始化在完整凭据保存前中断，再次运行 `agent-bot init` 会创建新机器人；如果凭据已经保存，则会继续检查该机器人的远端权限和订阅。

非核心权限缺失不会阻塞初始化，Agent Bot 会提示可能无法使用的功能。

| 参数                   | 作用                      |
| ---------------------- | ------------------------- |
| `--skip-feishu`        | 仅初始化 Console 使用环境，不启动 Server |
| `--reconfigure-feishu` | 替换已有飞书凭据          |
| `--json`               | 输出便于程序读取的结果    |
| `--profile <目录>`     | 使用指定目录中的独立 Profile |
| `--config <路径>`      | 使用指定配置文件          |

之后可以重新运行 `agent-bot init` 检查或补齐机器人配置。如果 Server 已在运行，初始化会保留当前服务。

### 启动与停止

```powershell
agent-bot server status
```

`agent-bot init` 会自动启动 Server。之后如果手动停止了服务，可执行 `agent-bot server start` 再次启动。仅在本地使用时，请通过 `--skip-feishu` 初始化并运行 `agent-bot console`。

打开飞书，找到机器人并发送消息。当前会话没有任务时，Agent Bot 会自动创建。

停止服务：

```powershell
agent-bot server stop
```

### 更新或卸载

替换或移除全局包前，先停止正在运行的服务：

```powershell
agent-bot server stop
npm install --global @keyou007/agent-bot@latest
agent-bot server start
```

卸载：

```powershell
agent-bot server stop
npm uninstall --global @keyou007/agent-bot
```

卸载 npm 包不会删除 `~/.agent-bot` 中的用户数据。

## 日常命令

### 服务管理

```powershell
agent-bot server status
agent-bot server start
agent-bot server stop
agent-bot server restart
```

`server restart` 默认等待当前工作完成后再重启。只有可接受中断时才使用 `--immediate`。

### Console

```powershell
agent-bot console
```

Console UI 不需要飞书凭据。除非传入 `--force`，否则不会与正在运行的 Server 共享任务状态。

### 任务管理

```powershell
agent-bot task list
agent-bot task status <任务>
agent-bot task prompt <任务> "<prompt>"
agent-bot task title <任务> "<标题>"
agent-bot task stop <任务>
```

`<任务>` 可以是 `task list` 中的序号、任务 ID 或唯一的任务 ID 前缀。运行 `agent-bot --help` 可查看完整 CLI 参数。

## 飞书命令

普通文本会继续当前任务，以 `/` 开头的消息会作为命令处理。

| 命令                                    | 作用                       |
| --------------------------------------- | -------------------------- |
| `/new [标题] [--dir <路径> \| --nodir]` | 创建任务                   |
| `/sessions [关键词]`                    | 浏览可用的 Codex 任务      |
| `/switch [任务]`                        | 切换任务，或返回上一个任务 |
| `/fork [任务]`                          | 创建并打开任务分支         |
| `/status [任务]`                        | 查看任务进度和结果         |
| `/title <标题>`                         | 修改当前任务标题           |
| `/stop`                                 | 停止当前执行               |
| `/queue <prompt>`                       | 排队一个独立的后续 Prompt  |
| `/nosteer <prompt>`                     | 与 `/queue` 相同           |
| `/goal [目标]`                          | 查看或管理持久 Goal        |
| `/model [名称]`                         | 查看或切换模型             |
| `/thinking [级别]`                      | 查看或切换思考强度         |
| `/permissions auto\|confirm`            | 修改工具授权方式           |
| `/newgroup [标题]`                      | 为新任务创建私有群         |
| `/forkgroup [标题]`                     | 将当前位置分支到私有群     |
| `/agent [名称]`                         | 查看或切换默认 Agent       |
| `/use <agent> [cwd]`                    | 选择 Agent 并创建任务      |
| `! <命令>`                              | 在任务目录执行本地命令     |
| `/restart`                              | 优雅重启 Agent Bot         |
| `/help`                                 | 显示聊天内帮助             |

私聊、群正文和话题分别维护当前任务。可以单独发送图片，也可以同时发送文字和图片。任务运行中发送普通文字会追加指令；需要确保形成后续 turn 时使用 `/queue`（或 `/nosteer`）。

在话题中使用 `/forkgroup` 时，如果话题任务还没有完成过自己的 turn，则从话题原始 turn fork；完成过后则从话题任务最近完成的 turn fork。正在执行的 turn 不会作为 fork 点。

`/newgroup` 会立即在新群中创建并绑定一个新任务。新任务继承当前任务的项目目录、模型、思考强度和权限模式，不影响来源任务；来源聊天没有当前任务时，则使用选定 Agent 及其运行时默认设置。显式标题会同时作为群名后缀和任务标题。

`/newgroup` 省略标题时，任务标题为 `新任务`，默认群名为 `[agent] [project dir] 新任务 (mm-dd)`。`/forkgroup` 省略标题时，任务标题和群名都与 `/fork` 一样使用持久递增的 `源标题（分支 N）`，不追加日期。`/newgroup` 和 `/forkgroup` 创建的飞书群名最多显示 60 个字符。生成后的群名过长时，Agent Bot 只截断群名中的标题部分，任务标题本身保持不变。

## 配置与数据

Agent Bot 将用户相关文件保存在仓库之外：

| 路径                       | 用途               |
| -------------------------- | ------------------ |
| `~/.agent-bot/config.yaml` | Agent Bot 配置     |
| `~/.agent-bot/.env`        | 飞书凭据           |
| `~/.agent-bot/data/`       | 任务数据和输入缓存 |
| `~/.agent-bot/logs/`       | 运行日志           |

可通过 `AGENT_BOT_HOME` 修改用户数据目录。配置示例见 [config.example.yaml](config.example.yaml)。

### 多 Profile

不指定 `--profile` 时使用位于 `~/.agent-bot` 的主 Profile。运行其他相互隔离的机器人时，需要在每次命令中显式指定其目录：

```powershell
agent-bot --profile ~/.agent-bot-rescue init
agent-bot --profile ~/.agent-bot-rescue server start
agent-bot --profile ~/.agent-bot-rescue server status
```

其他 Profile 不按名称注册，而是直接使用目录。每个 Profile 都在所选目录内保存自己的 `config.yaml`、`.env`、`data/` 和 `logs/`，飞书凭据与本地控制端点也相互隔离。`--profile` 不能和 `--config` 同时使用。

## 常见问题

- **机器人没有响应：** 运行 `agent-bot server status`，并查看 `~/.agent-bot/logs/agent-bot.log`
- **飞书权限不完整：** 重新运行 `agent-bot init`，完成显示的授权步骤
- **Codex 无法启动：** 使用运行 Agent Bot 的同一操作系统用户执行 `codex login status`
- **只需要本地测试：** 运行 `agent-bot init --skip-feishu`，然后执行 `agent-bot console`
- **安全重启一直等待：** 使用 `agent-bot task list --status running` 检查活动任务

## 更多文档

- [技术参考](docs/technical-reference.zh.md)：配置、权限、路由、持久化、恢复和运行机制
- [配置示例](config.example.yaml)
- [更新日志](CHANGELOG.md)
- [Agent 开发指南](https://github.com/keyou/agent-bot/blob/master/AGENTS.md)
