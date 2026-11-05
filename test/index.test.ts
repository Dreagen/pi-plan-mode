import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import planMode from "../src/index.ts";
import { STATE_ENTRY_TYPE } from "../src/state.ts";
import { FakeHost } from "./fake-host.ts";
import { makeTempDir } from "./helpers.ts";

function load() {
    const host = new FakeHost();
    planMode(host.api);
    const cwd = makeTempDir();
    mkdirSync(join(cwd, "plan"));
    return { host, cwd };
}

describe("extension wiring", () => {
    it("registers /planmode and /pm and leaves /plan alone", () => {
        const { host } = load();
        assert.deepEqual([...host.commands.keys()].sort(), ["planmode", "pm"]);
        assert.ok(!host.commands.has("plan"));
    });

    it("subscribes to session_start, session_tree, tool_call and before_agent_start", () => {
        const { host } = load();
        for (const event of ["session_start", "session_tree", "tool_call", "before_agent_start"]) {
            assert.equal(host.handlers.get(event)?.length, 1, event);
        }
    });

    it("/pm and /planmode behave identically, including exit", async () => {
        for (const [enter, exit] of [["pm", "pm"], ["planmode", "planmode"], ["pm", "planmode"], ["planmode", "pm"]] as const) {
            const { host, cwd } = load();
            await host.run(enter, "", cwd);
            assert.equal(host.statuses.get("plan-mode"), "PLAN");
            await host.run(exit, "exit", cwd);
            assert.equal(host.statuses.size, 0);
        }
    });

    it("gates tool calls and extends the prompt end to end, and not after exit", async () => {
        const { host, cwd } = load();
        const ctx = host.ctx(cwd);
        await host.run("pm", "", cwd);
        const [gate] = await host.emit("tool_call", { toolName: "browser_eval", input: {} }, ctx);
        assert.equal((gate as { block?: boolean }).block, true);
        const [prompt] = await host.emit("before_agent_start", { systemPrompt: "base" }, ctx);
        assert.match((prompt as { systemPrompt: string }).systemPrompt, /Plan mode is ACTIVE/);
        await host.run("pm", "exit", cwd);
        assert.deepEqual(await host.emit("tool_call", { toolName: "browser_eval", input: {} }, ctx), [undefined]);
        assert.deepEqual(await host.emit("before_agent_start", { systemPrompt: "base" }, ctx), [undefined]);
    });

    it("preserves the mode across /reload and resume (a fresh runtime reading the same branch)", async () => {
        const { host, cwd } = load();
        await host.run("pm", "", cwd);
        const branch = host.branch;
        for (const reason of ["reload", "resume", "fork", "startup"]) {
            const next = new FakeHost();
            planMode(next.api);
            next.branch = branch;
            await next.emit("session_start", { reason }, next.ctx(cwd));
            assert.equal(next.statuses.get("plan-mode"), "PLAN", reason);
        }
    });

    it("starts a brand-new session in normal mode", async () => {
        const { host, cwd } = load();
        await host.emit("session_start", { reason: "new" }, host.ctx(cwd));
        assert.equal(host.statuses.size, 0);
        assert.deepEqual(await host.emit("tool_call", { toolName: "write", input: { path: "x" } }, host.ctx(cwd)), [undefined]);
    });

    it("restores on session_tree navigation to a different branch point", async () => {
        const { host, cwd } = load();
        const ctx = host.ctx(cwd);
        host.branch = [{ type: "custom", customType: STATE_ENTRY_TYPE, data: { enabled: true } }];
        await host.emit("session_tree", { newLeafId: "a", oldLeafId: "b" }, ctx);
        assert.equal(host.statuses.get("plan-mode"), "PLAN");
        host.branch = [];
        await host.emit("session_tree", { newLeafId: "c", oldLeafId: "a" }, ctx);
        assert.equal(host.statuses.size, 0);
    });
});
