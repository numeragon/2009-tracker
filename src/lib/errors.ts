export type ApiErrorKind =
  | "MISSING_API_KEY"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "RATE_LIMIT"
  | "BAD_REQUEST"
  | "NETWORK"
  | "UNKNOWN";

export class ApiClientError extends Error {
  public readonly kind: ApiErrorKind;
  public readonly status?: number;
  public readonly retryable: boolean;

  constructor(kind: ApiErrorKind, message: string, status?: number) {
    super(message);
    this.name = "ApiClientError";
    this.kind = kind;
    this.status = status;
    this.retryable = kind === "RATE_LIMIT" || kind === "NETWORK" || kind === "UNKNOWN";
  }
}

export function normalizeError(err: unknown): ApiClientError {
  if (err instanceof ApiClientError) {
    return err;
  }
  if (err instanceof TypeError) {
    return new ApiClientError(
      "NETWORK",
      "ネットワーク接続に失敗しました。インターネット接続を確認して再試行してください。",
    );
  }
  if (err instanceof Error) {
    return new ApiClientError("UNKNOWN", err.message || "予期しないエラーが発生しました。");
  }
  return new ApiClientError("UNKNOWN", "予期しないエラーが発生しました。");
}
