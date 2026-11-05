import { GLOBAL_CONFIG_RELATIVE, LOCAL_CONFIG_RELATIVE, type ConfigResult } from "./config.ts";
import { BUILTIN_SHELL_COMMANDS } from "./shell-policy.ts";

const posix = (path: string) => path.split("\\").join("/");

/** Text for `/planmode help`: commands, what plan mode allows, and how to configure it. */
export function buildHelp(state: { enabled: boolean; configResult: ConfigResult; describeDirectories: () => string }): string {
    const local = posix(LOCAL_CONFIG_RELATIVE);
    const global = `~/${posix(GLOBAL_CONFIG_RELATIVE)}`;
    const lines = [
        "Plan mode: an explicit, read-only mode for planning. Writes are limited to configured directories.",
        "",
        "Commands (/pm is an alias for /planmode):",
        "  /planmode         Enter plan mode (run again to reload the configuration)",
        "  /planmode exit    Leave plan mode and restore normal tool access",
        "  /planmode help    Show this help",
        "",
        "While on:",
        "  - write and edit are allowed only inside allowedWriteDirectories",
        `  - bash is limited to read-only commands: ${BUILTIN_SHELL_COMMANDS.join(", ")}`,
        "  - subagents are launched research-only",
        "",
        "Configuration (optional JSON, both files use the same format):",
        `  Local:  <cwd>/${local}`,
        `  Global: ${global}  (used only when there is no local file)`,
        "",
        "  {",
        '    "allowedWriteDirectories": ["plan/", "docs/plan/", "/absolute/shared-specs/"],',
        '    "allowedTools": ["my_readonly_tool"],',
        '    "allowedShellCommands": ["make -n", "git stash list"]',
        "  }",
        "",
        "  allowedWriteDirectories  Directories where write/edit are allowed (descendants included).",
        "                           Relative entries resolve against the working directory; ~/ and absolute paths work.",
        "  allowedTools             Extra tool names to permit (exact match, no wildcards).",
        "  allowedShellCommands     Extra shell commands. A command that isn't built in matches by argument prefix;",
        "                           built-in ones (such as git) must match exactly.",
        "",
        "  A local file replaces the global one entirely (nothing is merged). Unknown keys are rejected.",
        "  An invalid file fails closed: plan mode stays on with no writable directories.",
        "  Files are read when you enter plan mode; run /planmode again to reload after editing.",
    ];
    lines.push("");
    if (!state.enabled) {
        lines.push("Plan mode is currently off.");
    } else if (state.configResult.error) {
        lines.push(`Current: plan mode is on, but ${state.configResult.path ?? "the configuration"} is invalid: ${state.configResult.error.message}`);
    } else {
        const source = state.configResult.source === "none" ? "no configuration file found" : `${state.configResult.source} configuration: ${state.configResult.path}`;
        lines.push(`Current: plan mode is on (${source}). Writable directories: ${state.describeDirectories()}`);
    }
    return lines.join("\n");
}
