export function renderCliHelp(version: string): string {
  return `Agent Bot ${version}
Use local Codex and ACP agents from Lark/Feishu.

Usage:
  agent-bot [options] <command>

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
  agent-bot init
  agent-bot --profile ~/.agent-bot init --reset
  agent-bot --profile ~/.agent-bot-rescue init
  agent-bot server start
  agent-bot server status
  agent-bot task list
  agent-bot server restart --reason "Update Agent Bot"
`;
}
