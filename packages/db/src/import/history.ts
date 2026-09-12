import { engineOf, valueAsBigInt, valueAsString } from "../database.js";
import { databaseError } from "../errors.js";
import { PLAN_TABLE } from "../metadata.js";
import {
  parseImportConflicts,
  parseImportDecisions,
  parseImportRecipe,
} from "../validators.js";
import type {
  AppliedImportPlan,
  AppliedImportPlanBinding,
  PreparedImportId,
  PrepareImportOptions,
} from "./types.js";

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw databaseError(
      "DB_CORRUPT_IMPORT_PLAN_HISTORY",
      `The saved import plan has invalid ${label}.`,
      undefined,
      cause,
    );
  }
}

function textField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw databaseError(
      "DB_CORRUPT_IMPORT_PLAN_HISTORY",
      `The saved import plan has an invalid ${field}.`,
      { field },
    );
  }
  return value;
}

function parseBindings(value: unknown): readonly AppliedImportPlanBinding[] {
  if (!Array.isArray(value)) {
    throw databaseError(
      "DB_CORRUPT_IMPORT_PLAN_HISTORY",
      "The saved import plan has invalid source bindings.",
    );
  }
  return value.map((binding) => {
    if (
      typeof binding !== "object" ||
      binding === null ||
      Array.isArray(binding)
    ) {
      throw databaseError(
        "DB_CORRUPT_IMPORT_PLAN_HISTORY",
        "The saved import plan has an invalid source binding.",
      );
    }
    const fields = binding as Record<string, unknown>;
    return {
      source: textField(fields["source"], "source alias"),
      displayName: textField(fields["displayName"], "source filename"),
      selection: textField(fields["selection"], "selection key"),
      label: textField(fields["label"], "selection label"),
      captureId: textField(fields["captureId"], "capture ID"),
    };
  });
}

export async function inspectAppliedImportPlan(options: {
  readonly database: PrepareImportOptions["database"];
  readonly planId: PreparedImportId;
  readonly planRevision: bigint;
}): Promise<AppliedImportPlan | null> {
  const rows = await engineOf(options.database).query(
    `SELECT baseline_revision, state, recipe_json, conflicts_json, decisions_json, bindings_json FROM ${PLAN_TABLE} WHERE plan_id = ? AND plan_revision = ?`,
    [options.planId, options.planRevision],
  );
  const row = rows[0];
  if (row === undefined) return null;
  if (
    rows.length !== 1 ||
    valueAsString(row["state"], "plan state") !== "applied"
  ) {
    throw databaseError(
      "DB_CORRUPT_IMPORT_PLAN_HISTORY",
      "The saved import plan has an invalid state.",
      { planId: options.planId },
    );
  }
  return {
    id: options.planId,
    planRevision: options.planRevision,
    baselineRevision: valueAsBigInt(
      row["baseline_revision"],
      "baseline revision",
    ),
    state: "applied",
    recipe: parseImportRecipe(
      parseJson(valueAsString(row["recipe_json"], "import recipe"), "recipe"),
    ),
    conflicts: parseImportConflicts(
      parseJson(
        valueAsString(row["conflicts_json"], "import conflicts"),
        "conflicts",
      ),
    ),
    decisions: parseImportDecisions(
      parseJson(
        valueAsString(row["decisions_json"], "import decisions"),
        "review decisions",
      ),
    ),
    bindings: parseBindings(
      parseJson(
        valueAsString(row["bindings_json"], "source bindings"),
        "source bindings",
      ),
    ),
  };
}
