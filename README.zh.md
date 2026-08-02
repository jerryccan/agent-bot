<p align="center">
  <img src="assets/agent-bot-logo.png" alt="Agent Bot Logo" width="180">
</p>

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
agentbot --version
agentbot --help
```

该命令会把 `agentbot` 安装为主命令。旧的 `agent-bot` 命令暂时保留，运行时会显示弃用警告，并将在后续版本中移除。命令行帮助、状态、进度、交互提示和错误会根据系统语言显示中文或英文；其他未支持语言统一回退英文。JSON 输出不做本地化并保持字段稳定。从源码安装的方法见[技术参考](docs/technical-reference.zh.md#开发与源码安装)。

### 初始化

```powershell
agentbot init
```

打开命令显示的链接或扫描二维码，完成飞书机器人创建和授权。初始化会准备 `~/.agent-bot`、保存机器人凭据和授权用户、检查所需权限，并自动启动 Agent Bot。

只有 App ID 和 App Secret 都已保存到本地才视为机器人创建成功。如果初始化在完整凭据保存前中断，再次运行 `agentbot init` 会创建新机器人；如果凭据已经保存，则会继续检查该机器人的远端权限和订阅。

`im:message.group_msg` 无法通过飞书一键配置新增。缺少该权限时，Agent Bot 会显示二维码，以及已筛选该权限的开发者后台直达链接。请手动新增权限、发布应用版本，并在需要时完成租户管理员审批。Agent Bot 等待权限生效时，可输入 `Y` 跳过该权限并继续初始化；最终结果会提示机器人无法响应未 @ 它的普通群消息。

缺少非核心权限或订阅时，Agent Bot 会先显示二维码和授权链接，然后立即等待最多 5 分钟使配置生效。终端只提供一个选项：输入 `Y` 跳过可选授权并继续；否则直接在浏览器中完成授权，Agent Bot 会持续等待。可选授权失败或超时不会阻止启动，Agent Bot 会提示可能无法使用的功能。

| 参数                   | 作用                      |
| ---------------------- | ------------------------- |
| `--reset`              | 备份并完整重置显式指定的 Profile |
| `--skip-feishu`        | 仅初始化 Console 使用环境，不启动 Server |
| `--reconfigure-feishu` | 替换已有飞书凭据          |
| `--json`               | 输出便于程序读取的结果    |
| `--profile <目录>`     | 使用指定目录中的独立 Profile |
| `--config <路径>`      | 使用指定配置文件          |

之后可以重新运行 `agentbot init` 检查或补齐机器人配置。如果 Server 已在运行，初始化会保留当前服务。

如需完整重新配置一个 Profile，请先停止它的 Server，并显式指定 Profile：

```powershell
agentbot --profile ~/.agent-bot init --reset
```

重置会把当前 `config.yaml`、`.env`、`data/` 和 `logs/` 移入 `.reset-backups` 下新的时间戳目录，再创建干净的新文件和目录。已有备份会永久保留，不会被后续重置覆盖或清理。远端旧飞书应用不会被删除。

### 启动与停止

```powershell
agentbot server status
```

`agentbot init` 会自动启动 Server。之后如果手动停止了服务，可执行 `agentbot server start` 再次启动。仅在本地使用时，请通过 `--skip-feishu` 初始化并运行 `agentbot console`。

`Agent Bot 已启动` 启动卡片会显示当前正在运行的 Agent Bot 版本。

打开飞书，找到机器人并发送消息。当前会话没有任务时，Agent Bot 会自动创建。

停止服务：

```powershell
agentbot server stop
```

### 更新或卸载

替换或移除全局包前，先停止正在运行的服务：

```powershell
agentbot server stop
npm install --global @keyou007/agent-bot@latest
agentbot server start
```

卸载：

```powershell
agentbot server stop
npm uninstall --global @keyou007/agent-bot
```

卸载 npm 包不会删除 `~/.agent-bot` 中的用户数据。

## 日常命令

### 服务管理

```powershell
agentbot server status
agentbot server start
agentbot server stop
agentbot server restart
```

`server restart` 默认等待当前工作完成后再重启；等待期间可通过状态卡片下方的 `Cancel` 按钮取消。只有可接受中断时才使用 `--immediate`。

`server status` 会显示当前运行服务使用的 Lark App ID；添加 `--json` 后可从 `feishuAppId` 字段读取。

### Console

```powershell
agentbot console
```

Console UI 不需要飞书凭据。除非传入 `--force`，否则不会与正在运行的 Server 共享任务状态。

### 任务管理

```powershell
agentbot task list
agentbot task status <任务>
agentbot task prompt <任务> "<prompt>"
agentbot task title <任务> "<标题>"
agentbot task stop <任务>
```

`<任务>` 可以是 `task list` 中的序号、任务 ID 或唯一的任务 ID 前缀。运行 `agentbot --help` 可查看完整 CLI 参数。

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
| `/provider`                            | 打开运行设置的 Provider tab   |
| `/model`                               | 打开运行设置的 Model tab      |
| `/thinking`                            | 打开运行设置的 Thinking tab   |
| `/permissions`                         | 打开运行设置的 Permission tab |
| `/newgroup [标题] [--dir <cwd> \| --nodir]` | 为新任务创建私有群         |
| `/forkgroup [标题]`                     | 将当前位置分支到私有群     |
| `/agent [名称]`                         | 打开 Agent 设置或切换默认 Agent |
| `! <命令>`                              | 在任务目录执行本地命令     |
| `/restart [--force]`                    | 默认安全重启；`--force` 立即重启 |
| `/help`                                 | 显示聊天内帮助             |

斜杠命令支持任意唯一前缀，复合命令还支持首字母缩写：`/sess` 等同于 `/sessions`，`/fg` 等同于 `/forkgroup`，`/ng` 等同于 `/newgroup`，`/ns` 等同于 `/nosteer`。完整命令名优先；`/s`、`/f` 等匹配多个命令的前缀会被拒绝，并列出全部候选命令。

`/agent`、`/provider`、`/model`、`/thinking` 和 `/permissions` 在存在可选项时使用同一张运行设置卡片。配置了多个 Agent 时，卡片会增加 Agent tab，用于选择后续新任务使用的默认 Agent；即使当前聊天还没有任务，`/agent` 也能打开该 tab。只配置一个 Agent 时，`/agent` 直接显示当前 Agent，不打开卡片。现有任务仍保持原来的 Agent，使用不同 Agent 的任务可以相互独立地运行。`/agent <名称>` 继续支持直接选择。没有可切换的 Provider 时，`/provider` 同样只显示当前 Provider。其余四个命令激活各自对应的 tab，且不接受参数。没有可继承设置的新任务使用 Codex 配置中的默认 Provider。

私聊、群正文和话题分别维护当前任务。可以单独发送图片，也可以同时发送文字和图片。任务运行中发送普通文字会追加指令；需要确保形成后续 turn 时使用 `/queue`（或 `/nosteer`）。

`/sessions` 卡片为每个任务提供 `NewGroup` 和 `ForkGroup` 操作，可直接按所选任务创建同项目的新群，或把所选任务 Fork 到新群。

在话题中使用 `/forkgroup` 时，如果话题任务还没有完成过自己的 turn，则从话题原始 turn fork；完成过后则从话题任务最近完成的 turn fork。正在执行的 turn 不会作为 fork 点。

`/forkgroup` 创建新群后，群内欢迎消息会显示分支任务当前使用的 Provider、模型、思考强度和权限类型。

`/new` 和 `/newgroup` 支持相同的项目参数：使用 `--dir <cwd>` 覆盖继承的项目目录，或使用 `--nodir` 强制创建 Projectless Codex 任务，二者不能同时使用。两条命令中的 `~`、`~/...` 和 `~\...` 均表示当前用户目录。`/newgroup` 会立即在新群中创建并绑定任务，同时继续继承当前任务的 Provider、模型、思考强度和权限模式，不影响来源任务。来源聊天没有当前任务时，则使用选定 Agent 及其运行时默认设置。显式标题会同时作为群名后缀和任务标题。

`/newgroup` 省略标题时，任务标题为 `新任务`，默认群名为 `[agent] [project dir] 新任务 (mm-dd)`。Projectless 群会完全省略项目段，群名格式为 `[agent] title`。`/forkgroup` 省略标题时，任务标题和群名都与 `/fork` 一样使用持久递增的 `源标题（分支 N）`，不追加日期。`/newgroup` 和 `/forkgroup` 创建的飞书群名最多显示 60 个字符。生成后的群名过长时，Agent Bot 只截断群名中的标题部分，任务标题本身保持不变。

把已绑定任务的群改名为 `[agent] [project dir] title` 时，只会把 `title` 同步到当前任务；Agent 和工程目录前缀仅作为群元数据，不会写入 Codex 任务标题。旧的 `[agent] title` 格式仍然兼容。

## 配置与数据

Agent Bot 将用户相关文件保存在仓库之外：

| 路径                       | 用途               |
| -------------------------- | ------------------ |
| `~/.agent-bot/config.yaml` | Agent Bot 配置     |
| `~/.agent-bot/.env`        | 飞书凭据           |
| `~/.agent-bot/data/`       | 任务数据和输入缓存 |
| `~/.agent-bot/logs/`       | 运行日志           |

可通过 `AGENT_BOT_HOME` 修改用户数据目录。配置示例见 [config.example.yaml](config.example.yaml)。

默认情况下，Agent Bot 会响应机器人所在群内的普通消息。将 `feishu.respondToAllGroupMessages` 设为 `false` 后，群消息必须 @ 当前机器人才会响应，私聊不受影响。初始化仍会申请完整的群消息权限，因此以后切换该配置无需重新授权。

### 多 Profile

不指定 `--profile` 时使用位于 `~/.agent-bot` 的主 Profile。运行其他相互隔离的机器人时，需要在每次命令中显式指定其目录：

```powershell
agentbot --profile ~/.agent-bot-rescue init
agentbot --profile ~/.agent-bot-rescue server start
agentbot --profile ~/.agent-bot-rescue server status
```

其他 Profile 不按名称注册，而是直接使用目录。每个 Profile 都在所选目录内保存自己的 `config.yaml`、`.env`、`data/` 和 `logs/`，飞书凭据与本地控制端点也相互隔离。`--profile` 不能和 `--config` 同时使用。

## 常见问题

- **机器人没有响应：** 运行 `agentbot server status`，并查看 `~/.agent-bot/logs/agent-bot.log`
- **Node 崩溃后 Worker 被自动重启：** 查看 `~/.agent-bot/data/last-crash.json`、`~/.agent-bot/logs/worker.stderr.log` 和 `~/.agent-bot/data/crash-reports/`
- **飞书权限不完整：** 重新运行 `agentbot init`，完成显示的授权步骤
- **Codex 无法启动：** 使用运行 Agent Bot 的同一操作系统用户执行 `codex login status`
- **只需要本地测试：** 运行 `agentbot init --skip-feishu`，然后执行 `agentbot console`
- **安全重启一直等待：** 使用 `agentbot task list --status running` 检查活动任务

## 更多文档

- [技术参考](docs/technical-reference.zh.md)：配置、权限、路由、持久化、恢复和运行机制
- [配置示例](config.example.yaml)
- [更新日志](CHANGELOG.md)
- [Agent 开发指南](https://github.com/keyou/agent-bot/blob/master/AGENTS.md)
