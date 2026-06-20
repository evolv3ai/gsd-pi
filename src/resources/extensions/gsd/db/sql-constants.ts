// Project/App: gsd-pi
// File Purpose: Shared SQL literal fragments for the single-writer layer.
// Kept out of the barrel surface (imported as values, not re-exported) so it
// stays an implementation detail of the writers.
import { RAW_CLOSED_STATUSES } from "../status-guards.js";

/** Status values that mean a unit is closed; used in ON CONFLICT guards to
 *  prevent an upsert from reopening a completed slice/task. Derived from the
 *  single source `RAW_CLOSED_STATUSES` (ADR-030) so the SQL fragment cannot
 *  drift from `isClosedStatus()`. Renders as `'complete', 'done', 'skipped',
 *  'closed'`. */
export const TERMINAL_STATUS_SQL = RAW_CLOSED_STATUSES.map((s) => `'${s}'`).join(", ");
