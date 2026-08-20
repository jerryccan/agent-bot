import { z } from "zod";
import { DEFAULT_LOG_PATH, DEFAULT_SQLITE_PATH } from "./paths.js";

const envRecordSchema = z.record(z.string(), z.string()).default({});

export const DEFAULT_GROUP_NAME_FORMAT = {
  project: "[{agent}] [{project}] {taskname}",
  projectless: "[{agent}] {taskname}",
  dateFormat: "MM-dd",
} as const;

const groupNameTemplateSchema = z.string().min(1).max(240).superRefine((template, context) => {
  const tokens = [...template.matchAll(/\{([^{}]+)\}/gu)].map((match) => match[1]!);
  const taskNameCount = tokens.filter((token) => token === "taskname").length;
  if (taskNameCount !== 1) {
    context.addIssue({
      code: "custom",
      message: "A group name format must contain exactly one {taskname} placeholder.",
    });
  }
  for (const token of tokens) {
    if (["os", "agent", "project", "taskname", "date"].includes(token)) continue;
    if (token.startsWith("date:") && token.slice("date:".length).trim()) continue;
    context.addIssue({
      code: "custom",
      message: `Unsupported group name placeholder: {${token}}.`,
    });
  }
});

const groupNameFormatSchema = z.object({
  project: groupNameTemplateSchema.default(DEFAULT_GROUP_NAME_FORMAT.project),
  projectless: groupNameTemplateSchema.default(DEFAULT_GROUP_NAME_FORMAT.projectless),
  dateFormat: z.string().min(1).max(80).default(DEFAULT_GROUP_NAME_FORMAT.dateFormat),
}).default(DEFAULT_GROUP_NAME_FORMAT);

const agentKindSchema = z.union([
  z.literal("acp"),
  z.literal("app-server"),
  z.literal("codex").transform(() => "app-server" as const),
]).default("acp");

export const agentConfigSchema = z.object({
  kind: agentKindSchema,
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
    userOpenId: z.string().optional(),
    respondToOwnerOnly: z.boolean().default(true),
    respondToAllGroupMessages: z.boolean().default(true),
    groupNameFormat: groupNameFormatSchema,
    thinkingCardLayout: z.enum(["grouped", "timeline"]).default("grouped"),
    useConsoleWhenMissingCredentials: z.boolean().default(false),
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
    sqlitePath: z.string().default(DEFAULT_SQLITE_PATH),
  }).default({ sqlitePath: DEFAULT_SQLITE_PATH }),
  logging: z.object({
    level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    path: z.string().optional().default(DEFAULT_LOG_PATH),
  }).default({ level: "info", path: DEFAULT_LOG_PATH }),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type GroupNameFormatConfig = z.infer<typeof groupNameFormatSchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;
