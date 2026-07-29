import fs from "node:fs";
import { fileURLToPath } from "node:url";

export function readPackageVersion(
  packageJsonUrl = new URL("../../package.json", import.meta.url),
): string {
  const metadata = JSON.parse(
    fs.readFileSync(fileURLToPath(packageJsonUrl), "utf8"),
  ) as { version?: unknown };
  if (typeof metadata.version !== "string" || !metadata.version.trim()) {
    throw new Error("package.json 中缺少有效的 version。");
  }
  return metadata.version;
}
