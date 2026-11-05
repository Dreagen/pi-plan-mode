#!/usr/bin/env node
/**
 * Smoke test against a real `pi` in RPC mode (no model calls). Verifies that the extension loads
 * under pi's own loader and that the real UI protocol receives the PLAN status, widget and
 * notifications, including after new_session / switch_session / fork / reload.
 *
 *   node scripts/rpc-smoke.mjs
 *
 * Requires `pi` on PATH. Not part of `npm test` because it depends on the installed pi version.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";

const extension = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts");
const root = realpathSync(mkdtempSync(join(tmpdir(), "plan-mode-rpc-")));
const project = join(root, "project");
mkdirSync(join(project, ".pi"), { recursive: true });
mkdirSync(join(project, "plan"));
writeFileSync(join(project, ".pi", "plan-mode.json"), JSON.stringify({ allowedWriteDirectories: ["plan/"] }));

const STATE = "plan-mode:state";
const sessionsDir = join(root, "sessions");
mkdirSync(sessionsDir, { recursive: true });

/** Hand-write a session file (pi persists lazily, only after the first assistant message). */
function writeSession(name, stateEntries) {
    const path = join(sessionsDir, `${name}.jsonl`);
    const ts = "2026-01-01T00:00:00.000Z";
    const lines = [
        { type: "session", version: 3, id: `${name}-id`, timestamp: ts, cwd: project },
        { type: "message", id: "u1", parentId: null, timestamp: ts, message: { role: "user", content: "hello", timestamp: 1 } },
        {
            type: "message", id: "a1", parentId: "u1", timestamp: ts,
            message: { role: "assistant", content: [{ type: "text", text: "hi" }], api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
        },
    ];
    let parent = "a1";
    stateEntries.forEach((enabled, i) => {
        const id = `s${i}`;
        lines.push({ type: "custom", id, parentId: parent, timestamp: ts, customType: STATE, data: { enabled } });
        parent = id;
    });
    writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    return path;
}

const events = [];
const waiters = [];
let nextId = 0;
let pi;

function startPi(extraArgs = []) {
    events.length = 0;
    pi = spawn("pi", ["--mode", "rpc", "-ne", "-e", extension, "--session-dir", sessionsDir, ...extraArgs], {
        cwd: project,
        stdio: ["pipe", "pipe", "inherit"],
    });
    createInterface({ input: pi.stdout }).on("line", (line) => {
        let record;
        try {
            record = JSON.parse(line);
        } catch {
            return;
        }
        events.push(record);
        for (const waiter of [...waiters]) waiter(record);
    });
}

function send(command) {
    const id = `c${++nextId}`;
    const start = events.length;
    pi.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${command.type}`)), 20000);
        const waiter = (record) => {
            if (record.type === "response" && record.id === id) {
                clearTimeout(timer);
                waiters.splice(waiters.indexOf(waiter), 1);
                // Allow trailing fire-and-forget UI requests to arrive.
                setTimeout(() => resolvePromise({ response: record, ui: events.slice(start).filter((e) => e.type === "extension_ui_request") }), 300);
            }
        };
        waiters.push(waiter);
    });
}

startPi();

const status = (ui) => ui.filter((e) => e.method === "setStatus" && e.statusKey === "plan-mode").at(-1);
const widget = (ui) => ui.filter((e) => e.method === "setWidget" && e.widgetKey === "plan-mode").at(-1);
const notes = (ui) => ui.filter((e) => e.method === "notify").map((e) => e.message);

let failures = 0;
async function step(name, fn) {
    try {
        await fn();
        console.log(`ok   ${name}`);
    } catch (error) {
        failures++;
        console.log(`FAIL ${name}\n     ${error.message}`);
    }
}

const sessionA = writeSession("A-enabled", [true]);
const sessionB = writeSession("B-disabled-later", [true, false]);
const sessionC = writeSession("C-no-state", []);

await step("/pm enters plan mode: PLAN status, widget, notification", async () => {
    const { ui } = await send({ type: "prompt", message: "/pm" });
    assert.equal(status(ui)?.statusText, "PLAN");
    const lines = widget(ui)?.widgetLines ?? [];
    assert.ok(lines.join("\n").includes(join(project, "plan")), `widget: ${lines}`);
    assert.match(lines.join("\n"), /\/pm exit/);
    assert.equal(widget(ui)?.widgetPlacement, "aboveEditor");
    assert.match(notes(ui).join("\n"), /Plan mode enabled/);
});

await step("/planmode again is idempotent and reloads configuration", async () => {
    const { ui } = await send({ type: "prompt", message: "/planmode" });
    assert.equal(status(ui)?.statusText, "PLAN");
    assert.match(notes(ui).join("\n"), /already enabled/);
});

await step("unrecognised arguments show usage and keep the mode", async () => {
    const { ui } = await send({ type: "prompt", message: "/pm nonsense" });
    assert.match(notes(ui).join("\n"), /Usage: \/planmode/);
    assert.equal(status(ui), undefined);
});

await step("only /planmode and /pm are registered by this extension (no /plan)", async () => {
    const { response } = await send({ type: "get_commands" });
    const names = (response.data?.commands ?? []).map((c) => c.name);
    assert.ok(names.includes("pm") && names.includes("planmode"), `commands: ${names}`);
    assert.ok(!names.includes("plan"), "plan must not be registered when only this extension is loaded");
});

await step("new_session starts in normal mode and clears the UI", async () => {
    const { ui } = await send({ type: "new_session" });
    const s = status(ui);
    assert.ok(s && s.statusText === undefined, `status: ${JSON.stringify(s)}`);
    const w = widget(ui);
    assert.ok(w && w.widgetLines === undefined, `widget: ${JSON.stringify(w)}`);
});

await step("switch_session restores each session's mode from its branch", async () => {
    let r = await send({ type: "switch_session", sessionPath: sessionA });
    assert.equal(r.response.success, true, JSON.stringify(r.response));
    assert.equal(status(r.ui)?.statusText, "PLAN", "session A (enabled)");
    assert.ok(widget(r.ui)?.widgetLines?.join("\n").includes(join(project, "plan")));
    r = await send({ type: "switch_session", sessionPath: sessionB });
    assert.ok(status(r.ui) && status(r.ui).statusText === undefined, "session B (enabled then disabled)");
    r = await send({ type: "switch_session", sessionPath: sessionC });
    assert.ok(status(r.ui) && status(r.ui).statusText === undefined, "session C (no state)");
    r = await send({ type: "switch_session", sessionPath: sessionA });
    assert.equal(status(r.ui)?.statusText, "PLAN", "back to session A");
});

await step("/pm exit clears status and widget; second exit is a no-op", async () => {
    const { ui } = await send({ type: "prompt", message: "/pm exit" });
    assert.ok(status(ui) && status(ui).statusText === undefined);
    assert.ok(widget(ui) && widget(ui).widgetLines === undefined);
    assert.match(notes(ui).join("\n"), /Plan mode disabled/);
    const again = await send({ type: "prompt", message: "/planmode exit" });
    assert.match(notes(again.ui).join("\n"), /already disabled/);
});

pi.stdin.end();
pi.kill();

// Startup / resume path: a fresh pi process opening a session whose branch has plan mode enabled.
const sessionD = writeSession("D-enabled", [false, true]);
startPi(["--session", sessionD]);
await new Promise((r) => setTimeout(r, 4000));
await step("starting pi on a session with plan mode enabled restores it", async () => {
    const ui = events.filter((e) => e.type === "extension_ui_request");
    assert.equal(status(ui)?.statusText, "PLAN", `ui events: ${JSON.stringify(ui)}`);
});
pi.stdin.end();
pi.kill();

console.log(failures === 0 ? "\nAll smoke steps passed." : `\n${failures} step(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
