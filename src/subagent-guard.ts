/**
 * Plan-mode instructions for research subagents.
 *
 * Children run as separate pi processes. They do not inherit the parent's mode, tool gate or
 * writable directories, and the installed subagent extension offers no enforcement hook. The
 * only reliable channel is the text of the launch `task` (or the resume `message`), so these
 * restrictions are instruction-based and NOT enforced.
 */

export const RESEARCH_BLOCK_START = "<plan-mode-research-restrictions>";
export const RESEARCH_BLOCK_END = "</plan-mode-research-restrictions>";

export const RESEARCH_BLOCK = [
    RESEARCH_BLOCK_START,
    "The parent session is in PLAN MODE. These restrictions apply to you, and they are not technically enforced, so you must follow them yourself:",
    "- Perform research only. Do not implement, fix, refactor or otherwise change the project.",
    "- You may read files, search, and use research tools (including web research) as needed.",
    "- Write temporary files or reports only under /tmp/, preferably in a dedicated subdirectory such as /tmp/plan-research-<topic>/.",
    "- Keep the write side effects of research commands (caches, build output, scratch clones, logs) within /tmp/.",
    "- Do not modify project files or write anywhere else. A symlink under /tmp/ is not permission to write outside /tmp/.",
    "- Do not perform external mutations: no pushes, deployments, issue or ticket changes, or writes to remote services.",
    "- Return your findings in your final response, and mention any temporary artifacts you created and where.",
    "- If you delegate further work (subagents or resumed sessions), pass these same restrictions on in that task.",
    RESEARCH_BLOCK_END,
].join("\n");

export type SubagentKind = "launch" | "resume";

/** Append the research block once. Existing text is preserved verbatim. */
export function withResearchBlock(text: string | undefined): string {
    if (text === undefined || text.trim() === "") return RESEARCH_BLOCK;
    if (text.includes(RESEARCH_BLOCK)) return text;
    return `${text.replace(/\s+$/, "")}\n\n${RESEARCH_BLOCK}`;
}

/**
 * Add the research restrictions to a `subagent` launch (`task`) or a `subagent_resume`
 * follow-up (`message`) by mutating `input` in place. Returns an error message when the field
 * is unusable, in which case the call must be blocked rather than sent without instructions.
 */
export function augmentSubagentInput(kind: SubagentKind, input: Record<string, unknown>): string | undefined {
    const field = kind === "launch" ? "task" : "message";
    const current = input[field];
    if (current !== undefined && typeof current !== "string") {
        return `the subagent "${field}" must be a string so plan-mode research restrictions can be attached`;
    }
    if (kind === "launch" && current === undefined) {
        return 'the subagent "task" is missing, so plan-mode research restrictions cannot be attached';
    }
    input[field] = withResearchBlock(current as string | undefined);
    return undefined;
}
