export type AppServerRequestId = string | number;

export interface AppServerRequest {
  id: AppServerRequestId;
  method: string;
  params?: unknown;
}

export interface AppServerNotification {
  method: string;
  params?: unknown;
}

export interface AppServerSuccess {
  id: AppServerRequestId;
  result: unknown;
}

export interface AppServerFailure {
  id: AppServerRequestId;
  error: { code: number; message: string; data?: unknown };
}

export type AppServerResponse = AppServerSuccess | AppServerFailure;
export type AppServerMessage = AppServerRequest | AppServerNotification | AppServerResponse;

export function isResponse(message: AppServerMessage): message is AppServerResponse {
  return "id" in message && !("method" in message) && ("result" in message || "error" in message);
}

export function isRequest(message: AppServerMessage): message is AppServerRequest {
  return "id" in message && "method" in message;
}

export function isNotification(message: AppServerMessage): message is AppServerNotification {
  return !("id" in message) && "method" in message;
}
