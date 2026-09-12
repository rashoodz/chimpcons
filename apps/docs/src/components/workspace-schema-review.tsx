import type {
  WorkspaceSchemaColumn,
  WorkspaceSchemaPlan,
} from "@/lib/workspace-protocol";

function columnText(column: WorkspaceSchemaColumn): string {
  const type =
    column.type === "decimal"
      ? `decimal(${column.precision}, ${column.scale})`
      : column.type;
  return `${column.name}: ${type}, ${column.nullable ? "optional" : "required"}`;
}

export function WorkspaceSchemaReview({
  plan,
}: {
  readonly plan: WorkspaceSchemaPlan;
}) {
  return (
    <div
      className="mt-4 rounded-lg border p-4"
      data-testid="workspace-schema-review"
    >
      <p className="font-semibold">
        {plan.ready ? "Ready to apply" : "Needs review"}
      </p>
      <p className="mt-1 text-sm text-fd-muted-foreground">
        {plan.changes.length}{" "}
        {plan.changes.length === 1 ? "planned change" : "planned changes"}
      </p>
      {plan.changes.length === 0 ? (
        <p className="mt-3 text-sm">No additive schema changes are needed</p>
      ) : (
        <div className="mt-3 grid gap-3">
          {plan.changes.map((change) =>
            change.kind === "create-table" ? (
              <article
                className="rounded-md border p-3 text-sm"
                data-testid="workspace-schema-change"
                key={`create:${change.table.name}`}
              >
                <h3 className="font-semibold">
                  Create table {change.table.name}
                </h3>
                <p className="mt-2 text-fd-muted-foreground">
                  Record IDs use prefix{" "}
                  {JSON.stringify(change.table.recordId.prefix)}, separator{" "}
                  {JSON.stringify(change.table.recordId.separator)}, and padding{" "}
                  {change.table.recordId.padding}
                </p>
                <h4 className="mt-3 font-medium">Columns</h4>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {change.table.columns.map((column) => (
                    <li key={column.name}>{columnText(column)}</li>
                  ))}
                </ul>
                <h4 className="mt-3 font-medium">Foreign keys</h4>
                {change.table.foreignKeys.length === 0 ? (
                  <p className="mt-1 text-fd-muted-foreground">None</p>
                ) : (
                  <ul className="mt-1 list-disc space-y-1 pl-5">
                    {change.table.foreignKeys.map((foreignKey) => (
                      <li
                        key={`${foreignKey.column}:${foreignKey.referencesTable}`}
                      >
                        {foreignKey.column} references{" "}
                        {foreignKey.referencesTable}.record_id
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            ) : (
              <article
                className="rounded-md border p-3 text-sm"
                data-testid="workspace-schema-change"
                key={`add:${change.table}:${change.column.name}`}
              >
                <h3 className="font-semibold">Add column to {change.table}</h3>
                <p className="mt-2">{columnText(change.column)}</p>
              </article>
            ),
          )}
        </div>
      )}
      {plan.conflicts.length === 0 ? null : (
        <div className="mt-4">
          <h3 className="font-semibold">Conflicts to correct</h3>
          {plan.conflicts.map((conflict) => (
            <p
              className="mt-2 text-sm text-fd-primary"
              key={`${conflict.table}:${conflict.column ?? "table"}`}
            >
              Table {conflict.table}
              {conflict.column === undefined
                ? ""
                : `, column ${conflict.column}`}
              : {conflict.message}
            </p>
          ))}
        </div>
      )}
      <p className="mt-4 text-sm text-fd-muted-foreground">
        {plan.ready
          ? "Confirm these table definitions before applying them to the working database"
          : "Correct the schema document, then review it again before applying"}
      </p>
    </div>
  );
}
