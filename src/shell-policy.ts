/**
 * Best-effort policy for the parent agent's `bash` tool while plan mode is active.
 *
 * Strategy: reject anything containing shell metacharacters outright, tokenise on whitespace
 * (honouring simple quotes), then require the executable and every option to be on a vetted
 * allowlist. Options are matched exactly, never by prefix, because many tools accept
 * abbreviated long options (e.g. `git log --out=file` for `--output`).
 *
 * This is an accident-prevention guardrail, not proof that allowed commands have no side effects.
 */

export type ShellDecision = { allowed: true; argv: string[] } | { allowed: false; reason: string };

/** Characters that can chain, redirect, substitute, expand or escape. Rejected anywhere in the command. */
const FORBIDDEN_CHARS = new Set([";", "&", "|", "<", ">", "$", "`", "(", ")", "{", "}", "*", "?", "[", "]", "\\"]);

export type ShortKind = "flag" | "value" | "attached";
export type LongKind = "none" | "value" | "equals" | "optional";

interface OptionSpec {
    /** Short flags that take no value. */
    short?: string;
    /** Short flags whose value is attached (`-n5`) or the next token (`-n 5`). */
    shortValue?: string;
    /** Short flags with an optional attached value that never consumes the next token (`-U3`). */
    shortAttached?: string;
    /** Accept `-NUM`. */
    numeric?: boolean;
    /** none: `--x`; value: `--x=v` or `--x v`; equals: `--x=v` only; optional: `--x` or `--x=v`. */
    long?: Record<string, LongKind>;
}

function longMap(none: string[], more: Partial<Record<LongKind, string[]>> = {}): Record<string, LongKind> {
    const map: Record<string, LongKind> = {};
    for (const name of none) map[name] = "none";
    for (const kind of ["value", "equals", "optional"] as const) {
        for (const name of more[kind] ?? []) map[name] = kind;
    }
    return map;
}

/** Validate options against `spec`. Returns positional arguments, or an error message. */
export function parseOptions(args: string[], spec: OptionSpec): { positionals: string[]; options: string[] } | string {
    const positionals: string[] = [];
    const options: string[] = [];
    let optionsEnded = false;
    for (let i = 0; i < args.length; i++) {
        const token = args[i];
        if (optionsEnded || token === "-" || !token.startsWith("-")) {
            positionals.push(token);
            continue;
        }
        if (token === "--") {
            optionsEnded = true;
            continue;
        }
        if (token.startsWith("--")) {
            const eq = token.indexOf("=");
            const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
            const hasValue = eq !== -1;
            const kind = spec.long && Object.hasOwn(spec.long, name) ? spec.long[name] : undefined;
            if (kind === undefined) return `option "${token}" is not on the plan-mode allowlist`;
            options.push(`--${name}`);
            if (kind === "none" && hasValue) return `option "--${name}" does not take a value`;
            if (kind === "equals" && !hasValue) return `option "--${name}" must be written as --${name}=VALUE`;
            if (kind === "value" && !hasValue) {
                if (i + 1 >= args.length) return `option "--${name}" requires a value`;
                i++;
            }
            continue;
        }
        if (spec.numeric && /^-\d+$/.test(token)) continue;
        for (let c = 1; c < token.length; c++) {
            const ch = token[c];
            options.push(`-${ch}`);
            if (spec.short?.includes(ch)) continue;
            if (spec.shortAttached?.includes(ch)) break;
            if (spec.shortValue?.includes(ch)) {
                if (c === token.length - 1) {
                    if (i + 1 >= args.length) return `option "-${ch}" requires a value`;
                    i++;
                }
                break;
            }
            return `option "-${ch}" (in "${token}") is not on the plan-mode allowlist`;
        }
    }
    return { positionals, options };
}

type Validator = (args: string[]) => string | undefined;

function withSpec(spec: OptionSpec): Validator {
    return (args) => {
        const result = parseOptions(args, spec);
        return typeof result === "string" ? result : undefined;
    };
}

