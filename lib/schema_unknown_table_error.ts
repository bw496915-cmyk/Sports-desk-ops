export class SchemaUnknownTableError extends Error {
  override readonly name = "SchemaUnknownTableError";

  constructor(readonly table: string) {
    super(`unknown table: ${table}`);
  }
}
