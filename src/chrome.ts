/**
 * Plan-mode "chrome": the parts of pi's UI that change while plan mode is on.
 *
 *  - the footer shows `plan • <model> • <thinking>`, with `plan` in orange
 *
 * pi's themes have no orange role (`warning` is yellow), so the colour is an explicit ANSI value.
 * pi doesn't let an extension decorate the built-in footer, so while plan mode is on a replacement
 * footer is installed that mirrors the built-in one; it is removed again when the mode is left.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

const RESET_FG = "\x1b[39m";

export function orange(text: string): string {
    const truecolor = /truecolor|24bit/i.test(process.env.COLORTERM ?? "");
    const open = truecolor ? "\x1b[38;2;255;140;0m" : "\x1b[38;5;208m";
    return `${open}${text}${RESET_FG}`;
}

export function formatTokens(count: number): string {
    if (count < 1000) return count.toString();
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000) return `${Math.round(count / 1000)}k`;
    return `${(count / 1000000).toFixed(1)}M`;
}

export interface FooterInput {
    width: number;
    cwd: string;
    home?: string;
    branch?: string | null;
    sessionName?: string;
    totals: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
    contextPercent?: number | null;
    contextWindow: number;
    modelId: string;
    reasoning: boolean;
    thinkingLevel: string;
    provider?: string;
    showProvider: boolean;
    statuses: string[];
    dim: (text: string) => string;
    warning: (text: string) => string;
    error: (text: string) => string;
}

/** Same layout as pi's built-in footer, with `plan • ` placed before the model and thinking level. */
export function renderPlanFooter(i: FooterInput): string[] {
    const { width, dim } = i;
    let pwd = i.cwd;
    if (i.home && (pwd === i.home || pwd.startsWith(`${i.home}/`))) pwd = `~${pwd.slice(i.home.length)}`;
    if (i.branch) pwd = `${pwd} (${i.branch})`;
    if (i.sessionName) pwd = `${pwd} • ${i.sessionName}`;

    const parts: string[] = [];
    if (i.totals.input) parts.push(`↑${formatTokens(i.totals.input)}`);
    if (i.totals.output) parts.push(`↓${formatTokens(i.totals.output)}`);
    if (i.totals.cacheRead) parts.push(`R${formatTokens(i.totals.cacheRead)}`);
    if (i.totals.cacheWrite) parts.push(`W${formatTokens(i.totals.cacheWrite)}`);
    if (i.totals.cost) parts.push(`$${i.totals.cost.toFixed(3)}`);

    const percent = i.contextPercent;
    const shown =
        percent === null || percent === undefined
            ? `?/${formatTokens(i.contextWindow)}`
            : `${percent.toFixed(1)}%/${formatTokens(i.contextWindow)}`;
    parts.push(!percent ? shown : percent > 90 ? i.error(shown) : percent > 70 ? i.warning(shown) : shown);

    let left = parts.join(" ");
    if (visibleWidth(left) > width) left = truncateToWidth(left, width, "...");
    const leftWidth = visibleWidth(left);

    // `plan` is coloured after dimming, so it is kept apart from the plain-text model segment.
    const thinking = i.reasoning ? ` • ${i.thinkingLevel === "off" ? "thinking off" : i.thinkingLevel}` : "";
    const model = `${i.modelId}${thinking}`;
    const withProvider = i.showProvider && i.provider ? `(${i.provider}) ${model}` : model;
    const minPadding = 2;
    const sep = " • ";
    const planWidth = "plan".length + sep.length;
    let modelText = leftWidth + minPadding + planWidth + visibleWidth(withProvider) <= width ? withProvider : model;

    let statsLine: string;
    const available = width - leftWidth - minPadding;
    if (available >= planWidth + 1) {
        modelText = truncateToWidth(modelText, available - planWidth, "");
        const pad = " ".repeat(Math.max(0, width - leftWidth - planWidth - visibleWidth(modelText)));
        statsLine = dim(left) + pad + orange("plan") + dim(sep + modelText);
    } else if (available >= 4) {
        statsLine = dim(left) + " ".repeat(width - leftWidth - 4) + orange("plan");
    } else {
        statsLine = dim(left);
    }

    const lines = [truncateToWidth(dim(pwd), width, dim("...")), statsLine];
    if (i.statuses.length > 0) lines.push(truncateToWidth(i.statuses.join(" "), width, dim("...")));
    return lines;
}

/** The subset of pi's contexts that the chrome needs. */
export interface ChromeContext {
    cwd: string;
    model?: { id: string; provider: string; reasoning?: boolean; contextWindow?: number };
    ui: any;
    sessionManager: any;
    getContextUsage?: () => { percent: number | null; contextWindow?: number } | undefined;
}

export interface Chrome {
    apply(ctx: ChromeContext, enabled: boolean): void;
}

function sanitize(text: string): string {
    return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

export function createChrome(pi: { getThinkingLevel?: () => string }): Chrome {
    let installed = false;

    function install(ctx: ChromeContext): void {
        ctx.ui.setFooter?.((_tui: any, theme: any, footerData: any) => {
            let cacheKey = "";
            let totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
            return {
                dispose: footerData.onBranchChange?.(() => _tui.requestRender()),
                invalidate() {},
                render(width: number): string[] {
                    const sm = ctx.sessionManager;
                    const entries: any[] = sm.getEntries();
                    const key = `${sm.getSessionId?.()}:${sm.getLeafId?.()}:${entries.length}`;
                    if (key !== cacheKey) {
                        cacheKey = key;
                        totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
                        for (const e of entries) {
                            const u = e.type === "message" && e.message?.role === "assistant" ? e.message.usage : e.type === "usage" ? e.usage : undefined;
                            if (!u) continue;
                            totals.input += u.input ?? 0;
                            totals.output += u.output ?? 0;
                            totals.cacheRead += u.cacheRead ?? 0;
                            totals.cacheWrite += u.cacheWrite ?? 0;
                            totals.cost += u.cost?.total ?? 0;
                        }
                    }
                    const usage = ctx.getContextUsage?.();
                    const statuses = [...(footerData.getExtensionStatuses?.() ?? new Map<string, string>()).entries()]
                        .sort(([a], [b]) => String(a).localeCompare(String(b)))
                        .map(([, text]) => sanitize(String(text)));
                    return renderPlanFooter({
                        width,
                        cwd: sm.getCwd?.() ?? ctx.cwd,
                        home: process.env.HOME || homedir(),
                        branch: footerData.getGitBranch?.(),
                        sessionName: sm.getSessionName?.(),
                        totals,
                        contextPercent: usage?.percent,
                        contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow ?? 0,
                        modelId: ctx.model?.id ?? "no-model",
                        reasoning: !!ctx.model?.reasoning,
                        thinkingLevel: pi.getThinkingLevel?.() ?? "off",
                        provider: ctx.model?.provider,
                        showProvider: (footerData.getAvailableProviderCount?.() ?? 1) > 1,
                        statuses,
                        dim: (t) => theme.fg("dim", t),
                        warning: (t) => theme.fg("warning", t),
                        error: (t) => theme.fg("error", t),
                    });
                },
            };
        });
        installed = true;
    }

    function uninstall(ctx: ChromeContext): void {
        if (!installed) return;
        ctx.ui.setFooter?.(undefined);
        installed = false;
    }

    return {
        apply(ctx, enabled) {
            if (enabled) install(ctx);
            else uninstall(ctx);
        },
    };
}