const SIMPLE_COMMANDS: Record<string, Validator> = {
    pwd: withSpec({ short: "LP" }),
    ls: withSpec({
        short: "aAlh1RdtrSFpsinLHgGoqUx",
        long: longMap(
            ["all", "almost-all", "human-readable", "recursive", "directory", "classify", "reverse", "size", "inode", "numeric-uid-gid", "dereference", "group-directories-first", "no-group"],
            { optional: ["color"] },
        ),
    }),
    cat: withSpec({
        short: "nbsAETv",
        long: longMap(["number", "number-nonblank", "squeeze-blank", "show-all", "show-ends", "show-tabs", "show-nonprinting"]),
    }),
    head: withSpec({ short: "qv", shortValue: "nc", numeric: true, long: longMap(["quiet", "silent", "verbose"], { value: ["lines", "bytes"] }) }),
    // No -f/-F/--follow: following never terminates.
    tail: withSpec({ short: "qv", shortValue: "nc", numeric: true, long: longMap(["quiet", "silent", "verbose"], { value: ["lines", "bytes"] }) }),
    wc: withSpec({ short: "lwcmL", long: longMap(["lines", "words", "bytes", "chars", "max-line-length"]) }),
    stat: withSpec({ short: "Lft", shortValue: "c", long: longMap(["dereference", "file-system", "terse"], { value: ["format"] }) }),
    // No -C (writes a compiled magic file), -z/-Z (spawn decompressors), -m/-f.
    file: withSpec({ short: "biLhN", long: longMap(["brief", "mime", "mime-type", "mime-encoding", "dereference", "no-dereference"]) }),
    // No -o/--output (writes a file), -R (writes 00Tree.html), -H (html), -X/-J.
    tree: withSpec({ short: "adfilpsDFhugrtCnq", shortValue: "L", long: longMap(["noreport", "dirsfirst"]) }),
    // No --pre/--pre-glob/--hostname-bin (execute programs), -z/--search-zip (spawns decompressors).
    rg: withSpec({
        short: "iSswxFvnNlLcoqHhIuUaPp.0V",
        shortValue: "ABCegtTmdEjr",
        long: longMap(
            [
                "files", "files-with-matches", "files-without-match", "count", "count-matches", "hidden",
                "no-ignore", "no-ignore-vcs", "no-ignore-parent", "no-ignore-dot", "no-ignore-global",
                "no-heading", "heading", "line-number", "no-line-number", "column", "no-column",
                "ignore-case", "case-sensitive", "smart-case", "word-regexp", "line-regexp", "fixed-strings",
                "invert-match", "only-matching", "quiet", "follow", "multiline", "multiline-dotall", "pcre2",
                "json", "stats", "type-list", "with-filename", "no-filename", "null", "trim", "vimgrep",
                "pretty", "text", "binary", "unrestricted", "sort-files", "no-messages", "no-config",
                "no-require-git", "one-file-system", "version",
            ],
            {
                value: [
                    "regexp", "glob", "iglob", "type", "type-not", "max-count", "max-depth", "maxdepth", "context",
                    "after-context", "before-context", "replace", "threads", "encoding", "sort", "sortr", "color",
                    "max-filesize",
                ],
            },
        ),
    }),
    grep: withSpec({
        short: "ivnclLrRwxFEGPHhoqsaIT",
        shortValue: "ABCemd",
        numeric: true,
        long: longMap(
            [
                "ignore-case", "no-ignore-case", "invert-match", "line-number", "count", "files-with-matches",
                "files-without-match", "recursive", "dereference-recursive", "word-regexp", "line-regexp",
                "fixed-strings", "extended-regexp", "basic-regexp", "perl-regexp", "no-filename", "with-filename",
                "only-matching", "quiet", "silent", "no-messages", "text", "initial-tab", "null", "byte-offset",
            ],
            {
                optional: ["color", "colour"],
                value: [
                    "max-count", "after-context", "before-context", "context", "regexp", "include", "exclude",
                    "exclude-dir", "devices", "directories", "binary-files",
                ],
            },
        ),
    }),
};

/** find: expression predicates, each with the number of arguments it consumes. */
const FIND_PREDICATES: Record<string, number> = {
    name: 1, iname: 1, path: 1, ipath: 1, wholename: 1, iwholename: 1, regex: 1, iregex: 1, type: 1, xtype: 1,
    maxdepth: 1, mindepth: 1, mtime: 1, mmin: 1, atime: 1, amin: 1, ctime: 1, cmin: 1, newer: 1, size: 1,
    user: 1, group: 1, perm: 1, samefile: 1, links: 1, inum: 1, empty: 0, readable: 0, writable: 0,
    executable: 0, print: 0, print0: 0, ls: 0, prune: 0, depth: 0, xdev: 0, mount: 0, not: 0, and: 0, or: 0,
    a: 0, o: 0, true: 0, false: 0, noleaf: 0,
};
// Explicitly absent (they execute programs or write files): -exec -execdir -ok -okdir -delete
// -fprint -fprint0 -fprintf -fls.

