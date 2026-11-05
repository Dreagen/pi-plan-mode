import type { ConfigResult } from "./config.ts";
import { describeAllowedDirectories } from "./tool-policy.ts";
import { BUILTIN_SHELL_COMMANDS } from "./shell-policy.ts";

/** System-prompt addition injected for each agent run while plan mode is active. */
export function buildGuidance(configResult: ConfigResult): string {
    const dirs = describeAllowedDirectories(configResult);
    return [
        "# Plan mode is ACTIVE",
        "",
        "The user has put this session in plan mode. Your job is to research and plan, not to implement.",
        "",
        "- You may research freely: read files, search, browse the web, ask the user questions, and use research subagents.",
        `- You may create and maintain planning documents ONLY inside the writable directories: ${dirs}.`,
        "- Do NOT implement changes anywhere else. Writes outside those directories are blocked.",
        `- Shell commands are limited to a vetted set of read-only commands (${BUILTIN_SHELL_COMMANDS.join(", ")}), with no chaining, pipes, redirection or substitution. Use the write and edit tools, not the shell, to write planning documents.`,
        "- Tools not approved for plan mode (anything that changes external systems, such as creating issues or deploying) are blocked.",
        "- Research subagents are allowed. Their read-only behaviour is instruction-based and not enforced, so give them research-only tasks and never delegate implementation.",
        "- If a call is blocked, do not look for a workaround. Explain what you wanted to do and ask the user.",
        "- Do not exit plan mode yourself; only the user does (/pm exit). Do not begin implementing a plan unless the user explicitly asks after exiting.",
    ].join("\n");
}
