import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PlanModeController, USAGE, parseCommandArgs, STATUS_KEY, WIDGET_KEY } from "../src/controller.ts";
import { STATE_ENTRY_TYPE } from "../src/state.ts";
import { FakeHost } from "./fake-host.ts";
import { makeTempDir, writeFile } from "./helpers.ts";

function setup(configJson?: unknown) {
    const root = makeTempDir();
    const cwd = join(root, "project");
    const home = join(root, "home");
    mkdirSync(join(cwd, "plan"), { recursive: true });
    mkdirSync(home, { recursive: true });
    if (configJson !== undefined) {
        writeFile(join(cwd, ".pi", "plan-mode.json"), typeof configJson === "string" ? configJson : JSON.stringify(configJson));
    }
    const host = new FakeHost();
    const controller = new PlanModeController(host.api, { home });
    const run = (args: string) => controller.handleCommand(args, host.ctx(cwd));
    return { root, cwd, home, host, controller, run, ctx: host.ctx(cwd) };
}

describe("parseCommandArgs", () => {
    it("recognises enter, exit and invalid arguments", () => {
        assert.equal(parseCommandArgs(""), "enter");
        assert.equal(parseCommandArgs("   "), "enter");
        assert.equal(parseCommandArgs("exit"), "exit");
        assert.equal(parseCommandArgs("  EXIT "), "exit");
        assert.equal(parseCommandArgs("off"), "invalid");
        assert.equal(parseCommandArgs("exit now"), "invalid");
        assert.equal(parseCommandArgs("toggle"), "invalid");
    });
});

describe("entering and exiting", () => {
    it("shows the PLAN status, a widget with the writable directories and exit instruction, and notifies", async () => {
        const { host, run, cwd } = setup({ allowedWriteDirectories: ["plan/", "docs/plan/"] });
        await run("");
        assert.equal(host.statuses.get(STATUS_KEY), "PLAN");
        const widget = host.widgets.get(WIDGET_KEY)?.join("\n") ?? "";
        assert.ok(widget.includes(join(cwd, "plan")));
        assert.ok(widget.includes(join(cwd, "docs", "plan")));
        assert.match(widget, /\/pm exit/);
        assert.equal(host.notifications.length, 1);
        assert.match(host.notifications[0].message, /Plan mode enabled/);
        assert.equal(host.notifications[0].level, "info");
        assert.deepEqual(host.entries, [{ customType: STATE_ENTRY_TYPE, data: { enabled: true } }]);
    });

    it("removes status and widget on exit and notifies", async () => {
        const { host, run } = setup({ allowedWriteDirectories: ["plan/"] });
        await run("");
        await run("exit");
        assert.equal(host.statuses.size, 0);
        assert.equal(host.widgets.size, 0);
        assert.match(host.notifications.at(-1)?.message ?? "", /Plan mode disabled/);
        assert.deepEqual(host.entries.at(-1), { customType: STATE_ENTRY_TYPE, data: { enabled: false } });
    });

    it("is idempotent: entering twice and exiting twice add no extra state entries", async () => {
        const { host, run, controller } = setup({ allowedWriteDirectories: ["plan/"] });
        await run("");
        await run("");
        assert.equal(controller.isEnabled(), true);
        assert.equal(host.entries.length, 1);
        assert.match(host.notifications[1].message, /already enabled/);
        await run("exit");
        await run("exit");
        assert.equal(controller.isEnabled(), false);
        assert.equal(host.entries.length, 2);
        assert.match(host.notifications[3].message, /already disabled/);
    });

    it("exiting while already disabled stays disabled and writes nothing", async () => {
        const { host, run, controller } = setup();
        await run("exit");
        assert.equal(controller.isEnabled(), false);
        assert.equal(host.entries.length, 0);
    });

    it("shows usage for unrecognised arguments without changing state", async () => {
        const { host, run, controller } = setup();
        await run("bogus");
        assert.equal(controller.isEnabled(), false);
        assert.deepEqual(host.notifications, [{ message: USAGE, level: "warning" }]);
        await run("");
        await run("bogus");
        assert.equal(controller.isEnabled(), true);
        assert.equal(host.entries.length, 1);
    });

    it("applies the transition only after the agent is idle", async () => {
        const { host, run, controller } = setup({ allowedWriteDirectories: ["plan/"] });
        host.holdIdle = true;
        const pending = run("");
        await Promise.resolve();
        assert.equal(controller.isEnabled(), false);
        assert.equal(host.statuses.size, 0);
        host.idleWaiters.forEach((resolve) => resolve());
        await pending;
        assert.equal(controller.isEnabled(), true);
        assert.equal(host.idleCalls, 1);
    });

    it("re-running /pm while enabled reloads the configuration", async () => {
        const { host, run, cwd, controller } = setup({ allowedWriteDirectories: ["plan/"] });
        await run("");
        writeFile(join(cwd, ".pi", "plan-mode.json"), JSON.stringify({ allowedWriteDirectories: ["docs/"] }));
        await run("");
        assert.deepEqual(controller.getConfigResult().config.writeDirectories, [join(cwd, "docs")]);
        assert.ok((host.widgets.get(WIDGET_KEY) ?? []).join("\n").includes(join(cwd, "docs")));
    });

    it("only touches this extension's own status and widget keys", async () => {
        const { host, run } = setup({ allowedWriteDirectories: ["plan/"] });
        await run("");
        await run("exit");
        const keys = host.uiCalls.filter((c) => c.kind !== "notify").map((c) => c.key);
        assert.ok(keys.length > 0);
        assert.ok(keys.every((k) => k === STATUS_KEY || k === WIDGET_KEY));
    });
});