function validateFind(args: string[]): string | undefined {
    let i = 0;
    while (i < args.length && ["-H", "-L", "-P"].includes(args[i])) i++;
    while (i < args.length && !args[i].startsWith("-")) i++; // starting points
    for (; i < args.length; i++) {
        const token = args[i];
        if (!token.startsWith("-")) return `unexpected argument "${token}" after the find expression`;
        const name = token.slice(1);
        if (!Object.hasOwn(FIND_PREDICATES, name)) return `find predicate "${token}" is not on the plan-mode allowlist`;
        if (FIND_PREDICATES[name] > 0) {
            if (i + 1 >= args.length) return `find predicate "${token}" requires a value`;
            i++;
        }
    }
    return undefined;
}

const GIT_DIFF_LIKE: OptionSpec = {
    short: "pPsuwbaimRl",
    shortValue: "nSG",
    shortAttached: "UMB",
    numeric: true,
    long: longMap(
        [
            "oneline", "shortstat", "numstat", "name-only", "name-status", "graph", "no-decorate", "abbrev-commit",
            "no-abbrev-commit", "patch", "no-patch", "cached", "staged", "merges", "no-merges", "first-parent",
            "reverse", "all", "branches", "tags", "remotes", "follow", "full-history", "simplify-by-decoration",
            "no-color", "no-ext-diff", "no-textconv", "summary", "compact-summary", "ignore-all-space",
            "ignore-space-change", "ignore-blank-lines", "check", "patch-with-stat", "full-index", "minimal",
            "patience", "histogram", "raw", "left-right", "cherry-pick", "boundary", "topo-order", "date-order",
            "author-date-order", "ancestry-path", "root", "no-renames", "exit-code", "quiet", "source",
            "use-mailmap", "show-signature", "no-notes", "cc", "regexp-ignore-case",
        ],
        {
            optional: ["stat", "decorate", "color", "abbrev", "find-renames", "find-copies", "word-diff", "relative", "pretty", "notes"],
            equals: [
                "date", "format", "max-count", "skip", "since", "until", "after", "before", "author", "committer",
                "grep", "diff-filter", "unified", "diff-algorithm",
            ],
        },
    ),
};

// Explicitly absent from the git specs: --output, --ext-diff, -O (orderfile), --no-index, -c, -C, and --git-dir
// (also rejected as top-level options), and anything that creates or deletes refs.
const GIT_SUBCOMMANDS: Record<string, Validator> = {
    status: withSpec({
        short: "sbv",
        shortAttached: "u",
        long: longMap(["short", "branch", "long", "show-stash", "ahead-behind", "no-ahead-behind", "renames", "no-renames"], {
            optional: ["porcelain", "ignored", "untracked-files", "ignore-submodules"],
        }),
    }),
    log: withSpec(GIT_DIFF_LIKE),
    diff: withSpec(GIT_DIFF_LIKE),
    show: withSpec(GIT_DIFF_LIKE),
    branch: (args) => {
        const result = parseOptions(args, {
            short: "alrvqi",
            long: longMap(
                ["list", "all", "remotes", "verbose", "show-current", "contains", "no-contains", "merged", "no-merged", "points-at", "no-abbrev", "ignore-case"],
                { optional: ["color", "abbrev"], equals: ["sort", "format"] },
            ),
        });
        if (typeof result === "string") return result;
        const listing = result.options.includes("-l") || result.options.includes("--list") || result.options.includes("--show-current");
        if (result.positionals.length > 0 && !listing) {
            return "`git branch` with arguments creates a branch unless --list is given";
        }
        return undefined;
    },
    "rev-parse": withSpec({
        short: "q",
        long: longMap(
            [
                "show-toplevel", "git-dir", "absolute-git-dir", "git-common-dir", "is-inside-work-tree",
                "is-inside-git-dir", "is-bare-repository", "show-prefix", "show-cdup", "show-superproject-working-tree",
                "verify", "quiet", "symbolic", "symbolic-full-name", "branches", "tags", "remotes", "all", "sq",
                "revs-only", "no-revs", "flags", "no-flags",
            ],
            { optional: ["abbrev-ref", "short"], value: ["git-path"] },
        ),
    }),
    "ls-files": withSpec({
        short: "cdmosukiztvf",
        long: longMap(
            [
                "cached", "deleted", "modified", "others", "stage", "unmerged", "killed", "ignored", "exclude-standard",
                "full-name", "error-unmatch", "eol", "deduplicate", "directory", "no-empty-directory",
                "recurse-submodules", "debug", "sparse",
            ],
            { optional: ["abbrev"], equals: ["with-tree"] },
        ),
    }),
};

