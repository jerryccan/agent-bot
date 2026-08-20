import type { Readable, Writable } from "node:stream";
import {
  cancel,
  intro,
  isCancel,
  log,
  multiselect,
  note,
  outro,
  select,
} from "@clack/prompts";
import { cliText } from "./i18n.js";

export interface InitUiOption<Value extends string | number> {
  value: Value;
  label: string;
  hint?: string;
}

export interface InitUiOptions {
  interactive: boolean;
  input?: Readable;
  output?: Writable;
}

export class InitializationPromptCancelledError extends Error {
  constructor() {
    super(cliText("Initialization was cancelled.", "初始化已取消。"));
    this.name = "InitializationPromptCancelledError";
  }
}

export class InitUi {
  readonly interactive: boolean;
  private readonly input: Readable;
  private readonly output: Writable;

  constructor(options: InitUiOptions) {
    this.interactive = options.interactive;
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stderr;
  }

  start(title: string): void {
    if (this.interactive) intro(title, this.commonOptions());
  }

  finish(message: string): void {
    if (this.interactive) outro(message, this.commonOptions());
  }

  step(message: string): void {
    if (this.interactive) log.step(message, this.commonOptions());
  }

  info(message: string): void {
    if (this.interactive) log.info(message, this.commonOptions());
  }

  success(message: string): void {
    if (this.interactive) log.success(message, this.commonOptions());
  }

  warn(message: string): void {
    if (this.interactive) log.warn(message, this.commonOptions());
  }

  note(title: string, message: string): void {
    if (this.interactive) note(message, title, this.commonOptions());
  }

  async select<Value extends string | number>(options: {
    message: string;
    options: InitUiOption<Value>[];
    initialValue?: Value;
  }): Promise<Value> {
    this.requireInteractive();
    const value = await select<string | number>({
      message: options.message,
      options: promptOptions(options.options),
      ...(options.initialValue !== undefined ? { initialValue: options.initialValue } : {}),
      ...this.commonOptions(),
    });
    return this.requireValue(value) as Value;
  }

  async multiselect<Value extends string | number>(options: {
    message: string;
    options: InitUiOption<Value>[];
    initialValues?: Value[];
    required?: boolean;
  }): Promise<Value[]> {
    this.requireInteractive();
    const values = await multiselect<string | number>({
      message: options.message,
      options: promptOptions(options.options),
      ...(options.initialValues ? { initialValues: options.initialValues } : {}),
      ...(options.required !== undefined ? { required: options.required } : {}),
      ...this.commonOptions(),
    });
    return this.requireValue(values) as Value[];
  }

  private commonOptions(): { input: Readable; output: Writable } {
    return { input: this.input, output: this.output };
  }

  private requireInteractive(): void {
    if (!this.interactive) {
      throw new Error("Interactive initialization is not available in this terminal.");
    }
  }

  private requireValue<Value>(value: Value | symbol): Value {
    if (!isCancel(value)) return value;
    cancel(cliText("Initialization cancelled.", "初始化已取消。"), this.commonOptions());
    throw new InitializationPromptCancelledError();
  }
}

function promptOptions<Value extends string | number>(
  options: InitUiOption<Value>[],
): Array<InitUiOption<string> | InitUiOption<number>> {
  return options.map(({ value, label, hint }) => typeof value === "number"
    ? { value: value as number, label, ...(hint ? { hint } : {}) }
    : { value: value as string, label, ...(hint ? { hint } : {}) });
}

export function shouldUseInteractiveInitialization(
  json: boolean,
  inputIsTty = process.stdin.isTTY === true,
  outputIsTty = process.stderr.isTTY === true,
): boolean {
  return !json && inputIsTty && outputIsTty;
}
