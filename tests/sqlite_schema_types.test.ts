import type { Assert, Equal } from "../lib/assert.ts";
import type { IsoTime } from "../lib/brand.ts";
import type { ParseKeyRole } from "../lib/key_role.ts";
import type { ColumnName, PkColumn, Row } from "../lib/sqlite_schema_derive.ts";
import type { AssertSsotClean } from "../lib/sqlite_schema_ssot.ts";

type _ssotClean = AssertSsotClean;

type _pk = Assert<Equal<PkColumn<"match_evaluations">, "id">>;

type _runAt = Assert<Equal<Row<"match_evaluations">["run_at"], IsoTime>>;

type _valid = Assert<
  Equal<Row<"match_evaluations">["valid_time"], IsoTime | null>
>;

type _noRunAt = Assert<
  Equal<ColumnName<"candidate_tickets"> & "run_at", never>
>;

type _idxName = Assert<
  Equal<
    ParseKeyRole<"IDX:idx_match_eval_run_at">,
    { readonly type: "index"; readonly name: "idx_match_eval_run_at" }
  >
>;
