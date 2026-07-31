const TENANT_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
const BOT_INFO_URL = "https://open.feishu.cn/open-apis/bot/v3/info";

interface TenantTokenResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
}

interface BotInfoResponse {
  code?: number;
  msg?: string;
  bot?: {
    open_id?: string;
  };
}

export async function resolveFeishuBotOpenId(
  appId: string,
  appSecret: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  const tokenResponse = await fetchImpl(TENANT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const tokenPayload = await readJson<TenantTokenResponse>(tokenResponse, "get the Lark tenant access token");
  const token = tokenPayload.tenant_access_token;
  if (!tokenResponse.ok || tokenPayload.code !== 0 || !token) {
    throw new Error(`Failed to get the Lark tenant access token: ${responseMessage(tokenPayload, tokenResponse)}`);
  }

  const infoResponse = await fetchImpl(BOT_INFO_URL, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const infoPayload = await readJson<BotInfoResponse>(infoResponse, "get Lark bot information");
  const openId = infoPayload.bot?.open_id;
  if (!infoResponse.ok || infoPayload.code !== 0 || !openId) {
    throw new Error(`Failed to get Lark bot information: ${responseMessage(infoPayload, infoResponse)}`);
  }
  return openId;
}

async function readJson<T>(response: Response, operation: string): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    throw new Error(`Failed to ${operation}: Lark returned an invalid response (HTTP ${response.status}).`);
  }
}

function responseMessage(payload: { msg?: string }, response: Response): string {
  return payload.msg || response.statusText || `HTTP ${response.status}`;
}
