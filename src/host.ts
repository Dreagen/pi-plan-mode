/**
 * The small slice of pi's extension API that this extension uses, declared structurally so the
 * pure logic can be tested without pi installed. pi's real `ExtensionAPI` / contexts satisfy
 * these shapes (checked against pi 1.5.0 in the manual verification checklist).
 */

export interface HostUi {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
    setWidget(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
}

export interface BranchEntry {
    type: string;
    customType?: string;
    data?: unknown;
}

export interface HostContext {
    cwd: string;
    ui: HostUi;
    sessionManager: { getBranch(): BranchEntry[] };
}

export interface HostCommandContext extends HostContext {
    waitForIdle(): Promise<void>;
}

export interface ToolCallLike {
    toolName: string;
    input: Record<string, unknown>;
}

export interface BeforeAgentStartLike {
    systemPrompt: string;
}

export interface HostApi {
    on(event: "session_start", handler: (event: { reason?: string }, ctx: HostContext) => void | Promise<void>): unknown;
    on(event: "session_tree", handler: (event: unknown, ctx: HostContext) => void | Promise<void>): unknown;
    on(
        event: "tool_call",
        handler: (event: ToolCallLike, ctx: HostContext) => { block: true; reason: string } | void | Promise<{ block: true; reason: string } | void>,
    ): unknown;
    on(
        event: "before_agent_start",
        handler: (event: BeforeAgentStartLike, ctx: HostContext) => { systemPrompt: string } | void | Promise<{ systemPrompt: string } | void>,
    ): unknown;
    registerCommand(
        name: string,
        options: { description?: string; handler: (args: string, ctx: HostCommandContext) => Promise<void> },
    ): void;
    appendEntry(customType: string, data?: unknown): void;
    getThinkingLevel?(): string;
}
