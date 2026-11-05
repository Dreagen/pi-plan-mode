import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { orange, renderPlanFooter, type FooterInput } from "../src/chrome.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const id = (s: string) => s;

function input(overrides: Partial<FooterInput> = {}): FooterInput {
    return {
        width: 100,
        cwd: "/home/me/proj",
        home: "/home/me",
        branch: "main",
        totals: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, cost: 0.0123 },
        contextPercent: 12.34,
        contextWindow: 200000,
        modelId: "gpt-x",
        reasoning: true,
        thinkingLevel: "high",
        showProvider: false,
        statuses: [],
        dim: id,
        warning: id,
        error: id,
        ...overrides,
    };
}

describe("renderPlanFooter", () => {
    it("puts an orange `plan` before the model and thinking level, right-aligned", () => {
        const [pwd, stats] = renderPlanFooter(input());
        assert.equal(strip(pwd), "~/proj (main)");
        assert.ok(strip(stats).endsWith("plan • gpt-x • high"));
        assert.equal(strip(stats).length, 100);
        assert.ok(stats.includes(`${orange("plan")}`));
    });

    it("omits the thinking level when the model has no reasoning support", () => {
        const [, stats] = renderPlanFooter(input({ reasoning: false }));
        assert.ok(strip(stats).endsWith("plan • gpt-x"));
    });

    it("keeps `plan` visible and within the width on narrow terminals", () => {
        const [, stats] = renderPlanFooter(input({ width: 40 }));
        assert.ok(strip(stats).length <= 40);
        assert.ok(strip(stats).includes("plan • "));
    });

    it("appends extension statuses as an extra line", () => {
        assert.equal(renderPlanFooter(input({ statuses: ["x"] }))[2], "x");
    });
});
