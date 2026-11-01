#!/usr/bin/env bun
/** Back-compat alias for `capture:batch-pending-delete`. */
import { main } from "./batch_pending_delete_session.ts";

process.exit(await main());
