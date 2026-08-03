import { cliLanguage, type CliLanguage } from "./i18n.js";

export function renderCliHelp(version: string, language: CliLanguage = cliLanguage): string {
  if (language === "zh") {
    return `Agent Bot ${version}
通过飞书使用本地 Codex、TraeX 和兼容 ACP 的 Agent。

用法：
  agentbot [选项] <命令>

常用命令：
  init                              检查并选择 Agent，初始化飞书应用和服务
  init --reset                      重置并重新配置显式指定的 Profile
  console                           打开本地控制台
  server start                      在后台启动 Agent Bot
  server status                     显示服务、飞书 App ID 和安全重启状态
  server restart [--task <任务>]    安排安全重启并将状态发回指定任务会话
  server stop                       停止 Agent Bot
  task list                         列出任务
  task status <任务>                显示任务状态
  task chat <任务>                  显示任务绑定的飞书会话
  task prompt <任务> <提示词>       向任务发送提示词
  task newgroup <任务> [标题]       创建新群；支持 --agent、--dir、--nodir
  task forkgroup <任务> [标题]      从任务 Fork 新群
  task stop <任务>                  停止任务
  task title <任务> <标题>          重命名任务
  skills status                     显示内置 Skill 状态
  skills install                    安装内置 Skill

选项：
  --profile <目录>                  使用独立的 Profile 目录
  --config <路径>                   使用指定的配置文件
  --json                            在支持时输出 JSON
  -h, --help                        显示帮助
  -v, --version                     显示版本

初始化选项：
  --reset                           备份并重置显式指定的 Profile
  --skip-feishu                     仅初始化 Console 环境
  --reconfigure-feishu              仅替换现有飞书凭据

重启选项：
  --task <任务>                     将安全重启状态发回任务所在会话
  --reason <原因>                   设置重启原因
  --immediate                       立即重启，可能中断任务

示例：
  agentbot init
  agentbot --profile ~/.agent-bot init --reset
  agentbot --profile ~/.agent-bot-rescue init
  agentbot server start
  agentbot server status
  agentbot task list
  agentbot server restart --reason "更新 Agent Bot"
`;
  }

  return `Agent Bot ${version}
Use Codex, TraeX, and compatible ACP agents from Lark/Feishu.

Usage:
  agentbot [options] <command>

Common commands:
  init                              Check and select an Agent; initialize the Lark app and service
  init --reset                      Reset and reconfigure an explicit profile
  console                           Open the local console
  server start                      Start Agent Bot in the background
  server status                     Show the server, Lark App ID, and safe-restart status
  server restart [--task <task>]    Schedule a safe restart and return status to the task's conversation
  server stop                       Stop Agent Bot
  task list                         List tasks
  task status <task>                Show task status
  task chat <task>                  Show the task's Lark chat binding
  task prompt <task> <prompt>       Send a Prompt to a task
  task newgroup <task> [title]      Create a group; supports --agent, --dir, --nodir
  task forkgroup <task> [title]     Fork a task into a new group
  task stop <task>                  Stop a task
  task title <task> <title>         Rename a task
  skills status                     Show the built-in Skill status
  skills install                    Install the built-in Skill

Options:
  --profile <directory>             Use an isolated profile directory
  --config <path>                   Use a specific config file
  --json                            Print JSON when supported
  -h, --help                        Show help
  -v, --version                     Show version

Init options:
  --reset                           Back up and reset the selected explicit profile
  --skip-feishu                     Initialize for Console only
  --reconfigure-feishu              Replace only the existing Lark credentials

Restart options:
  --task <task>                     Return safe-restart status to the task's conversation
  --reason <reason>                 Set the restart reason
  --immediate                       Restart immediately and possibly interrupt tasks

Examples:
  agentbot init
  agentbot --profile ~/.agent-bot init --reset
  agentbot --profile ~/.agent-bot-rescue init
  agentbot server start
  agentbot server status
  agentbot task list
  agentbot server restart --reason "Update Agent Bot"
`;
}
