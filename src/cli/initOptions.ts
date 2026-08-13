export interface InitCommandOptions {
  json: boolean;
  skipFeishu: boolean;
  reconfigureFeishu: boolean;
  reset: boolean;
}

export function parseInitCommandOptions(input: string[]): InitCommandOptions {
  const supported = new Set(["--json", "--skip-feishu", "--reconfigure-feishu", "--reset"]);
  const unsupported = input.filter((value) => !supported.has(value));
  if (unsupported.length > 0) {
    throw new Error(cliText(
      `Unsupported init options: ${unsupported.join(" ")}`,
      `不支持的 init 选项：${unsupported.join(" ")}`,
    ));
  }
  const options = {
    json: input.includes("--json"),
    skipFeishu: input.includes("--skip-feishu"),
    reconfigureFeishu: input.includes("--reconfigure-feishu"),
    reset: input.includes("--reset"),
  };
  if (options.skipFeishu && options.reconfigureFeishu) {
    throw new Error(cliText(
      "--skip-feishu and --reconfigure-feishu cannot be used together.",
      "--skip-feishu 和 --reconfigure-feishu 不能同时使用。",
    ));
  }
  if (options.reset && options.reconfigureFeishu) {
    throw new Error(cliText(
      "--reset cannot be combined with --reconfigure-feishu because reset already replaces Lark credentials.",
      "--reset 不能与 --reconfigure-feishu 同时使用，因为重置已经会替换飞书凭据。",
    ));
  }
  return options;
}
import { cliText } from "./i18n.js";
