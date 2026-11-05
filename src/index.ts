import { PlanModeController } from "./controller.ts";
import type { HostApi } from "./host.ts";

export default function planMode(pi: HostApi): void {
    const controller = new PlanModeController(pi);

    // Commands are explicit and idempotent. `/plan` belongs to the subagent extension and is left alone.
    for (const name of ["planmode", "pm"]) {
        pi.registerCommand(name, {
            description: name === "pm" ? "Alias for /planmode" : "Enter plan mode; `/planmode exit` leaves it",
            handler: (args, ctx) => controller.handleCommand(args, ctx),
        });
    }

    // Fork, resume, new, reload and startup all arrive as session_start; tree navigation as session_tree.
    pi.on("session_start", (_event, ctx) => controller.restore(ctx));
    pi.on("session_tree", (_event, ctx) => controller.restore(ctx));
    pi.on("tool_call", (event, ctx) => controller.onToolCall(event, ctx));
    pi.on("before_agent_start", (event) => controller.onBeforeAgentStart(event));
}
