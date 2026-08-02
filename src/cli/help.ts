import { cliLanguage, type CliLanguage } from "./i18n.js";

export function renderCliHelp(version: string, language: CliLanguage = cliLanguage): string {
  if (language === "zh") {
    return `Agent Bot ${version}
通过飞书使用本地 Codex 和 ACP Agent。

用法：
  agentbot [选项] <命令>

常用命令：
  init                              初始化飞书应用并启动服务
  init --reset                      重置并重新配置显式指定的 Profile
  console                           打开本地控制台
  server start                      在后台启动 Agent Bot
  server status                     显示服务、飞书 App ID 和安全重启状态
  server restart                    安排安全重启
  server stop                       停止 Agent Bot
  task list                         列出任务
  task status <任务>                显示任务状态
  task chat <任务>                  显示任务绑定的飞书会话
  task prompt <任务> <提示词>       向任务发送提示词
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
Use local Codex and ACP agents from Lark/Feishu.

Usage:
  agentbot [options] <command>

Common commands:
  init                              Initialize the Lark app and start the service
  init --reset                      Reset and reconfigure an explicit profile
  console                           Open the local console
  server start                      Start Agent Bot in the background
  server status                     Show the server, Lark App ID, and safe-restart status
  server restart                    Schedule a safe restart
  server stop                       Stop Agent Bot
  task list                         List tasks
  task status <task>                Show task status
  task chat <task>                  Show the task's Lark chat binding
  task prompt <task> <prompt>       Send a Prompt to a task
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
