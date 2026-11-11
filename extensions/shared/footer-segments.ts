/**
 * Typed `pi.events` contract for powerline footer segments and background costs.
 *
 * Pi loads each extension with its own module instances, so extensions share
 * footer state through the event bus instead of module-level state.
 *
 *   registerTransientSegment(pi.events, "my-ext", { text: "⟳ loading", bg: "#81c8be", fg: "#232634" });
 *   registerTransientSegment(pi.events, "my-ext", null); // clear
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";

export type TransientSegment = {
  /** Visible text — plain, no ANSI codes. Padded with spaces by the renderer. */
  text: string;
  /** Hex background color for the segment, e.g. "#81c8be". */
  bg: string;
  /** Hex foreground color for the text, e.g. "#232634". */
  fg: string;
};

const SEGMENT_CHANNEL = "footer-segments:segment";
const COST_CHANNEL = "footer-segments:background-cost";

/**
 * Register or clear a transient segment. Segments appear in insertion order,
 * left-to-right, before the built-in right-side segments (context %, time, cost).
 */
export function registerTransientSegment(events: EventBus, key: string, segment: TransientSegment | null): void {
  events.emit(SEGMENT_CHANNEL, { key, segment });
}

/** Register or clear a background task cost for inclusion in the main session cost. */
export function registerBackgroundCost(events: EventBus, key: string, cost: number | null): void {
  events.emit(COST_CHANNEL, { key, cost });
}

export interface FooterSegmentStore {
  readonly segments: ReadonlyMap<string, TransientSegment>;
  backgroundCost(key: string): number;
  dispose(): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const isSegment = (value: unknown): value is TransientSegment =>
  isRecord(value) && typeof value.text === "string" && typeof value.bg === "string" && typeof value.fg === "string";

/** Collect segments and background costs emitted by other extensions. Used by the footer. */
export function createFooterSegmentStore(events: EventBus, onChange: () => void): FooterSegmentStore {
  const segments = new Map<string, TransientSegment>();
  const costs = new Map<string, number>();
  const unsubscribers = [
    events.on(SEGMENT_CHANNEL, (data) => {
      if (!isRecord(data) || typeof data.key !== "string") return;
      if (isSegment(data.segment)) segments.set(data.key, data.segment);
      else if (data.segment !== null || !segments.delete(data.key)) return;
      onChange();
    }),
    events.on(COST_CHANNEL, (data) => {
      if (!isRecord(data) || typeof data.key !== "string") return;
      if (typeof data.cost === "number" && Number.isFinite(data.cost)) costs.set(data.key, data.cost);
      else if (data.cost !== null || !costs.delete(data.key)) return;
      onChange();
    }),
  ];
  return {
    segments,
    backgroundCost: (key) => costs.get(key) ?? 0,
    dispose: () => unsubscribers.forEach((unsubscribe) => unsubscribe()),
  };
}
