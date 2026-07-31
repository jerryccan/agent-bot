import { gzipSync } from "node:zlib";
import type { FeishuAppCredentials } from "./FeishuAppRegistration.js";

const FEISHU_OPEN_BASE_URL = "https://open.feishu.cn";
const TENANT_TOKEN_PATH = "/open-apis/auth/v3/tenant_access_token/internal";
const APPLICATION_PATH_PREFIX = "/open-apis/application/v6/applications";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_COMPLETION_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_OPTIONAL_COMPLETION_TIMEOUT_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

interface ScopeRequirement {
  requested: string;
  accepted: string[];
}

const REQUIRED_SCOPE_REQUIREMENTS: ScopeRequirement[] = [
  {
    requested: "application:application:self_manage",
    accepted: ["application:application:self_manage"],
  },
  {
    requested: "im:chat:create",
    accepted: ["im:chat:create", "im:chat"],
  },
  {
    requested: "im:chat:read",
    accepted: ["im:chat:read", "im:chat:readonly", "im:chat"],
  },
  {
    requested: "im:message.group_at_msg:readonly",
    accepted: [
      "im:message.group_at_msg:readonly",
      "im:message.group_at_msg.include_bot:readonly",
      "im:message.group_at_msg",
      "im:message.group_msg:readonly",
      "im:message.group_msg",
    ],
  },
  {
    requested: "im:message.p2p_msg:readonly",
    accepted: ["im:message.p2p_msg:readonly", "im:message.p2p_msg"],
  },
  {
    requested: "im:message.reactions:write_only",
    accepted: ["im:message.reactions:write_only", "im:message"],
  },
  {
    requested: "im:message:readonly",
    accepted: ["im:message:readonly", "im:message.history:readonly", "im:message"],
  },
  {
    requested: "im:message:send_as_bot",
    accepted: ["im:message:send_as_bot", "im:message:send", "im:message"],
  },
  {
    requested: "im:message:update",
    accepted: ["im:message:update", "im:message:send_as_bot", "im:message"],
  },
  {
    requested: "im:resource",
    accepted: ["im:resource", "im:resource:upload"],
  },
];

export const REQUIRED_FEISHU_SCOPES = REQUIRED_SCOPE_REQUIREMENTS.map((requirement) => requirement.requested);
export const REQUIRED_FEISHU_EVENTS = ["im.message.receive_v1", "im.chat.updated_v1"] as const;
export const REQUIRED_FEISHU_CALLBACKS = ["card.action.trigger"] as const;

const CORE_FEISHU_SCOPES = new Set([
  "application:application:self_manage",
  "im:message.group_at_msg:readonly",
  "im:message.p2p_msg:readonly",
  "im:message:send_as_bot",
]);
const CORE_FEISHU_EVENTS = new Set<string>(["im.message.receive_v1"]);

export interface FeishuAppConfiguration {
  scopes: string[];
  events: string[];
  callbacks: string[];
}

export interface MissingFeishuAppConfiguration {
  scopes: string[];
  events: string[];
  callbacks: string[];
}

export interface FeishuConfigurationChallenge {
  verificationUrl: string;
  missing: MissingFeishuAppConfiguration;
  blocking: boolean;
}

export interface EnsureFeishuAppConfigurationOptions {
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
  optionalSkipSignal?: AbortSignal;
  pollIntervalMs?: number;
  timeoutMs?: number;
  optionalTimeoutMs?: number;
  onVerification?: (challenge: FeishuConfigurationChallenge) => void | Promise<void>;
}

export interface EnsureFeishuAppConfigurationResult {
  status: "ready" | "updated" | "partial";
  configuration: FeishuAppConfiguration;
  added: MissingFeishuAppConfiguration;
  remaining: MissingFeishuAppConfiguration;
}

type JsonObject = Record<string, unknown>;

