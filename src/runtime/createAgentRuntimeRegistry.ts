import type { Logger } from "pino";
import { AcpProcessManager } from "../acp/AcpProcessManager.js";
import { AcpSessionManager } from "../acp/AcpSessionManager.js";
import { CodexProcessManager } from "../codex/CodexProcessManager.js";
import { CodexRuntime } from "../codex/CodexRuntime.js";
import type { AppConfig } from "../config/schema.js";
import { AcpRuntimeAdapter } from "./AcpRuntimeAdapter.js";
import { AgentRuntimeRegistry } from "./AgentRuntimeRegistry.js";
import type { AgentRuntime } from "./types.js";

export function createAgentRuntimeRegistry(config: AppConfig, logger: Logger): AgentRuntimeRegistry {
  const runtimes: Record<string, AgentRuntime> = {};
  for (const [agentName, agent] of Object.entries(config.agents)) {
    const runtimeLogger = logger.child({ agentName, runtimeKind: agent.kind });
    if (agent.kind === "codex") {
      const processManager = new CodexProcessManager(agent.command, agent.args, agent.env, runtimeLogger);
      runtimes[agentName] = new CodexRuntime(processManager, runtimeLogger);
      continue;
    }
    const processManager = new AcpProcessManager(runtimeLogger);
    const sessionManager = new AcpSessionManager(agentName, agent, processManager, runtimeLogger);
    runtimes[agentName] = new AcpRuntimeAdapter(sessionManager);
  }
  return new AgentRuntimeRegistry(runtimes);
}
