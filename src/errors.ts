export const ERROR_STATUS = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_input: 400,
  conflict: 409,
  rate_limited: 429,
  cap_reached: 429,
  halted: 423,
  secret_detected: 400,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export interface ErrorInfo {
  code: ErrorCode;
  message: string;
}

export class RelayError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RelayError";
  }

  info(): ErrorInfo {
    return { code: this.code, message: this.message };
  }
}

export function fail(code: ErrorCode, message: string): never {
  throw new RelayError(code, message);
}

/**
 * Durable Object RPC methods return an Outcome instead of throwing, because custom
 * error properties (the code) do not survive the RPC boundary.
 */
export type Outcome<T> = { ok: true; result: T } | { ok: false; error: ErrorInfo };

export function unwrap<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new RelayError(outcome.error.code, outcome.error.message);
  return outcome.result;
}

/** Runs fn, turning a thrown RelayError into a failed Outcome. */
export function capture<T>(fn: () => T): Outcome<T> {
  try {
    return { ok: true, result: fn() };
  } catch (err) {
    if (err instanceof RelayError) return { ok: false, error: err.info() };
    throw err;
  }
}