export async function ensureFeishuAppConfiguration(
  credentials: FeishuAppCredentials,
  options: EnsureFeishuAppConfigurationOptions = {},
): Promise<EnsureFeishuAppConfigurationResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? delay;
  const pollIntervalMs = positiveInteger(options.pollIntervalMs) ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = positiveInteger(options.timeoutMs) ?? DEFAULT_COMPLETION_TIMEOUT_MS;
  const optionalTimeoutMs = positiveInteger(options.optionalTimeoutMs)
    ?? DEFAULT_OPTIONAL_COMPLETION_TIMEOUT_MS;

  let configuration: FeishuAppConfiguration;
  try {
    configuration = await readFeishuAppConfiguration(credentials, fetchImpl, options.signal);
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    configuration = emptyConfiguration();
  }

  const missing = missingFeishuAppConfiguration(configuration);
  if (!hasMissingConfiguration(missing)) {
    return {
      status: "ready",
      configuration,
      added: emptyConfiguration(),
      remaining: emptyConfiguration(),
    };
  }

  const coreMissing = coreMissingFeishuAppConfiguration(missing);
  if (!hasMissingConfiguration(coreMissing)) {
    return completeOptionalFeishuConfiguration(
      credentials,
      configuration,
      missing,
      fetchImpl,
      sleep,
      pollIntervalMs,
      optionalTimeoutMs,
      options,
    );
  }

  await requestMissingFeishuConfiguration(credentials.appId, coreMissing, true, options.onVerification);

  let remainingMs = timeoutMs;
  let lastError: unknown;
  while (remainingMs > 0) {
    const waitMs = Math.min(pollIntervalMs, remainingMs);
    await sleepWithAbort(sleep, waitMs, options.signal);
    remainingMs -= waitMs;

    try {
      configuration = await readFeishuAppConfiguration(credentials, fetchImpl, options.signal);
      const remaining = missingFeishuAppConfiguration(configuration);
      if (!hasMissingConfiguration(coreMissingFeishuAppConfiguration(remaining))) {
        return completeOptionalFeishuConfiguration(
          credentials,
          configuration,
          missing,
          fetchImpl,
          sleep,
          pollIntervalMs,
          optionalTimeoutMs,
          options,
        );
      }
      lastError = undefined;
    } catch (error) {
      if (options.signal?.aborted) throw abortError(options.signal);
      lastError = error;
    }
  }

  const detail = lastError instanceof Error ? ` Last check failed: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for the core Lark scopes and message event. Run agent-bot init again.${detail}`);
}

async function requestMissingFeishuConfiguration(
  appId: string,
  missing: MissingFeishuAppConfiguration,
  blocking: boolean,
  onVerification: EnsureFeishuAppConfigurationOptions["onVerification"],
): Promise<void> {
  const verificationUrl = buildFeishuConfigurationUrl(appId, missing);
  await onVerification?.({ verificationUrl, missing, blocking });
}

async function completeOptionalFeishuConfiguration(
  credentials: FeishuAppCredentials,
  initialConfiguration: FeishuAppConfiguration,
  initialMissing: MissingFeishuAppConfiguration,
  fetchImpl: typeof globalThis.fetch,
  sleep: (milliseconds: number) => Promise<void>,
  pollIntervalMs: number,
  timeoutMs: number,
  options: EnsureFeishuAppConfigurationOptions,
): Promise<EnsureFeishuAppConfigurationResult> {
  let configuration = initialConfiguration;
  let remaining = missingFeishuAppConfiguration(configuration);
  if (hasMissingConfiguration(remaining)) {
    await requestMissingFeishuConfiguration(
      credentials.appId,
      remaining,
      false,
      options.onVerification,
    );
    if (!options.optionalSkipSignal?.aborted) {
      const completed = await waitForOptionalFeishuConfiguration(
        credentials,
        configuration,
        fetchImpl,
        sleep,
        pollIntervalMs,
        timeoutMs,
        options.signal,
        options.optionalSkipSignal,
      );
      configuration = completed.configuration;
      remaining = completed.remaining;
    }
  }
  return {
    status: hasMissingConfiguration(remaining) ? "partial" : "updated",
    configuration,
    added: resolvedMissingConfiguration(initialMissing, remaining),
    remaining,
  };
}

async function waitForOptionalFeishuConfiguration(
  credentials: FeishuAppCredentials,
  initialConfiguration: FeishuAppConfiguration,
  fetchImpl: typeof globalThis.fetch,
  sleep: (milliseconds: number) => Promise<void>,
  pollIntervalMs: number,
  timeoutMs: number,
  signal?: AbortSignal,
  optionalSkipSignal?: AbortSignal,
): Promise<{
  configuration: FeishuAppConfiguration;
  remaining: MissingFeishuAppConfiguration;
}> {
  let configuration = initialConfiguration;
  let remaining = missingFeishuAppConfiguration(configuration);
  let remainingMs = timeoutMs;
  while (remainingMs > 0 && hasMissingConfiguration(remaining)) {
    if (optionalSkipSignal?.aborted) break;
    const waitMs = Math.min(pollIntervalMs, remainingMs);
    const waitResult = await sleepWithOptionalSkip(
      sleep,
      waitMs,
      signal,
      optionalSkipSignal,
    );
    if (waitResult === "skipped") break;
    remainingMs -= waitMs;
    try {
      configuration = await readFeishuAppConfiguration(credentials, fetchImpl, signal);
      remaining = missingFeishuAppConfiguration(configuration);
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
    }
  }
  return { configuration, remaining };
}

