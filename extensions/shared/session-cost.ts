type Cost = { cost?: { total?: number } };

/** Session entry shape that can carry billed usage. */
export type CostEntry = {
  type?: string;
  message?: { role?: string; usage?: Cost };
  usage?: Cost;
};

/**
 * Total billed cost of session entries: assistant responses plus non-message
 * usage such as cache warming, compaction, and branch summaries.
 */
export function sessionCost(entries: readonly CostEntry[]): number {
  return entries
    .map((entry) => (entry.type === "message" ? entry.message?.usage : entry.usage)?.cost?.total)
    .filter((amount): amount is number => typeof amount === "number" && Number.isFinite(amount))
    .reduce((total, amount) => total + amount, 0);
}
