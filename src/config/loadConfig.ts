import fs from "node:fs";
import path from "node:path";
import { config as loadDotEnv } from "dotenv";
import YAML from "yaml";
import { appConfigSchema, type AppConfig } from "./schema.js";

const ENV_PATTERN = /\$\{([A-Z0-9_]+)\}/gi;

export function loadConfig(configPath = process.env.ACP_BOT_CONFIG ?? "./agents.yaml"): AppConfig {
  loadDotEnv();

  const absolutePath = path.resolve(configPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Config file does not exist: ${absolutePath}`);
  }

  const raw = fs.readFileSync(absolutePath, "utf8");
  const expanded = expandEnv(raw);
  const parsed = YAML.parse(expanded) as unknown;
  const config = appConfigSchema.parse(parsed);

  const defaultAgent = config.defaults.agent ?? Object.keys(config.agents)[0];
  if (!config.agents[defaultAgent]) {
    throw new Error(`Default agent "${defaultAgent}" is not configured.`);
  }

  return {
    ...config,
    defaults: {
      ...config.defaults,
      agent: defaultAgent,
      cwd: path.resolve(config.defaults.cwd),
    },
    storage: {
      sqlitePath: path.resolve(config.storage.sqlitePath),
    },
    logging: {
      ...config.logging,
      path: config.logging.path ? path.resolve(config.logging.path) : undefined,
    },
  };
}

function expandEnv(raw: string): string {
  return raw.replace(ENV_PATTERN, (_match, name: string) => process.env[name] ?? "");
}