async function sleepWithOptionalSkip(
  sleep: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  signal?: AbortSignal,
  optionalSkipSignal?: AbortSignal,
): Promise<"elapsed" | "skipped"> {
  if (!optionalSkipSignal) {
    await sleepWithAbort(sleep, milliseconds, signal);
    return "elapsed";
  }
  if (optionalSkipSignal.aborted) return "skipped";

  let onSkip: (() => void) | undefined;
  const skipped = new Promise<"skipped">((resolve) => {
    onSkip = () => resolve("skipped");
    optionalSkipSignal.addEventListener("abort", onSkip, { once: true });
  });
  try {
    return await Promise.race([
      sleepWithAbort(sleep, milliseconds, signal).then(() => "elapsed" as const),
      skipped,
    ]);
  } finally {
    if (onSkip) optionalSkipSignal.removeEventListener("abort", onSkip);
  }
}

export function missingFeishuAppConfiguration(configuration: FeishuAppConfiguration): MissingFeishuAppConfiguration {
  const scopes = new Set(configuration.scopes);
  const events = new Set(configuration.events);
  const callbacks = new Set(configuration.callbacks);
  return {
    scopes: REQUIRED_SCOPE_REQUIREMENTS.filter(
      (requirement) => !requirement.accepted.some((scope) => scopes.has(scope)),
    ).map((requirement) => requirement.requested),
    events: REQUIRED_FEISHU_EVENTS.filter((event) => !events.has(event)),
    callbacks: REQUIRED_FEISHU_CALLBACKS.filter((callback) => !callbacks.has(callback)),
  };
}

export function buildFeishuConfigurationUrl(appId: string, missing: MissingFeishuAppConfiguration): string {
  const manifest: JsonObject = {};
  if (missing.scopes.length > 0) {
    manifest.scopes = {
      tenant: missing.scopes,
      user: [],
    };
  }
  if (missing.events.length > 0) {
    manifest.events = {
      items: {
        tenant: missing.events,
        user: [],
      },
    };
  }
  if (missing.callbacks.length > 0) {
    manifest.callbacks = {
      items: missing.callbacks,
    };
  }

  const encoded = gzipSync(Buffer.from(JSON.stringify(manifest), "utf8")).toString("base64url");
  const url = new URL("/page/launcher", FEISHU_OPEN_BASE_URL);
  url.searchParams.set("clientID", appId);
  url.searchParams.set("addons", encoded);
  return url.toString();
}