describe("configuration problems", () => {
    it("with no configuration: read-only, warns and explains how to configure", async () => {
        const { host, run } = setup();
        await run("");
        assert.equal(host.notifications[0].level, "warning");
        assert.match(host.notifications[0].message, /allowedWriteDirectories/);
        assert.match((host.widgets.get(WIDGET_KEY) ?? []).join("\n"), /No writable directories/);
    });

    it("with an invalid config: still enters, fails closed and reports the error", async () => {
        const { host, run, controller, cwd } = setup("{ broken");
        await run("");
        assert.equal(controller.isEnabled(), true);
        assert.equal(host.notifications[0].level, "error");
        assert.match(host.notifications[0].message, /plan-mode\.json/);
        assert.match((host.widgets.get(WIDGET_KEY) ?? []).join("\n"), /Configuration error/);
        const blocked = controller.onToolCall({ toolName: "write", input: { path: "plan/a.md" } }, host.ctx(cwd));
        assert.equal(blocked?.block, true);
    });
});

describe("tool gate and guidance", () => {
    it("does nothing while plan mode is off", async () => {
        const { controller, ctx } = setup({ allowedWriteDirectories: ["plan/"] });
        assert.equal(controller.onToolCall({ toolName: "write", input: { path: "src/a.ts" } }, ctx), undefined);
        assert.equal(controller.onBeforeAgentStart({ systemPrompt: "base" }), undefined);
    });

    it("gates tool calls while on, and stops gating after exit", async () => {
        const { controller, ctx, run } = setup({ allowedWriteDirectories: ["plan/"] });
        await run("");
        assert.equal(controller.onToolCall({ toolName: "write", input: { path: "plan/a.md" } }, ctx), undefined);
        const blocked = controller.onToolCall({ toolName: "write", input: { path: "src/a.ts" } }, ctx);
        assert.equal(blocked?.block, true);
        assert.match(blocked?.reason ?? "", /src\/a\.ts/);
        assert.equal(controller.onToolCall({ toolName: "unknown_tool", input: {} }, ctx)?.block, true);
        await run("exit");
        assert.equal(controller.onToolCall({ toolName: "write", input: { path: "src/a.ts" } }, ctx), undefined);
    });

    it("appends guidance to the system prompt per run only while on", async () => {
        const { controller, run } = setup({ allowedWriteDirectories: ["plan/"] });
        await run("");
        const result = controller.onBeforeAgentStart({ systemPrompt: "base prompt" });
        assert.ok(result?.systemPrompt.startsWith("base prompt\n\n"));
        assert.match(result?.systemPrompt ?? "", /Plan mode is ACTIVE/);
        assert.match(result?.systemPrompt ?? "", /instruction-based and not enforced/);
        await run("exit");
        assert.equal(controller.onBeforeAgentStart({ systemPrompt: "base prompt" }), undefined);
    });
});

