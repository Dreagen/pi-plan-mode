import { type ConfigResult, GLOBAL_CONFIG_RELATIVE, LOCAL_CONFIG_RELATIVE } from "./config.ts";
import { checkWriteTarget } from "./paths.ts";
import { BUILTIN_SHELL_COMMANDS, checkShellCommand } from "./shell-policy.ts";

/** Tools that are always permitted: reading, searching, asking the user, web research, subagent bookkeeping. */
export const ALWAYS_ALLOWED_TOOLS: readonly string[] = [
    "read",
    "grep",
    "find",
    "ls",
    "ask_user_question",
    "web_search",
    "url_context",
    "subagents_list",
    "subagent_interrupt",
];

/** Tools with dedicated policies. `allowedTools` can never bypass these. */
export const GUARDED_TOOLS: readonly string[] = ["write", "edit", "bash", "subagent", "subagent_resume"];

export type ToolDecision =
    | { action: "allow"; subagent?: "launch" | "resume" }
    | { action: "block"; message: string };

export interface PolicyContext {
    cwd: string;
    configResult: ConfigResult;
    home?: string;
}

export function describeAllowedDirectories(configResult: ConfigResult): string {
    const { config, error, source } = configResult;
    if (error) {
        return `none (the ${source} plan-mode configuration at ${error.path} is invalid: ${error.message}; fix it and re-enter plan mode with /pm)`;
    }
    if (config.writeDirectories.length > 0) return config.writeDirectories.join(", ");
    if (source === "none") {
        return `none (no configuration found; add "allowedWriteDirectories" to ${LOCAL_CONFIG_RELATIVE} or ~/${GLOBAL_CONFIG_RELATIVE.split("\\").join("/")})`;
    }
    return `none (${configResult.path} allows no write directories)`;
}

function block(message: string): ToolDecision {
    return { action: "block", message: `Blocked by plan mode: ${message}` };
}

const ASK_USER = "Ask the user to run /pm exit or to update the plan-mode configuration if this is intended.";

function evaluateWrite(toolName: string, input: Record<string, unknown>, ctx: PolicyContext): ToolDecision {
    const target = input.path;
    if (typeof target !== "string" || target === "") {
        return block(`${toolName} requires a "path" string.`);
    }
    const dirs = ctx.configResult.config.writeDirectories;
    const check = checkWriteTarget(target, ctx.cwd, dirs, ctx.home);
    if (check.allowed) return { action: "allow" };
    const shown = check.resolved && check.resolved !== target ? `${target} (resolves to ${check.resolved})` : target;
    return block(
        `${toolName} to ${shown} is not permitted because ${check.reason}. ` +
            `Writable directories: ${describeAllowedDirectories(ctx.configResult)}. ${ASK_USER}`,
    );
}

function evaluateBash(input: Record<string, unknown>, ctx: PolicyContext): ToolDecision {
    const command = input.command;
    if (typeof command !== "string") return block('bash requires a "command" string.');
    const decision = checkShellCommand(command, ctx.configResult.config.allowedShellCommands);
    if (decision.allowed) return { action: "allow" };
    return block(
        `the command \`${command}\` is not permitted because ${decision.reason}. ` +
            `Only a vetted set of read-only commands is allowed (${BUILTIN_SHELL_COMMANDS.join(", ")}), ` +
            `without chaining, pipes, redirection or substitution. ${ASK_USER}`,
    );
}

/** Decide whether the parent agent may make this tool call while plan mode is active. */
export function evaluateToolCall(toolName: string, input: Record<string, unknown>, ctx: PolicyContext): ToolDecision {
    switch (toolName) {
        case "write":
        case "edit":
            return evaluateWrite(toolName, input, ctx);
        case "bash":
            return evaluateBash(input, ctx);
        case "subagent":
            return { action: "allow", subagent: "launch" };
        case "subagent_resume":
            return { action: "allow", subagent: "resume" };
    }
    if (ALWAYS_ALLOWED_TOOLS.includes(toolName)) return { action: "allow" };
    if (ctx.configResult.config.allowedTools.includes(toolName)) return { action: "allow" };
    return block(
        `the tool "${toolName}" is not approved for plan mode (it may change state outside the planning directories). ` +
            `${ASK_USER} Tools can be approved with "allowedTools" in the plan-mode configuration.`,
    );
}
