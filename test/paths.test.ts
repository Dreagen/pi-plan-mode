import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkWriteTarget, isContained, realpathAllowingMissing, resolveToolPath } from "../src/paths.ts";
import { makeTempDir, writeFile } from "./helpers.ts";

function setup() {
    const root = makeTempDir();
    const cwd = join(root, "project");
    const plan = join(cwd, "plan");
    const outside = join(root, "outside");
    mkdirSync(plan, { recursive: true });
    mkdirSync(outside, { recursive: true });
    return { root, cwd, plan, outside, home: join(root, "home") };
}

describe("isContained", () => {
    it("accepts the directory itself and descendants", () => {
        assert.ok(isContained("/a/plan", "/a/plan"));
        assert.ok(isContained("/a/plan/x/y.md", "/a/plan"));
    });
    it("rejects siblings with a shared name prefix", () => {
        assert.ok(!isContained("/a/plan-evil/x.md", "/a/plan"));
        assert.ok(!isContained("/a/planning", "/a/plan"));
    });
    it("rejects parents and unrelated paths", () => {
        assert.ok(!isContained("/a", "/a/plan"));
        assert.ok(!isContained("/b/plan/x", "/a/plan"));
    });
    it("accepts a child whose name starts with two dots", () => {
        assert.ok(isContained("/a/plan/..hidden", "/a/plan"));
    });
});

describe("resolveToolPath", () => {
    it("matches pi's normalisation: @ prefix, ~, relative and absolute", () => {
        assert.equal(resolveToolPath("@plan/a.md", "/cwd", "/home/u"), "/cwd/plan/a.md");
        assert.equal(resolveToolPath("~/n.md", "/cwd", "/home/u"), "/home/u/n.md");
        assert.equal(resolveToolPath("/abs/../x", "/cwd", "/home/u"), "/x");
        assert.equal(resolveToolPath("a\u00A0b", "/cwd", "/home/u"), "/cwd/a b");
    });
});

describe("realpathAllowingMissing", () => {
    it("resolves symlinked directories and appends non-existent components", () => {
        const { root, outside } = setup();
        symlinkSync(outside, join(root, "link"));
        assert.equal(realpathAllowingMissing(join(root, "link", "new", "file.md")), join(outside, "new", "file.md"));
    });
    it("follows dangling symlinks to their target", () => {
        const { root, outside } = setup();
        symlinkSync(join(outside, "missing.md"), join(root, "dangling"));
        assert.equal(realpathAllowingMissing(join(root, "dangling")), join(outside, "missing.md"));
    });
    it("fails on symlink loops", () => {
        const { root } = setup();
        symlinkSync(join(root, "b"), join(root, "a"));
        symlinkSync(join(root, "a"), join(root, "b"));
        assert.throws(() => realpathAllowingMissing(join(root, "a")), /symbolic links/);
    });
});

describe("checkWriteTarget", () => {
    it("allows existing and non-existent files inside an allowed directory", () => {
        const { cwd, plan } = setup();
        writeFile(join(plan, "existing.md"));
        assert.ok(checkWriteTarget("plan/existing.md", cwd, [plan]).allowed);
        assert.ok(checkWriteTarget("plan/new/deeper/file.md", cwd, [plan]).allowed);
        assert.ok(checkWriteTarget(join(plan, "abs.md"), cwd, [plan]).allowed);
        assert.ok(checkWriteTarget("@plan/at.md", cwd, [plan]).allowed);
    });

    it("blocks everything when no directories are allowed", () => {
        const { cwd } = setup();
        const result = checkWriteTarget("plan/a.md", cwd, []);
        assert.equal(result.allowed, false);
        assert.match((result as { reason: string }).reason, /no writable directories/);
    });

    it("blocks paths outside the allowed directories", () => {
        const { cwd, plan } = setup();
        assert.equal(checkWriteTarget("src/a.ts", cwd, [plan]).allowed, false);
        assert.equal(checkWriteTarget("/etc/passwd", cwd, [plan]).allowed, false);
    });

    it("blocks directory-name prefix collisions", () => {
        const { cwd, plan } = setup();
        mkdirSync(join(cwd, "plan-evil"));
        assert.equal(checkWriteTarget("plan-evil/a.md", cwd, [plan]).allowed, false);
        assert.equal(checkWriteTarget("plan2/a.md", cwd, [plan]).allowed, false);
    });

    it("blocks path traversal out of an allowed directory", () => {
        const { cwd, plan } = setup();
        assert.equal(checkWriteTarget("plan/../src/a.ts", cwd, [plan]).allowed, false);
        assert.equal(checkWriteTarget("plan/../../outside/a.md", cwd, [plan]).allowed, false);
        assert.equal(checkWriteTarget("plan/nonexistent/../../a.md", cwd, [plan]).allowed, false);
    });

    it("allows multiple, external and ../ directories", () => {
        const { cwd, plan, outside } = setup();
        const docs = join(cwd, "docs", "plan");
        assert.ok(checkWriteTarget("../outside/spec.md", cwd, [plan, outside]).allowed);
        assert.ok(checkWriteTarget("docs/plan/x.md", cwd, [plan, docs]).allowed);
        assert.equal(checkWriteTarget("../outside/spec.md", cwd, [plan]).allowed, false);
    });

    it("does not let a symlink inside an allowed directory grant access to its outside target", () => {
        const { cwd, plan, outside } = setup();
        symlinkSync(outside, join(plan, "escape"));
        writeFile(join(outside, "secret.md"));
        assert.equal(checkWriteTarget("plan/escape/secret.md", cwd, [plan]).allowed, false);
        assert.equal(checkWriteTarget("plan/escape/new.md", cwd, [plan]).allowed, false);
    });

    it("blocks writes through a file symlink that points outside", () => {
        const { cwd, plan, outside } = setup();
        writeFile(join(outside, "target.md"));
        symlinkSync(join(outside, "target.md"), join(plan, "link.md"));
        assert.equal(checkWriteTarget("plan/link.md", cwd, [plan]).allowed, false);
    });

    it("blocks writes through a dangling symlink that points outside", () => {
        const { cwd, plan, outside } = setup();
        symlinkSync(join(outside, "not-yet.md"), join(plan, "dangling.md"));
        assert.equal(checkWriteTarget("plan/dangling.md", cwd, [plan]).allowed, false);
    });

    it("allows the symlink destination when it is explicitly allowed", () => {
        const { cwd, plan, outside } = setup();
        symlinkSync(outside, join(plan, "escape"));
        assert.ok(checkWriteTarget("plan/escape/new.md", cwd, [plan, outside]).allowed);
    });

    it("treats an allowed directory that is itself a symlink by its real location", () => {
        const { cwd, root, outside } = setup();
        const link = join(root, "plan-link");
        symlinkSync(outside, link);
        assert.ok(checkWriteTarget(join(link, "a.md"), cwd, [link]).allowed);
        assert.ok(checkWriteTarget(join(outside, "a.md"), cwd, [link]).allowed);
    });

    it("blocks a symlink loop target safely", () => {
        const { cwd, plan } = setup();
        symlinkSync(join(plan, "b"), join(plan, "a"));
        symlinkSync(join(plan, "a"), join(plan, "b"));
        const result = checkWriteTarget("plan/a", cwd, [plan]);
        assert.equal(result.allowed, false);
    });

    it("includes the resolved target in blocked results", () => {
        const { cwd, plan } = setup();
        const result = checkWriteTarget("src/a.ts", cwd, [plan]);
        assert.equal(result.allowed, false);
        assert.equal((result as { resolved?: string }).resolved, join(cwd, "src", "a.ts"));
    });
});
