import type { Chrome } from "./chrome.ts";
import { type ConfigResult, emptyConfig, loadConfig } from "./config.ts";
import { buildHelp } from "./help.ts";
import { buildGuidance } from "./guidance.ts";
import type { BeforeAgentStartLike, HostApi, HostCommandContext, HostContext, ToolCallLike } from "./host.ts";
import { restoreEnabledFromBranch, STATE_ENTRY_TYPE } from "./state.ts";
import { augmentSubagentInput } from "./subagent-guard.ts";
import { describeAllowedDirectories, evaluateToolCall } from "./tool-policy.ts";

export const STATUS_KEY = "plan-mode";
export const WIDGET_KEY = "plan-mode";

export const USAGE = "Usage: /planmode (or /pm) to enter plan mode, /planmode exit (or /pm exit) to leave it, /planmode help for configuration help.";

export type ParsedCommand = "enter" | "exit" | "help" | "invalid";

export function parseCommandArgs(args: string): ParsedCommand {
    const trimmed = args.trim().toLowerCase();
    if (trimmed === "") return "enter";
    if (trimmed === "exit") return "exit";
    if (["help", "--help", "-h", "?"].includes(trimmed)) return "help";
    return "invalid";
}

/** Holds the mode for one pi runtime and applies it to the UI, the tool gate and the system prompt. */
export class PlanModeController {
    private enabled = false;
    private configResult: ConfigResult = { config: emptyConfig(), source: "none" };
    private readonly pi: HostApi;
    private readonly home?: string;
    private readonly chrome?: Chrome;

    constructor(pi: HostApi, options: { home?: string; chrome?: Chrome } = {}) {
        this.pi = pi;
        this.home = options.home;
        this.chrome = options.chrome;
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    getConfigResult(): ConfigResult {
        return this.configResult;
    }

    /** Handle `/planmode` and `/pm`. Transitions are applied at an idle boundary. */
    async handleCommand(args: string, ctx: HostCommandContext): Promise<void> {
        const command = parseCommandArgs(args);
        if (command === "invalid") {
            ctx.ui.notify(USAGE, "warning");
            return;
        }
        if (command === "help") {
            // Read-only: needs no idle boundary and changes nothing.
            ctx.ui.notify(
                buildHelp({
                    enabled: this.enabled,
                    configResult: this.configResult,
                    describeDirectories: () => describeAllowedDirectories(this.configResult),
                }),
                "info",
            );
            return;
        }
        await ctx.waitForIdle();
        if (command === "enter") this.enter(ctx);
        else this.exit(ctx);
    }

    private enter(ctx: HostContext): void {
        const wasEnabled = this.enabled;
        this.loadConfiguration(ctx.cwd);
        this.enabled = true;
        if (!wasEnabled) this.pi.appendEntry(STATE_ENTRY_TYPE, { enabled: true });
        this.render(ctx);
        const prefix = wasEnabled ? "Plan mode already enabled (configuration reloaded)." : "Plan mode enabled.";
        this.notifyState(ctx, prefix);
    }

    private exit(ctx: HostContext): void {
        if (!this.enabled) {
            this.render(ctx);
            ctx.ui.notify("Plan mode is already disabled.", "info");
            return;
        }
        this.enabled = false;
        this.pi.appendEntry(STATE_ENTRY_TYPE, { enabled: false });
        this.render(ctx);
        ctx.ui.notify("Plan mode disabled. Normal tool access restored.", "info");
    }

    /** Rebuild state from the active session branch (startup, reload, resume, fork, tree navigation). */
    restore(ctx: HostContext): void {
        this.enabled = restoreEnabledFromBranch(ctx.sessionManager.getBranch());
        if (this.enabled) this.loadConfiguration(ctx.cwd);
        this.render(ctx);
        if (this.enabled && this.configResult.error) {
            ctx.ui.notify(this.errorText(), "error");
        }
    }

    private loadConfiguration(cwd: string): void {
        this.configResult = loadConfig({ cwd, home: this.home });
    }

    private errorText(): string {
        const error = this.configResult.error;
        return error
            ? `Plan-mode configuration error in ${error.path}: ${error.message}. Plan mode stays on with no writable directories; fix the file and run /pm to reload.`
            : "";
    }

    private notifyState(ctx: HostContext, prefix: string): void {
        if (this.configResult.error) {
            ctx.ui.notify(`${prefix} ${this.errorText()}`, "error");
            return;
        }
        const dirs = describeAllowedDirectories(this.configResult);
        const level = this.configResult.config.writeDirectories.length === 0 ? "warning" : "info";
        ctx.ui.notify(`${prefix} Writable directories: ${dirs}. Exit with /pm exit.`, level);
    }

    /** Show or clear this extension's own status and widget only. */
    render(ctx: HostContext): void {
        if (!this.enabled) {
            ctx.ui.setStatus(STATUS_KEY, undefined);
            ctx.ui.setWidget(WIDGET_KEY, undefined);
            this.chrome?.apply(ctx as never, false);
            return;
        }
        // With the chrome installed, `plan` is shown in the footer next to the model instead.
        if (this.chrome) this.chrome.apply(ctx as never, true);
        else ctx.ui.setStatus(STATUS_KEY, "PLAN");
        ctx.ui.setWidget(WIDGET_KEY, this.widgetLines(ctx), { placement: "aboveEditor" });
    }

    private widgetLines(ctx: HostContext): string[] {
        const lines: string[] = [];
        const { error, config } = this.configResult;
        if (error) {
            lines.push(`PLAN MODE: read-only. Configuration error in ${error.path}: ${error.message}`);
            lines.push("No writable directories. Fix the file, then run /pm to reload. Exit: /pm exit");
        } else if (config.writeDirectories.length === 0) {
            lines.push("PLAN MODE: read-only. No writable directories configured (set allowedWriteDirectories in .pi/plan-mode.json).");
            lines.push("Exit: /pm exit");
        } else {
            const dirs = (config.writeDirectoryLabels ?? config.writeDirectories).join(", ");
            lines.push(`PLAN MODE: writes limited to ${ctx.ui.theme?.fg("mdHeading", dirs) ?? dirs}`);
            lines.push("Exit: /pm exit");
        }
        return lines;
    }

    /** `tool_call` gate. Returns a block result, or nothing to allow. */
    onToolCall(event: ToolCallLike, ctx: HostContext): { block: true; reason: string } | undefined {
        if (!this.enabled) return undefined;
        const input = event.input ?? {};
        const decision = evaluateToolCall(event.toolName, input, {
            cwd: ctx.cwd,
            configResult: this.configResult,
            home: this.home,
        });
        if (decision.action === "block") return { block: true, reason: decision.message };
        if (decision.subagent) {
            // Mutates the input in place; pi executes the mutated arguments (they are not revalidated).
            const problem = augmentSubagentInput(decision.subagent, input);
            if (problem) return { block: true, reason: `Blocked by plan mode: ${problem}.` };
        }
        return undefined;
    }

    /** Per-run system prompt addition; nothing persists once the mode is off. */
    onBeforeAgentStart(event: BeforeAgentStartLike): { systemPrompt: string } | undefined {
        if (!this.enabled) return undefined;
        return { systemPrompt: `${event.systemPrompt}\n\n${buildGuidance(this.configResult)}` };
    }
}
