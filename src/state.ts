import type { BranchEntry } from "./host.ts";

/** Session entry type used to persist the mode. Namespaced to avoid clashing with other extensions. */
export const STATE_ENTRY_TYPE = "plan-mode:state";

/**
 * Derive whether plan mode is enabled from the active session branch (root to leaf order).
 * The last valid state entry wins; with none, the session is in normal mode.
 * Callers must pass `sessionManager.getBranch()`, never `getEntries()` (which includes
 * abandoned branches).
 */
export function restoreEnabledFromBranch(branch: readonly BranchEntry[]): boolean {
    let enabled = false;
    for (const entry of branch) {
        if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
        const data = entry.data as { enabled?: unknown } | undefined;
        if (data && typeof data.enabled === "boolean") enabled = data.enabled;
    }
    return enabled;
}