describe("restore from the session branch", () => {
    const enabled = (value: boolean) => ({ type: "custom", customType: STATE_ENTRY_TYPE, data: { enabled: value } });

    it("starts in normal mode for a brand-new session and clears stale UI", () => {
        const { host, controller, ctx } = setup({ allowedWriteDirectories: ["plan/"] });
        host.statuses.set(STATUS_KEY, "PLAN");
        host.widgets.set(WIDGET_KEY, ["old"]);
        controller.restore(ctx);
        assert.equal(controller.isEnabled(), false);
        assert.equal(host.statuses.size, 0);
        assert.equal(host.widgets.size, 0);
    });

    it("restores the mode from the latest state entry on the branch, reloading config", () => {
        const { host, controller, ctx, cwd } = setup({ allowedWriteDirectories: ["plan/"] });
        host.branch = [{ type: "message" }, enabled(true), { type: "message" }];
        controller.restore(ctx);
        assert.equal(controller.isEnabled(), true);
        assert.equal(host.statuses.get(STATUS_KEY), "PLAN");
        assert.deepEqual(controller.getConfigResult().config.writeDirectories, [join(cwd, "plan")]);
        host.branch = [enabled(true), enabled(false)];
        controller.restore(ctx);
        assert.equal(controller.isEnabled(), false);
        assert.equal(host.statuses.size, 0);
    });

    it("ignores malformed and unrelated entries", () => {
        const { host, controller, ctx } = setup();
        host.branch = [
            enabled(true),
            { type: "custom", customType: STATE_ENTRY_TYPE, data: { enabled: "yes" } },
            { type: "custom", customType: STATE_ENTRY_TYPE },
            { type: "custom", customType: "other-extension", data: { enabled: false } },
            { type: "message", customType: STATE_ENTRY_TYPE, data: { enabled: false } },
        ];
        controller.restore(ctx);
        assert.equal(controller.isEnabled(), true);
    });

    it("follows the active branch only: switching branches restores each branch's mode", () => {
        const { host, controller, ctx } = setup({ allowedWriteDirectories: ["plan/"] });
        const trunk = [{ type: "message" }];
        const branchOn = [...trunk, enabled(true)];
        const branchOff = [...trunk, enabled(true), enabled(false)];
        host.branch = branchOn;
        controller.restore(ctx); // e.g. session_tree navigation
        assert.equal(controller.isEnabled(), true);
        host.branch = branchOff;
        controller.restore(ctx);
        assert.equal(controller.isEnabled(), false);
        host.branch = trunk;
        controller.restore(ctx);
        assert.equal(controller.isEnabled(), false);
        host.branch = branchOn;
        controller.restore(ctx);
        assert.equal(controller.isEnabled(), true);
    });

    it("restores in plan mode with a config error: fails closed and reports it", () => {
        const { host, controller, ctx } = setup("[]");
        host.branch = [enabled(true)];
        controller.restore(ctx);
        assert.equal(controller.isEnabled(), true);
        assert.equal(host.notifications.at(-1)?.level, "error");
        assert.equal(controller.onToolCall({ toolName: "write", input: { path: "plan/a.md" } }, ctx)?.block, true);
    });

    it("does not append state entries when restoring", () => {
        const { host, controller, ctx } = setup();
        host.branch = [enabled(true)];
        controller.restore(ctx);
        assert.equal(host.entries.length, 0);
    });
});
