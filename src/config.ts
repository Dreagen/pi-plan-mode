import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveToolPath } from "./paths.ts";

export const GLOBAL_CONFIG_RELATIVE = join(".pi", "agent", "plan-mode.json");
export const LOCAL_CONFIG_RELATIVE = join(".pi", "plan-mode.json");

const KNOWN_KEYS = ["allowedWriteDirectories", "allowedTools", "allowedShellCommands"] as const;

export interface PlanModeConfig {
    /** Absolute, lexically normalised directories (descendants included). Symlinks resolved at check time. */
    writeDirectories: string[];
    /** Exact extra tool names. */
    allowedTools: string[];
    /** Extra shell commands as exact argv prefixes. */
    allowedShellCommands: string[][];
}

export type ConfigSource = "local" | "global" | "none";

export interface ConfigError {
    path: string;
    message: string;
}

export interface ConfigResult {
    config: PlanModeConfig;
    source: ConfigSource;
    /** Path of the file that supplied the configuration, when there is one. */
    path?: string;
    /** Set when the effective configuration is invalid. `config` is then empty (fail closed). */
    error?: ConfigError;
}

export interface LoadConfigOptions {
    cwd: string;
    home?: string;
}

export function emptyConfig(): PlanModeConfig {
    return { writeDirectories: [], allowedTools: [], allowedShellCommands: [] };
}

type ReadOutcome = { kind: "absent" } | { kind: "text"; text: string } | { kind: "error"; message: string };

function readConfigFile(path: string): ReadOutcome {
    try {
        return { kind: "text", text: readFileSync(path, "utf8") };
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
        return { kind: "error", message: `cannot read file (${(error as Error).message})` };
    }
}

function stringList(value: unknown, key: string): string[] | string {
    if (!Array.isArray(value)) return `"${key}" must be an array of strings`;
    for (const item of value) {
        if (typeof item !== "string" || item.trim() === "") return `"${key}" must contain only non-empty strings`;
    }
    return value as string[];
}

/** Parse and validate configuration text. Returns the config or an actionable message. */
export function parseConfig(text: string, cwd: string, home: string): PlanModeConfig | string {
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch (error) {
        return `invalid JSON: ${(error as Error).message}`;
    }
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
        return "the top level must be a JSON object";
    }
    const record = json as Record<string, unknown>;
    const unknown = Object.keys(record).filter((key) => !(KNOWN_KEYS as readonly string[]).includes(key));
    if (unknown.length > 0) {
        return `unknown key(s) ${unknown.map((k) => `"${k}"`).join(", ")}; expected ${KNOWN_KEYS.map((k) => `"${k}"`).join(", ")}`;
    }
    const config = emptyConfig();
    if (record.allowedWriteDirectories !== undefined) {
        const list = stringList(record.allowedWriteDirectories, "allowedWriteDirectories");
        if (typeof list === "string") return list;
        config.writeDirectories = list.map((entry) => resolveToolPath(entry, cwd, home));
    }
    if (record.allowedTools !== undefined) {
        const list = stringList(record.allowedTools, "allowedTools");
        if (typeof list === "string") return list;
        config.allowedTools = list.map((name) => name.trim());
    }
    if (record.allowedShellCommands !== undefined) {
        const list = stringList(record.allowedShellCommands, "allowedShellCommands");
        if (typeof list === "string") return list;
        config.allowedShellCommands = list.map((entry) => entry.trim().split(/\s+/));
    }
    return config;
}

/**
 * Load the effective configuration. A present local file replaces the global one entirely;
 * the global file is consulted only when the local one is absent. An invalid file yields an
 * empty configuration plus an error, never a fallback to a broader configuration.
 */
export function loadConfig({ cwd, home = homedir() }: LoadConfigOptions): ConfigResult {
    const candidates: Array<{ source: "local" | "global"; path: string }> = [
        { source: "local", path: join(cwd, LOCAL_CONFIG_RELATIVE) },
        { source: "global", path: join(home, GLOBAL_CONFIG_RELATIVE) },
    ];
    for (const { source, path } of candidates) {
        const outcome = readConfigFile(path);
        if (outcome.kind === "absent") continue;
        if (outcome.kind === "error") {
            return { config: emptyConfig(), source, path, error: { path, message: outcome.message } };
        }
        const parsed = parseConfig(outcome.text, cwd, home);
        if (typeof parsed === "string") {
            return { config: emptyConfig(), source, path, error: { path, message: parsed } };
        }
        return { config: parsed, source, path };
    }
    return { config: emptyConfig(), source: "none" };
}
