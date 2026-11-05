import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type ConfigResult, emptyConfig, loadConfig } from "../src/config.ts";
import { evaluateToolCall, describeAllowedDirectories, type PolicyContext } from "../src/tool-policy.ts";
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
    const configResult = loadConfig({ cwd, home });
    const ctx: PolicyContext = { cwd, configResult, home };
    return { root, cwd, home, ctx };
}

const blocked = (d: ReturnType<typeof evaluateToolCall>) => d.action === "block";
const message = (d: ReturnType<typeof evaluateToolCall>) => (d.action === "block" ? d.message : "");

describe("file tools", () => {
    it("allows write and edit inside an allowed directory", () => {
        const { ctx } = setup({ allowedWriteDirectories: ["plan/"] });
        assert.equal(evaluateToolCall("write", { path: "plan/a.md", content: "x" }, ctx).action, "allow");
        assert.equal(evaluateToolCall("edit", { path: "plan/sub/a.md", edits: [] }, ctx).action, "allow");
    });

    it("blocks write and edit outside, naming reason, target and allowed directories", () => {
        const { ctx, cwd } = setup({ allowedWriteDirectories: ["plan/"] });
        for (const tool of ["write", "edit"]) {
            const d = evaluateToolCall(tool, { path: "src/a.ts" }, ctx);
            assert.ok(blocked(d));
            assert.match(message(d), /src\/a\.ts/);
            assert.match(message(d), /outside every writable directory/);
            assert.ok(message(d).includes(join(cwd, "plan")));
            assert.match(message(d), /\/pm exit/);
        }
    });

    it("explains how to configure when nothing is configured", () => {
        const { ctx } = setup();
        const d = evaluateToolCall("write", { path: "plan/a.md" }, ctx);
        assert.ok(blocked(d));
        assert.match(message(d), /no writable directories are configured/);
        assert.match(message(d), /allowedWriteDirectories/);
        assert.match(message(d), /plan-mode\.json/);
    });

    it("blocks everything for an explicitly empty list", () => {
        const { ctx } = setup({ allowedWriteDirectories: [] });
        assert.ok(blocked(evaluateToolCall("write", { path: "plan/a.md" }, ctx)));
    });

    it("fails closed and surfaces the error for an invalid config", () => {
        const { ctx } = setup("{ nope");
        const d = evaluateToolCall("write", { path: "plan/a.md" }, ctx);
        assert.ok(blocked(d));
        assert.match(message(d), /invalid/);
        assert.match(message(d), /plan-mode\.json/);
    });

    it("blocks traversal, symlink escapes and malformed input", () => {
        const { ctx, cwd, root } = setup({ allowedWriteDirectories: ["plan/"] });
        mkdirSync(join(root, "outside"));
        symlinkSync(join(root, "outside"), join(cwd, "plan", "escape"));
        assert.ok(blocked(evaluateToolCall("write", { path: "plan/../src/a.ts" }, ctx)));
        const d = evaluateToolCall("write", { path: "plan/escape/a.md" }, ctx);
        assert.ok(blocked(d));
        assert.match(message(d), /resolves to/);
        assert.ok(blocked(evaluateToolCall("write", {}, ctx)));
        assert.ok(blocked(evaluateToolCall("edit", { path: 5 }, ctx)));
        assert.ok(blocked(evaluateToolCall("edit", { path: "" }, ctx)));
    });
});

describe("bash", () => {
    it("allows vetted commands and blocks others with a reason", () => {
        const { ctx } = setup({ allowedWriteDirectories: ["plan/"] });
        assert.equal(evaluateToolCall("bash", { command: "git status" }, ctx).action, "allow");
        const d = evaluateToolCall("bash", { command: "echo hi > plan/a.md" }, ctx);
        assert.ok(blocked(d));
        assert.match(message(d), /echo hi > plan\/a\.md/);
        assert.match(message(d), /metacharacter/);
        assert.ok(blocked(evaluateToolCall("bash", {}, ctx)));
    });

    it("does not allow writes to allowed directories via the shell", () => {
        const { ctx } = setup({ allowedWriteDirectories: ["plan/"] });
        for (const command of ["touch plan/a.md", "tee plan/a.md", "cat > plan/a.md", "mkdir plan/x"]) {
            assert.ok(blocked(evaluateToolCall("bash", { command }, ctx)), command);
        }
    });

    it("honours allowedShellCommands from the config", () => {
        const { ctx } = setup({ allowedShellCommands: ["dotnet --info"] });
        assert.equal(evaluateToolCall("bash", { command: "dotnet --info" }, ctx).action, "allow");
        assert.ok(blocked(evaluateToolCall("bash", { command: "dotnet build" }, ctx)));
    });
});

describe("other tools", () => {
    it("allows approved reading, searching, question and web tools", () => {
        const { ctx } = setup();
        for (const tool of ["read", "grep", "find", "ls", "ask_user_question", "web_search", "url_context", "subagents_list", "subagent_interrupt"]) {
            assert.equal(evaluateToolCall(tool, {}, ctx).action, "allow", tool);
        }
    });

    it("flags subagent launches and resumes for instruction injection", () => {
        const { ctx } = setup();
        assert.deepEqual(evaluateToolCall("subagent", {}, ctx), { action: "allow", subagent: "launch" });
        assert.deepEqual(evaluateToolCall("subagent_resume", {}, ctx), { action: "allow", subagent: "resume" });
    });

    it("denies unknown and mutation-capable tools by default", () => {
        const { ctx } = setup();
        for (const tool of ["browser_eval", "browser_goto", "powershell", "describe_image", "create_issue", "deploy", "mcp__x__y", "", "constructor"]) {
            const d = evaluateToolCall(tool, {}, ctx);
            assert.ok(blocked(d), tool);
            assert.match(message(d), /not approved for plan mode/);
        }
    });

    it("permits extra tools named in allowedTools, exactly", () => {
        const { ctx } = setup({ allowedTools: ["browser_console"] });
        assert.equal(evaluateToolCall("browser_console", {}, ctx).action, "allow");
        assert.ok(blocked(evaluateToolCall("browser_console2", {}, ctx)));
        assert.ok(blocked(evaluateToolCall("Browser_Console", {}, ctx)));
    });

    it("does not let allowedTools bypass the dedicated write, edit or bash policies", () => {
        const { ctx } = setup({ allowedTools: ["bash", "write", "edit"] });
        assert.ok(blocked(evaluateToolCall("bash", { command: "rm -rf x" }, ctx)));
        assert.ok(blocked(evaluateToolCall("write", { path: "src/a.ts" }, ctx)));
        assert.ok(blocked(evaluateToolCall("edit", { path: "src/a.ts" }, ctx)));
    });
});

describe("describeAllowedDirectories", () => {
    it("lists directories, or explains why there are none", () => {
        const configured: ConfigResult = { config: { ...emptyConfig(), writeDirectories: ["/a", "/b"] }, source: "local", path: "/x" };
        assert.equal(describeAllowedDirectories(configured), "/a, /b");
        assert.match(describeAllowedDirectories({ config: emptyConfig(), source: "none" }), /no configuration found/);
        assert.match(describeAllowedDirectories({ config: emptyConfig(), source: "global", path: "/g.json" }), /allows no write directories/);
    });
});
