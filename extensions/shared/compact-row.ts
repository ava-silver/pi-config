/**
 * Marks a custom message component as a compact row, so `output-compaction.ts` stacks it with
 * adjacent compact tool rows. The function reports whether the row is currently collapsed.
 */
export const COMPACT_ROW = Symbol.for("ava.pi.compactRow");

export type CompactRowMarker = { [COMPACT_ROW]?: () => boolean };