async function readFeishuAppConfiguration(
  credentials: FeishuAppCredentials,
  fetchImpl: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<FeishuAppConfiguration> {
  const token = await getTenantAccessToken(credentials, fetchImpl, signal);
  const appId = encodeURIComponent(credentials.appId);
  const headers = { Authorization: `Bearer ${token}` };
  const [application, versions] = await Promise.all([
    fetchJson(
      fetchImpl,
      `${FEISHU_OPEN_BASE_URL}${APPLICATION_PATH_PREFIX}/${appId}?lang=zh_cn`,
      { headers },
      signal,
      "Read Lark app configuration",
    ),
    fetchJson(
      fetchImpl,
      `${FEISHU_OPEN_BASE_URL}${APPLICATION_PATH_PREFIX}/${appId}/app_versions?lang=zh_cn&page_size=2`,
      { headers },
      signal,
      "Read Lark app versions",
    ),
  ]);

  const app = readObject(readObject(application, "data"), "app");
  const callbackInfo = readObject(app, "callback_info");
  const callbacks = readStringArray(callbackInfo, "subscribed_callbacks");
  const publishedVersion = readArray(readObject(versions, "data"), "items")
    .filter(isJsonObject)
    .find((item) => readNumber(item, "status") === 1 && hasPublishTime(item.publish_time));
  const scopes = publishedVersion
    ? readArray(publishedVersion, "scopes")
        .filter(isJsonObject)
        .filter((item) => readStringArray(item, "token_types").includes("tenant"))
        .map((item) => readString(item, "scope"))
        .filter(Boolean)
    : [];
  const events = publishedVersion
    ? readArray(publishedVersion, "event_infos")
        .filter(isJsonObject)
        .map((item) => readString(item, "event_type"))
        .filter(Boolean)
    : [];

  return {
    scopes: uniqueSorted(scopes),
    events: uniqueSorted(events),
    callbacks: uniqueSorted(callbacks),
  };
}

async function getTenantAccessToken(
  credentials: FeishuAppCredentials,
  fetchImpl: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<string> {
  const payload = await fetchJson(
    fetchImpl,
    `${FEISHU_OPEN_BASE_URL}${TENANT_TOKEN_PATH}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        app_id: credentials.appId,
        app_secret: credentials.appSecret,
      }),
    },
    signal,
    "Get the Lark tenant_access_token",
  );
  const token = readString(payload, "tenant_access_token");
  if (!token) throw new Error("The Lark tenant_access_token response is missing the access token.");
  return token;
}

async function fetchJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  parentSignal: AbortSignal | undefined,
  operation: string,
): Promise<JsonObject> {
  if (parentSignal?.aborted) throw abortError(parentSignal);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("request timeout")), REQUEST_TIMEOUT_MS);
  const onAbort = (): void => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const payload = (await response.json().catch(() => undefined)) as unknown;
    if (!isJsonObject(payload)) {
      throw new Error(`${operation} returned an invalid response (HTTP ${response.status}).`);
    }
    const code = readNumber(payload, "code");
    if (!response.ok || code !== 0) {
      throw new FeishuConfigurationApiError(
        `${operation} failed: ${readString(payload, "msg") || response.statusText || `HTTP ${response.status}`}`,
        code,
        response.status,
      );
    }
    return payload;
  } catch (error) {
    if (parentSignal?.aborted) throw abortError(parentSignal);
    if (controller.signal.aborted) throw new Error(`${operation} timed out.`);
    throw error;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", onAbort);
  }
}

class FeishuConfigurationApiError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly status: number,
  ) {
    super(message);
  }
}

function isPermissionError(error: unknown): boolean {
  return (
    error instanceof FeishuConfigurationApiError &&
    (error.status === 403 ||
      error.code === 99991672 ||
      error.code === 99991676 ||
      /permission|scope|权限/i.test(error.message))
  );
}

function hasMissingConfiguration(missing: MissingFeishuAppConfiguration): boolean {
  return missing.scopes.length > 0 || missing.events.length > 0 || missing.callbacks.length > 0;
}

function coreMissingFeishuAppConfiguration(missing: MissingFeishuAppConfiguration): MissingFeishuAppConfiguration {
  return {
    scopes: missing.scopes.filter((scope) => CORE_FEISHU_SCOPES.has(scope)),
    events: missing.events.filter((event) => CORE_FEISHU_EVENTS.has(event)),
    callbacks: [],
  };
}

function resolvedMissingConfiguration(
  initial: MissingFeishuAppConfiguration,
  remaining: MissingFeishuAppConfiguration,
): MissingFeishuAppConfiguration {
  const remainingScopes = new Set(remaining.scopes);
  const remainingEvents = new Set(remaining.events);
  const remainingCallbacks = new Set(remaining.callbacks);
  return {
    scopes: initial.scopes.filter((scope) => !remainingScopes.has(scope)),
    events: initial.events.filter((event) => !remainingEvents.has(event)),
    callbacks: initial.callbacks.filter((callback) => !remainingCallbacks.has(callback)),
  };
}

function emptyConfiguration(): FeishuAppConfiguration {
  return { scopes: [], events: [], callbacks: [] };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function hasPublishTime(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function readObject(value: JsonObject, key: string): JsonObject {
  const field = value[key];
  return isJsonObject(field) ? field : {};
}

function readArray(value: JsonObject, key: string): unknown[] {
  const field = value[key];
  return Array.isArray(field) ? field : [];
}

function readStringArray(value: JsonObject, key: string): string[] {
  return readArray(value, key)
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readString(value: JsonObject, key: string): string {
  const field = value[key];
  return typeof field === "string" ? field.trim() : "";
}

function readNumber(value: JsonObject, key: string): number {
  const field = value[key];
  return typeof field === "number" ? field : Number(field);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: number | undefined): number | undefined {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : undefined;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Lark app configuration was cancelled.");
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
