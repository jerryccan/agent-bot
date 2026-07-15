import fs from "node:fs";
import path from "node:path";
import pino, { type Logger } from "pino";
import type { AppConfig } from "../config/schema.js";

export function createLogger(config: AppConfig): Logger {
  const streams: pino.StreamEntry[] = [
    {
      stream: process.stdout,
    },
  ];

  if (config.logging.path) {
    fs.mkdirSync(path.dirname(config.logging.path), { recursive: true });
    streams.push({
      stream: fs.createWriteStream(config.logging.path, { flags: "a" }),
    });
  }

  return pino(
    {
      level: config.logging.level,
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream(streams),
  );
}
