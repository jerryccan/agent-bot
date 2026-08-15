import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";

interface DailyLogStreamOptions {
  clock?: () => Date;
  mode?: number;
  beforeOpen?: (filePath: string) => void;
}

export class DailyLogStream extends Writable {
  private currentPath?: string;
  private lastPath?: string;
  private currentStream?: fs.WriteStream;
  private readonly clock: () => Date;

  constructor(
    private readonly basePath: string,
    private readonly options: DailyLogStreamOptions = {},
  ) {
    super();
    this.clock = options.clock ?? (() => new Date());
  }

  get filePath(): string | undefined {
    return this.currentPath ?? this.lastPath;
  }

  override _write(
    chunk: string | Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    let stream: fs.WriteStream;
    try {
      stream = this.streamFor(this.clock());
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    stream.write(chunk, encoding, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    const stream = this.currentStream;
    this.currentStream = undefined;
    this.currentPath = undefined;
    if (!stream) {
      callback();
      return;
    }
    stream.end(callback);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.currentStream?.destroy();
    this.currentStream = undefined;
    this.currentPath = undefined;
    callback(error);
  }

  private streamFor(date: Date): fs.WriteStream {
    const targetPath = dailyLogPath(this.basePath, date);
    if (this.currentStream && this.currentPath === targetPath) return this.currentStream;

    const previous = this.currentStream;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    this.options.beforeOpen?.(targetPath);
    this.currentPath = targetPath;
    this.lastPath = targetPath;
    this.currentStream = fs.createWriteStream(targetPath, {
      flags: "a",
      ...(this.options.mode === undefined ? {} : { mode: this.options.mode }),
    });
    previous?.end();
    return this.currentStream;
  }
}

export function dailyLogPath(basePath: string, date: Date): string {
  const parsed = path.parse(basePath);
  const dateStamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  return path.join(parsed.dir, `${parsed.name}.${dateStamp}${parsed.ext}`);
}
