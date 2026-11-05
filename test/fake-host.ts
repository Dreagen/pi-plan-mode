import type { BranchEntry, HostApi, HostCommandContext, HostContext } from "../src/host.ts";

type Handler = (event: any, ctx: any) => any;

export interface UiCall {
    kind: "notify" | "status" | "widget";
    key?: string;
    value?: unknown;
    level?: string;
}

/** Minimal in-memory stand-in for pi's extension API and contexts. */
export class FakeHost {
    handlers = new Map<string, Handler[]>();
    commands = new Map<string, { description?: string; handler: (args: string, ctx: HostCommandContext) => Promise<void> }>();
    entries: Array<{ customType: string; data: unknown }> = [];
    uiCalls: UiCall[] = [];
    statuses = new Map<string, string>();
    widgets = new Map<string, string[]>();
    notifications: Array<{ message: string; level?: string }> = [];
    branch: BranchEntry[] = [];
    idleWaiters: Array<() => void> = [];
    holdIdle = false;
    idleCalls = 0;
    footer: unknown;
    editor: unknown;

    readonly api: HostApi = {
        on: ((event: string, handler: Handler) => {
            const list = this.handlers.get(event) ?? [];
            list.push(handler);
            this.handlers.set(event, list);
        }) as HostApi["on"],
        registerCommand: (name, options) => {
            this.commands.set(name, options);
        },
        appendEntry: (customType, data) => {
            this.entries.push({ customType, data });
            this.branch.push({ type: "custom", customType, data });
        },
    };

    ctx(cwd: string): HostCommandContext {
        const ui = {
            notify: (message: string, level?: "info" | "warning" | "error") => {
                this.notifications.push({ message, level });
                this.uiCalls.push({ kind: "notify", value: message, level });
            },
            setStatus: (key: string, text: string | undefined) => {
                this.uiCalls.push({ kind: "status", key, value: text });
                if (text === undefined) this.statuses.delete(key);
                else this.statuses.set(key, text);
            },
            setFooter: (factory: unknown) => {
                this.footer = factory;
            },
            getEditorComponent: () => this.editor,
            setEditorComponent: (factory: unknown) => {
                this.editor = factory;
            },
            setWidget: (key: string, content: string[] | undefined) => {
                this.uiCalls.push({ kind: "widget", key, value: content });
                if (content === undefined) this.widgets.delete(key);
                else this.widgets.set(key, content);
            },
        };
        return {
            cwd,
            ui,
            sessionManager: { getBranch: () => this.branch },
            waitForIdle: () => {
                this.idleCalls++;
                if (!this.holdIdle) return Promise.resolve();
                return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
            },
        } as HostCommandContext;
    }

    async run(command: string, args: string, cwd: string): Promise<void> {
        const registered = this.commands.get(command);
        if (!registered) throw new Error(`no command ${command}`);
        await registered.handler(args, this.ctx(cwd));
    }

    async emit(event: string, payload: unknown, ctx: HostContext): Promise<unknown[]> {
        const results: unknown[] = [];
        for (const handler of this.handlers.get(event) ?? []) results.push(await handler(payload, ctx));
        return results;
    }
}
