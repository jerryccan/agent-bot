const FEISHU_ACCOUNTS_BASE_URL = "https://accounts.feishu.cn";
const FEISHU_OPEN_BASE_URL = "https://open.feishu.cn";
const APP_REGISTRATION_PATH = "/oauth/v1/app/registration";
const DEFAULT_EXPIRES_IN_SECONDS = 600;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const MAX_POLL_INTERVAL_SECONDS = 60;
const REQUEST_TIMEOUT_MS = 30_000;

export interface FeishuAppRegistrationChallenge {
  verificationUrl: string;
  userCode: string;
  expiresIn: number;
  interval: number;
}

export interface FeishuAppCredentials {
  appId: string;
  appSecret: string;
  userOpenId?: string;
}

export interface FeishuAppRegistrationOptions {
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
  onVerification?: (challenge: FeishuAppRegistrationChallenge) => void | Promise<void>;
}

type RegistrationPayload = Record<string, unknown>;

export async function registerFeishuApp(options: FeishuAppRegistrationOptions = {}): Promise<FeishuAppCredentials> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? delay;
  const begin = await postRegistration(
    fetchImpl,
    {
      action: "begin",
      archetype: "PersonalAgent",
      auth_method: "client_secret",
      request_user_info: "open_id tenant_brand",
    },
    options.signal,
  );
  throwRegistrationError(begin, "无法发起飞书应用创建");

  const deviceCode = readString(begin, "device_code");
  const userCode = readString(begin, "user_code");
  if (!deviceCode || !userCode) {
    throw new Error("飞书应用创建响应缺少 device_code 或 user_code。");
  }

  const expiresIn =
    readPositiveInteger(begin, "expire_in") ?? readPositiveInteger(begin, "expires_in") ?? DEFAULT_EXPIRES_IN_SECONDS;
  const initialInterval = readPositiveInteger(begin, "interval") ?? DEFAULT_POLL_INTERVAL_SECONDS;
  const verificationUrl = readString(begin, "verification_uri_complete") || buildVerificationUrl(userCode);

  await options.onVerification?.({
    verificationUrl,
    userCode,
    expiresIn,
    interval: initialInterval,
  });

  let remainingMs = expiresIn * 1_000;
  let intervalSeconds = initialInterval;
  let waitBeforePoll = false;

  while (remainingMs > 0) {
    if (options.signal?.aborted) throw abortError(options.signal);
    if (waitBeforePoll) {
      const waitMs = Math.min(intervalSeconds * 1_000, remainingMs);
      await sleepWithAbort(sleep, waitMs, options.signal);
      remainingMs -= waitMs;
      if (remainingMs <= 0) break;
    }
    waitBeforePoll = true;

    let payload: RegistrationPayload;
    try {
      payload = await postRegistration(
        fetchImpl,
        {
          action: "poll",
          device_code: deviceCode,
        },
        options.signal,
      );
    } catch (error) {
      if (options.signal?.aborted) throw abortError(options.signal);
      intervalSeconds = Math.min(intervalSeconds + 1, MAX_POLL_INTERVAL_SECONDS);
      continue;
    }

    const errorCode = readString(payload, "error");
    if (!errorCode) {
      const appId = readString(payload, "client_id");
      const appSecret = readString(payload, "client_secret");
      if (appId && appSecret) {
        const userOpenId = readString(readObject(payload, "user_info"), "open_id");
        return {
          appId,
          appSecret,
          ...(userOpenId ? { userOpenId } : {}),
        };
      }
      continue;
    }

    switch (errorCode) {
      case "authorization_pending":
        continue;
      case "slow_down":
        intervalSeconds = Math.min(intervalSeconds + 5, MAX_POLL_INTERVAL_SECONDS);
        continue;
      case "access_denied":
        throw new Error("你已取消飞书应用创建。");
      case "expired_token":
      case "invalid_grant":
        throw new Error("飞书应用创建链接已过期，请重新运行 agent-bot init。");
      default:
        throwRegistrationError(payload, "飞书应用创建失败");
    }
  }

  throw new Error("等待飞书应用创建超时，请重新运行 agent-bot init。");
}

function buildVerificationUrl(userCode: string): string {
  const url = new URL("/page/cli", FEISHU_OPEN_BASE_URL);
  url.searchParams.set("user_code", userCode);
  url.searchParams.set("from", "cli");
  return url.toString();
}

async function postRegistration(
  fetchImpl: typeof globalThis.fetch,
  values: Record<string, string>,
  parentSignal?: AbortSignal,
): Promise<RegistrationPayload> {
  if (parentSignal?.aborted) throw abortError(parentSignal);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("request timeout")), REQUEST_TIMEOUT_MS);
  const onAbort = (): void => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetchImpl(`${FEISHU_ACCOUNTS_BASE_URL}${APP_REGISTRATION_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values),
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => undefined)) as unknown;
    if (!isRecord(payload)) {
      throw new Error(`飞书应用注册接口返回了无法解析的响应（HTTP ${response.status}）。`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", onAbort);
  }
}

function throwRegistrationError(payload: RegistrationPayload, prefix: string): void {
  const code = readString(payload, "error");
  if (!code) return;
  const description = readString(payload, "error_description") || code;
  throw new Error(`${prefix}：${description}`);
}

function readString(value: RegistrationPayload, key: string): string {
  const field = value[key];
  return typeof field === "string" ? field.trim() : "";
}

function readObject(value: RegistrationPayload, key: string): RegistrationPayload {
  const field = value[key];
  return isRecord(field) ? field : {};
}

function readPositiveInteger(value: RegistrationPayload, key: string): number | undefined {
  const field = value[key];
  const parsed = typeof field === "number" ? field : Number(field);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isRecord(value: unknown): value is RegistrationPayload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("飞书应用创建已取消。");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function sleepWithAbort(
  sleep: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    await sleep(milliseconds);
    return;
  }
  if (signal.aborted) throw abortError(signal);

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([sleep(milliseconds), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