function validateGit(args: string[]): string | undefined {
    let i = 0;
    while (i < args.length && args[i] === "--no-pager") i++;
    const subcommand = args[i];
    if (subcommand === undefined) return "git requires a subcommand";
    if (subcommand.startsWith("-")) return `git option "${subcommand}" before the subcommand is not allowed`;
    const validator = Object.hasOwn(GIT_SUBCOMMANDS, subcommand) ? GIT_SUBCOMMANDS[subcommand] : undefined;
    if (!validator) {
        return `git subcommand "${subcommand}" is not on the plan-mode allowlist (allowed: ${Object.keys(GIT_SUBCOMMANDS).join(", ")})`;
    }
    return validator(args.slice(i + 1));
}

const COMMANDS: Record<string, Validator> = {
    ...SIMPLE_COMMANDS,
    find: validateFind,
    git: validateGit,
};

export const BUILTIN_SHELL_COMMANDS: readonly string[] = Object.keys(COMMANDS);

/**
 * Split a command line on spaces/tabs, honouring simple single- and double-quoted literals.
 * Callers must already have rejected forbidden characters, so quotes cannot hide expansions.
 */
export function tokenize(command: string): string[] | string {
    const tokens: string[] = [];
    let current = "";
    let started = false;
    let quote: "'" | '"' | undefined;
    for (const ch of command) {
        if (quote) {
            if (ch === quote) quote = undefined;
            else current += ch;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            started = true;
        } else if (ch === " " || ch === "\t") {
            if (started) tokens.push(current);
            current = "";
            started = false;
        } else {
            current += ch;
            started = true;
        }
    }
    if (quote) return "unterminated quote";
    if (started) tokens.push(current);
    return tokens;
}

function findForbiddenChar(command: string): string | undefined {
    for (const ch of command) {
        const code = ch.codePointAt(0) as number;
        if (ch === "\n" || ch === "\r") return "a newline";
        if (code < 0x20 && ch !== "\t") return "a control character";
        if (code === 0x7f) return "a control character";
        if (FORBIDDEN_CHARS.has(ch)) return `the shell metacharacter "${ch}"`;
    }
    return undefined;
}

/** Extra approvals: prefix match for unknown executables, exact full-argv match for built-in ones. */
function matchesExtra(argv: string[], extras: readonly string[][]): boolean {
    const builtin = Object.hasOwn(COMMANDS, argv[0]);
    return extras.some((prefix) => {
        if (prefix.length === 0 || prefix.length > argv.length) return false;
        if (builtin && prefix.length !== argv.length) return false;
        return prefix.every((part, index) => argv[index] === part);
    });
}

export function checkShellCommand(command: string, extraCommands: readonly string[][] = []): ShellDecision {
    if (command.trim() === "") return { allowed: false, reason: "the command is empty" };
    const forbidden = findForbiddenChar(command);
    if (forbidden) {
        return { allowed: false, reason: `it contains ${forbidden}; chaining, pipes, redirection, substitution and globbing are not allowed` };
    }
    const argv = tokenize(command);
    if (typeof argv === "string") return { allowed: false, reason: argv };
    if (argv.length === 0) return { allowed: false, reason: "the command is empty" };
    for (const token of argv) {
        if (token.startsWith("~")) return { allowed: false, reason: "arguments starting with ~ are not allowed" };
        if (token.startsWith("#")) return { allowed: false, reason: "arguments starting with # are not allowed" };
    }
    if (matchesExtra(argv, extraCommands)) return { allowed: true, argv };
    const validator = Object.hasOwn(COMMANDS, argv[0]) ? COMMANDS[argv[0]] : undefined;
    if (!validator) {
        return { allowed: false, reason: `"${argv[0]}" is not an allowed read-only command (allowed: ${BUILTIN_SHELL_COMMANDS.join(", ")})` };
    }
    const problem = validator(argv.slice(1));
    return problem ? { allowed: false, reason: problem } : { allowed: true, argv };
}
