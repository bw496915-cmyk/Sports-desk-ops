import type { SchemaValidationIssue } from "./schema_validate.ts";

export class SchemaValidationError extends Error {
  override readonly name = "SchemaValidationError";

  constructor(
    message: string,
    readonly issues: readonly SchemaValidationIssue[],
  ) {
    super(message);
  }

  /** First key → missing column issue (for editor jump). */
  firstKeyUnknownColumn():
    | { table: string; column: string; keyName: string }
    | undefined {
    for (const issue of this.issues) {
      if (
        issue.code === "key_unknown_column" &&
        issue.table !== undefined &&
        issue.column !== undefined &&
        issue.keyName !== undefined
      ) {
        return {
          table: issue.table,
          column: issue.column,
          keyName: issue.keyName,
        };
      }
    }
    return undefined;
  }
}
