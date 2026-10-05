export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

export type ErrorCode =
  | "UNKNOWN_OP"
  | "UNKNOWN_CALLBACK"
  | "NEGATIVE_DELAY"
  | "BAD_PARAM"
  | "LABEL_CONFLICT"
  | "UNKNOWN_LABEL"
  | "SCENARIO_FROZEN"
  | "SCENARIO_NOT_FOUND"
  | "BAD_SPEC"
  | "BAD_SCENARIO_NAME"
  | "ALREADY_FINISHED"
  | "BUDGET_EXHAUSTED"
  | "MISSING_FIELD";

export function fail(code: ErrorCode, message: string, details?: unknown): never {
  throw new AppError(code, message, details);
}
