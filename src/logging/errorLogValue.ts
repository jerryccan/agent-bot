export interface ErrorLogValue {
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
  errors?: unknown[];
  [key: string]: unknown;
}

export function errorLogValue(error: unknown): unknown {
  if (!(error instanceof Error)) return error;

  const value: ErrorLogValue = {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
  };

  for (const [key, detail] of Object.entries(error)) {
    value[key] = detail instanceof Error ? errorLogValue(detail) : detail;
  }
  if (error.cause !== undefined) value.cause = errorLogValue(error.cause);
  if (error instanceof AggregateError) value.errors = [...error.errors].map(errorLogValue);

  return value;
}
