import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PlanModeController } from "../src/controller.ts";
import { RESEARCH_BLOCK, RESEARCH_BLOCK_START, augmentSubagentInput, withResearchBlock } from "../src/subagent-guard.ts";
import { FakeHost } from "./fake-host.ts";
import { makeTempDir } from "./helpers.ts";

describe("research block content", () => {
    it("covers every restriction from the spec", () => {
        for (const pattern of [
            /PLAN MODE/,
            /not technically enforced/,
            /research only/i,
            /do not implement/i,
            /read files, search/i,
            /only under \/tmp\//,
            /dedicated subdirectory/,
            /write side effects of research commands.*within \/tmp\//,
            /Do not modify project files or write anywhere else/,
            /symlink under \/tmp\/ is not permission to write outside/,
            /external mutations/,
            /final response/,
            /temporary artifacts/,
            /same restrictions on/,
        ]) {
            assert.match(RESEARCH_BLOCK, pattern);
        }
    });
});

describe("withResearchBlock", () => {
    it("appends once and preserves the original text", () => {
        const once = withResearchBlock("Find all callers of Foo.\n");
        assert.ok(once.startsWith("Find all callers of Foo.\n\n"));
        assert.ok(once.endsWith(RESEARCH_BLOCK));
        assert.equal(withResearchBlock(once), once);
        assert.equal(once.split(RESEARCH_BLOCK_START).length - 1, 1);
    });
    it("uses the block alone for missing or blank text", () => {
        assert.equal(withResearchBlock(undefined), RESEARCH_BLOCK);
        assert.equal(withResearchBlock("  \n"), RESEARCH_BLOCK);
    });
    it("re-appends if only the marker was copied without the full block", () => {
        const text = `do things ${RESEARCH_BLOCK_START}`;
        assert.ok(withResearchBlock(text).endsWith(RESEARCH_BLOCK));
    });
});

describe("augmentSubagentInput", () => {
    it("adds the block to a launch task and leaves other fields alone", () => {
        const input: Record<string, unknown> = { name: "r", task: "Investigate X", tools: "read,bash", denyTools: "web_search", systemPrompt: "sp" };
        assert.equal(augmentSubagentInput("launch", input), undefined);
        assert.equal(input.task, `Investigate X\n\n${RESEARCH_BLOCK}`);
        assert.equal(input.tools, "read,bash");
        assert.equal(input.denyTools, "web_search");
        assert.equal(input.systemPrompt, "sp");
        assert.equal(input.name, "r");
    });
    it("adds the block to a resume message, or supplies one when absent", () => {
        const withMessage: Record<string, unknown> = { sessionPath: "/s.jsonl", message: "Also check Y" };
        assert.equal(augmentSubagentInput("resume", withMessage), undefined);
        assert.equal(withMessage.message, `Also check Y\n\n${RESEARCH_BLOCK}`);
        const bare: Record<string, unknown> = { sessionPath: "/s.jsonl" };
        assert.equal(augmentSubagentInput("resume", bare), undefined);
        assert.equal(bare.message, RESEARCH_BLOCK);
        assert.equal(bare.sessionPath, "/s.jsonl");
    });
    it("is idempotent when applied twice", () => {
        const input: Record<string, unknown> = { task: "T" };
        augmentSubagentInput("launch", input);
        const first = input.task;
        augmentSubagentInput("launch", input);
        assert.equal(input.task, first);
    });
    it("refuses to proceed when the field cannot carry instructions", () => {
        assert.match(augmentSubagentInput("launch", {}) ?? "", /missing/);
        assert.match(augmentSubagentInput("launch", { task: 5 }) ?? "", /must be a string/);
        assert.match(augmentSubagentInput("resume", { message: ["x"] }) ?? "", /must be a string/);
    });
});

describe("controller integration", () => {
    function setup() {
        const root = makeTempDir();
        const cwd = join(root, "project");
        const home = join(root, "home");
        mkdirSync(join(cwd, "plan"), { recursive: true });
        mkdirSync(home);
        const host = new FakeHost();
        const controller = new PlanModeController(host.api, { home });
        return { host, controller, cwd, ctx: host.ctx(cwd), run: (a: string) => controller.handleCommand(a, host.ctx(cwd)) };
    }

    it("injects the block into subagent launches and resumes while plan mode is on", async () => {
        const { controller, ctx, run } = setup();
        await run("");
        const launch = { name: "r", task: "Look around" };
        assert.equal(controller.onToolCall({ toolName: "subagent", input: launch }, ctx), undefined);
        assert.ok(launch.task.endsWith(RESEARCH_BLOCK));
        const resume: Record<string, unknown> = { sessionPath: "/s.jsonl", message: "More" };
        assert.equal(controller.onToolCall({ toolName: "subagent_resume", input: resume }, ctx), undefined);
        assert.ok((resume.message as string).endsWith(RESEARCH_BLOCK));
    });

    it("does not touch subagent calls when plan mode is off, or after exit", async () => {
        const { controller, ctx, run } = setup();
        const before = { name: "r", task: "Look" };
        controller.onToolCall({ toolName: "subagent", input: before }, ctx);
        assert.equal(before.task, "Look");
        await run("");
        await run("exit");
        const after = { name: "r", task: "Look" };
        controller.onToolCall({ toolName: "subagent", input: after }, ctx);
        assert.equal(after.task, "Look");
    });

    it("leaves other subagent-family tools unmodified", async () => {
        const { controller, ctx, run } = setup();
        await run("");
        for (const toolName of ["subagents_list", "subagent_interrupt"]) {
            const input = { name: "r" };
            assert.equal(controller.onToolCall({ toolName, input }, ctx), undefined);
            assert.deepEqual(input, { name: "r" });
        }
    });

    it("blocks a launch whose task cannot carry the restrictions", async () => {
        const { controller, ctx, run } = setup();
        await run("");
        const result = controller.onToolCall({ toolName: "subagent", input: { name: "r" } }, ctx);
        assert.equal(result?.block, true);
        assert.match(result?.reason ?? "", /research restrictions/);
    });

    it("does not add /tmp/ to the parent's writable directories", async () => {
        const { controller, ctx, run } = setup();
        await run("");
        assert.equal(controller.onToolCall({ toolName: "write", input: { path: "/tmp/x.md" } }, ctx)?.block, true);
        assert.deepEqual(controller.getConfigResult().config.writeDirectories, []);
    });
});
