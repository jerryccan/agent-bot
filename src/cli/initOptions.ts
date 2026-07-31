export interface InitCommandOptions {
  json: boolean;
  skipFeishu: boolean;
  reconfigureFeishu: boolean;
  reset: boolean;
}

export function parseInitCommandOptions(
  input: string[],
  explicitProfile: boolean,
): InitCommandOptions {
  const supported = new Set(["--json", "--skip-feishu", "--reconfigure-feishu", "--reset"]);
  const unsupported = input.filter((value) => !supported.has(value));
  if (unsupported.length > 0) {
    throw new Error(`Unsupported init options: ${unsupported.join(" ")}`);
  }
  const options = {
    json: input.includes("--json"),
    skipFeishu: input.includes("--skip-feishu"),
    reconfigureFeishu: input.includes("--reconfigure-feishu"),
    reset: input.includes("--reset"),
  };
  if (options.skipFeishu && options.reconfigureFeishu) {
    throw new Error("--skip-feishu and --reconfigure-feishu cannot be used together.");
  }
  if (options.reset && !explicitProfile) {
    throw new Error("--reset requires an explicit --profile <directory>.");
  }
  if (options.reset && options.reconfigureFeishu) {
    throw new Error("--reset cannot be combined with --reconfigure-feishu because reset already replaces Lark credentials.");
  }
  return options;
}
