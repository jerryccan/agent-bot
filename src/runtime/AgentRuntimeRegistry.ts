import type { AgentRuntime, RuntimeKind } from "./types.js";

export class AgentRuntimeRegistry {
  constructor(private readonly runtimes: Record<string, AgentRuntime>) {}

  forAgent(agentName: string): AgentRuntime {
    const runtime = this.runtimes[agentName];
    if (!runtime) throw new Error(`Unknown agent runtime: ${agentName}`);
    return runtime;
  }

  entries(kind?: RuntimeKind): Array<[agentName: string, runtime: AgentRuntime]> {
    return Object.entries(this.runtimes).filter(([, runtime]) => kind === undefined || runtime.kind === kind);
  }

  close(): void {
    for (const runtime of Object.values(this.runtimes)) {
      runtime.close();
    }
  }
}
