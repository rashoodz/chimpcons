import { databaseError } from "../errors.js";
import type { DeliveryContext } from "../import/types.js";
import { parseDeliveryContext } from "../validators.js";

export function parseStoredDeliveryContext(value: unknown): DeliveryContext {
  try {
    if (typeof value !== "string") throw new Error("Expected stored JSON text");
    const parsed: unknown = JSON.parse(value);
    return parseDeliveryContext(parsed);
  } catch (cause) {
    throw databaseError(
      "DB_CORRUPT_DATABASE",
      "The recorded delivery details are damaged. Restore a verified database copy before retrying.",
      undefined,
      cause,
    );
  }
}
