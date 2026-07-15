import { z } from "zod";

const envRecordSchema = z.record(z.string(), z.string()).default({});

export const agentConfigSchema = z.object({
  kind: z.enum(["acp", "codex"]).default("acp"),
  title: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: envRecordSchema,
});

export const appConfigSchema = z.object({
  console: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({ enabled: true }),
  feishu: z.object({
    transport: z.enum(["auto", "sdk", "console"]).default("auto"),
    appId: z.string().optional(),
    appSecret: z.string().optional(),
    useConsoleWhenMissingCredentials: z.boolean().default(true),
  }),
  agents: z.record(z.string().min(1), agentConfigSchema).refine(
    (agents) => Object.keys(agents).length > 0,
    "At least one agent must be configured.",
  ),
  defaults: z
    .object({
      agent: z.string().optional(),
      cwd: z.string().default("."),
    })
    .default({ cwd: "." }),
  storage: z.object({
    sqlitePath: z.string().default("./data/acp-bot.sqlite"),
  }),
  logging: z.object({
    level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    path: z.string().optional(),
  }),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;
