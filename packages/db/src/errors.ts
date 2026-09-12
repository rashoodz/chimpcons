import { ConsultChimpsError } from "@consultchimps/core";

export function databaseError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  cause?: unknown,
): ConsultChimpsError {
  return new ConsultChimpsError(code, message, {
    ...(cause === undefined ? {} : { cause }),
    ...(details === undefined ? {} : { details }),
  });
}

export function assertOpen(open: boolean): void {
  if (!open) {
    throw databaseError(
      "DB_CLOSED",
      "The database is closed. Open it again before running another operation.",
    );
  }
}
