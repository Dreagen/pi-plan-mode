import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";
import { makeTempDir, writeFile } from "./helpers.ts";

function setup() {
    const root = makeTempDir();
    const cwd = join(root, "project");
    const home = join(root, "home");
    writeFile(join(cwd, ".keep"));
    writeFile(join(home, ".keep"));
    const local = (content: string) => writeFile(join(cwd, ".pi", "plan-mode.json"), content);
    const global = (content: string) => writeFile(join(home, ".pi", "agent", "plan-mode.json"), content);
    return { root, cwd, home, local, global, load: () => loadConfig({ cwd, home }) };
}

describe("loadConfig", () => {
    it("returns an empty config with source none when no file exists", () => {
        const { load } = setup();
        const result = load();
        assert.equal(result.source, "none");
        assert.deepEqual(result.config.writeDirectories, []);
        assert.equal(result.error, undefined);
    });

    it("falls back to the global config when the local one is absent", () => {
        const { global, load, cwd } = setup();
        global(JSON.stringify({ allowedWriteDirectories: ["plan/"] }));
        const result = load();
        assert.equal(result.source, "global");
        assert.deepEqual(result.config.writeDirectories, [join(cwd, "plan")]);
    });

    it("lets a present local config replace the global one without merging", () => {
        const { local, global, load, cwd } = setup();
        global(JSON.stringify({ allowedWriteDirectories: ["/global"], allowedTools: ["g"] }));
        local(JSON.stringify({ allowedWriteDirectories: ["docs/plan"] }));
        const result = load();
        assert.equal(result.source, "local");
        assert.deepEqual(result.config.writeDirectories, [join(cwd, "docs", "plan")]);
        assert.deepEqual(result.config.allowedTools, []);
    });

    it("treats an explicitly empty list as permitting no writes, even if global allows some", () => {
        const { local, global, load } = setup();
        global(JSON.stringify({ allowedWriteDirectories: ["/global"] }));
        local(JSON.stringify({ allowedWriteDirectories: [] }));
        const result = load();
        assert.equal(result.source, "local");
        assert.deepEqual(result.config.writeDirectories, []);
        assert.equal(result.error, undefined);
    });

    it("does not fall back to global when the local config is invalid", () => {
        const { local, global, load } = setup();
        global(JSON.stringify({ allowedWriteDirectories: ["/global"], allowedTools: ["g"] }));
        local("{ not json");
        const result = load();
        assert.equal(result.source, "local");
        assert.ok(result.error);
        assert.match(result.error.message, /invalid JSON/);
        assert.ok(result.error.path.endsWith(join(".pi", "plan-mode.json")));
        assert.deepEqual(result.config.writeDirectories, []);
        assert.deepEqual(result.config.allowedTools, []);
    });

    it("reports an invalid global config when there is no local config", () => {
        const { global, load } = setup();
        global("[]");
        const result = load();
        assert.equal(result.source, "global");
        assert.match(result.error?.message ?? "", /JSON object/);
    });

    for (const [name, body, pattern] of [
        ["non-array directories", { allowedWriteDirectories: "plan/" }, /allowedWriteDirectories/],
        ["non-string directory entry", { allowedWriteDirectories: [1] }, /allowedWriteDirectories/],
        ["empty-string directory entry", { allowedWriteDirectories: [" "] }, /non-empty/],
        ["non-array tools", { allowedTools: {} }, /allowedTools/],
        ["non-string shell entry", { allowedShellCommands: [null] }, /allowedShellCommands/],
        ["unknown (misspelled) key", { allowedWriteDirs: ["plan/"] }, /unknown key.*allowedWriteDirs/],
    ] as const) {
        it(`rejects ${name}`, () => {
            const { local, load } = setup();
            local(JSON.stringify(body));
            const result = load();
            assert.match(result.error?.message ?? "", pattern);
            assert.deepEqual(result.config.writeDirectories, []);
        });
    }

    it("rejects an unreadable config path (directory instead of file)", () => {
        const { cwd, load } = setup();
        writeFile(join(cwd, ".pi", "plan-mode.json", "x"));
        const result = load();
        assert.match(result.error?.message ?? "", /cannot read/);
    });

    it("resolves relative entries against the working directory, not the config directory", () => {
        const { local, load, cwd } = setup();
        local(JSON.stringify({ allowedWriteDirectories: ["plan/", "../shared-specs/", "/abs/specs/"] }));
        const dirs = load().config.writeDirectories;
        assert.equal(dirs[0], join(cwd, "plan"));
        assert.equal(dirs[1], join(cwd, "..", "shared-specs"));
        assert.equal(dirs[2], "/abs/specs");
    });

    it("expands ~ in directory entries", () => {
        const { local, load, home } = setup();
        local(JSON.stringify({ allowedWriteDirectories: ["~/notes"] }));
        assert.deepEqual(load().config.writeDirectories, [join(home, "notes")]);
    });

    it("parses tool approvals and shell command prefixes", () => {
        const { local, load } = setup();
        local(JSON.stringify({ allowedTools: ["my_tool"], allowedShellCommands: ["git  log", "make -n"] }));
        const { config } = load();
        assert.deepEqual(config.allowedTools, ["my_tool"]);
        assert.deepEqual(config.allowedShellCommands, [["git", "log"], ["make", "-n"]]);
    });
});
