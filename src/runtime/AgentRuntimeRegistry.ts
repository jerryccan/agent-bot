import type { AgentConfig } from "../config/schema.js";
import type { AgentRuntime, RuntimeKind } from "./types.js";

export class AgentRuntimeRegistry {
  constructor(private readonly runtimes: Record<RuntimeKind, AgentRuntime>) {}

  forAgent(agent: Pick<AgentConfig, "kind">): AgentRuntime {
    return this.runtimes[agent.kind];
  }

  get(kind: RuntimeKind): AgentRuntime {
    return this.runtimes[kind];
  }

  close(): void {
    for (const runtime of Object.values(this.runtimes)) {
      runtime.close();
    }
  }
}
