# Plan Mode Extension — v1 Specification

Status: Agreed design; implementation in progress (see Implementation decisions and Milestones).

## Purpose

A small pi extension that provides an explicit planning mode. While active, it guards agent operations against unintended changes outside configured planning directories and visibly indicates the current mode.

This is an accident-prevention guardrail, not a security sandbox or a guarantee against every possible side effect.

## Project and development workflow

- Develop in this directory, currently `/home/nick/.pi/agent/plan-mode/`.
- The user will move the directory to their preferred location later.
- Ultimately maintain it as a standalone Git/GitHub repository.
- Package it as a pi extension that can be loaded directly from its local checkout using `pi install /absolute/path/to/plan-mode`.
- Use `/reload` while pi is idle during development; do not copy source into a second extension location.
- Do not depend on the directory remaining at its current absolute path.

## Commands

| Command | Behaviour |
| --- | --- |
| `/planmode` | Enter plan mode. If already enabled, remain enabled. |
| `/pm` | Alias for `/planmode`. |
| `/planmode exit` | Exit plan mode. If already disabled, remain disabled. |
| `/pm exit` | Alias for `/planmode exit`. |

- Commands are explicit and idempotent, not toggles.
- Unrecognised arguments show usage without changing state.
- Apply mode transitions at an idle boundary rather than halfway through an executing tool call.
- Leave the subagent extension's existing `/plan` command untouched.

## User interface

While plan mode is active:

- Show a persistent `PLAN` footer status indicator.
- Show a compact widget above the editor identifying the effective writable directories and `/pm exit` as the exit instruction.
- Show a brief notification on entry and exit.

Remove this extension's status and widget on exit without replacing pi's footer or disturbing other extensions' UI.

No task tracking, automatic plan execution, or required plan-document format is included in v1.

## Configuration

Extension-owned configuration files:

- Global: `~/.pi/agent/plan-mode.json`
- Local: `<cwd>/.pi/plan-mode.json`

These paths are conventions introduced by this extension, not built-in pi configuration files.

Example:

```json
{
    "allowedWriteDirectories": [
        "plan/",
        "docs/plan/",
        "/absolute/path/to/shared-specs/"
    ]
}
```

Rules:

- A present local configuration replaces the global configuration; do not merge permission lists.
- Fall back to global configuration only when local configuration is absent.
- An invalid local configuration must not trigger fallback to potentially broader global permissions.
- Relative entries resolve against pi's working directory, not the configuration file's directory.
- Support multiple directories, absolute paths, and relative paths including `../` for external locations.
- Permission for a directory includes its descendants.
- An explicitly empty directory list permits no writes.
- With neither configuration present, permit read-only planning and explain how to configure writable directories.
- Invalid configuration must report an actionable error without broadening permissions or silently disabling active protection.
- Load configuration when entering plan mode and when restoring or reloading it. No live file-watching in v1.
- Safe-tool approvals are configurable through two further optional keys (see Safe-tool approval schema).

### Safe-tool approval schema

```json
{
    "allowedWriteDirectories": ["plan/"],
    "allowedTools": ["my_readonly_tool"],
    "allowedShellCommands": ["git log", "git diff"]
}
```

- `allowedTools`: exact tool names added to the allowlist. No wildcards.
- `allowedShellCommands`: additions to the built-in vetted set, written as whitespace-separated commands (e.g. `"make -n"`). For an executable that is not built in, an entry matches by argv prefix (`make -n all` matches `make -n`). For a built-in executable (e.g. `git`), an entry must match the whole command exactly (`git stash list` permits only that), so it can never loosen the built-in argument rules by prefix. Entries cannot override the hard rejections (chaining, pipes, redirection, substitution, globbing).
- `allowedTools` cannot bypass the dedicated policies for `write`, `edit`, `bash`, `subagent` and `subagent_resume`.
- Local replaces global, as for directories. An absent key means no extras.
- If the effective configuration is invalid (on entry, restore or reload), plan mode still turns on with zero writable directories and no extras. The error (file path and problem) is shown in a notification and in the widget. A bad local configuration never falls back to global.

## Parent agent restrictions

### File operations

- Permit reading and approved search tools.
- Permit `write` and `edit` only when their targets are contained in an allowed directory.
- Resolve paths and symlinks before checking containment, including targets that do not yet exist.
- A symlink within an allowed directory does not implicitly grant permission to write outside it. An external destination can be explicitly allowed in configuration.
- Blocked operations should explain the reason, target, and effective allowed directories.

### Shell commands

- Allow a conservative, explicitly vetted set of read-oriented command forms.
- Validate arguments as well as executable names. Commands such as `find` or `rg` can execute other programs with certain options.
- Initially reject unknown commands, arbitrary scripts, command chaining, pipelines, redirection, and command substitution.
- Use the guarded file tools to write planning files; do not allow shell writes merely because their destination appears to be allowed.
- The exact command-and-argument policy must be documented and tested during implementation.
- Treat shell filtering as best effort, not proof that permitted commands have no side effects.

### Other tools

- Deny unclassified tools by default.
- Explicitly permit approved reading, searching, and user-question tools.
- Permit the installed `pi-web-search` package's `web_search` and `url_context` tools when available.
- Web tools are research-oriented network tools, not side-effect-free operations.
- Block mutation-capable integrations unless deliberately approved. Examples include tools that update external systems, create issues, or deploy services.
- Permit research subagents under the policy below.

### Manual user commands

The user's manually entered pi `!` and `!!` shell commands remain unrestricted. The extension constrains agent activity, not deliberate user operations.

## Research subagents

Research subagents are allowed in plan mode, even though their restrictions are instruction-based rather than inherited enforcement.

Include instructions in launch and follow-up tasks that require subagents to:

- Perform research only; do not implement project changes.
- Read files, search, and use research tools as needed.
- Write temporary files or reports only under `/tmp/`, preferably in a dedicated temporary subdirectory.
- Keep research-command write side effects within `/tmp/`.
- Do not modify project files or write elsewhere.
- Do not treat symlinks under `/tmp/` as permission to write outside it.
- Do not perform external mutations.
- Return findings in the final response, mentioning temporary artifacts when useful.
- Pass the same restrictions to any further delegated work.

The parent's configured writable directories are separate from this policy. Allowing subagents to use `/tmp/` does not automatically add `/tmp/` to the parent's allowed directories. Subagents do not gain permission to edit project planning documents merely because the parent may do so.

### Verified installed-package limitations

Research against `@maplezzk/pi-interactive-subagents` 3.16.6 found:

- Children do not automatically inherit the parent's mode, active tools, shell policy, or allowed-write directories.
- Children run separately and do not automatically load the parent's extensions.
- A launch's `tools` field can reduce available tools, but allowing `bash` still permits filesystem mutations.
- `denyTools` is not a general enforcement mechanism for built-in `write`, `edit`, or `bash`.
- Use the launch's `task` field for reliable additional instructions. A named agent's prompt can take precedence over the supplied `systemPrompt` field.
- Resume and nested delegation do not provide automatic monotonic restriction inheritance.
- The package registers `/plan` unconditionally and has no supported setting to disable or rename it. Our distinct commands avoid this conflict.

Do not claim that subagent read-only instructions are enforced. The mechanism used to ensure the parent includes those instructions on launches and follow-ups must be verified during implementation.

## Implementation decisions

- TypeScript loaded directly by pi (jiti), no build step, no runtime dependencies. Tests use `tsx --test` (`node:test`).
- Pure modules (`config`, `paths`, `shell-policy`, `tool-policy`, `subagent-guard`) with a thin `index.ts` wiring commands, hooks and UI.
- Enforcement is a `tool_call` gate only; `setActiveTools` is not used, so unrelated tools are untouched.
- Agent guidance is a per-run system-prompt addition from `before_agent_start`, only while enabled. No persisted messages.
- Block messages state the reason, target and allowed directories, and suggest no workarounds except asking the user (`/pm exit` or editing the configuration).
- Transitions: the command handler awaits `ctx.waitForIdle()` before changing state.

### Tool classification (defaults)

- Always allowed: `read`, `grep`, `find`, `ls`, `ask_user_question`, `web_search`, `url_context`, `subagents_list`, `subagent_interrupt`.
- Path-guarded: `write`, `edit`.
- Policy-checked: `bash` (shell policy), `subagent` and `subagent_resume` (instruction injection).
- Denied by default: `describe_image`, `browser_*`, `powershell`, and anything unknown. Extend through `allowedTools`.

### Shell policy (starting set)

- Allowed with argument validation: `ls`, `pwd`, `cat`, `head`, `tail`, `wc`, `stat`, `file`, `tree`; `rg`/`grep` without program-executing options (e.g. `--pre`); `find` without `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint*`; read-only `git` (`status`, `log`, `diff`, `show`, `branch --list`, `rev-parse`, `ls-files`) rejecting `--output`, `-c`, `--ext-diff`.
- Any command containing shell metacharacters (``; & | < > $ ` ( ) { } * ? [ ]``, backslash, newline, control characters) is rejected, as is any argument starting with `~` or `#`. A `~` inside an argument (e.g. `HEAD~1`) is allowed.
- The executable and every option must be on an allowlist, and options are matched exactly (never by prefix or abbreviation), because tools accept abbreviated long options such as `git log --out=file`. Git top-level options (`-c`, `-C`, `--git-dir`, ...) are rejected; only `--no-pager` is accepted before the subcommand. Arguments are whitespace-tokenised with only simple quoted literals. False rejections (e.g. `rg "foo|bar"`) are accepted.
- Bypass tests must cover `find -exec`, `git -c core.pager=...`, `rg --pre`, `cat $(...)`, `ls; rm`, `$IFS` tricks and embedded newlines.

### Pi 1.5.0 API facts relied on

- No `session_fork` event: fork restore happens on `session_start` with `reason: "fork"`; tree navigation uses `session_tree`.
- `tool_call` handlers may block (`{ block: true, reason }`) and mutate `event.input` in place; input is not revalidated afterwards.
- `before_agent_start` can return a per-run `systemPrompt`.
- `pi.appendEntry` persists custom entries; restore by scanning `ctx.sessionManager.getBranch()` (never `getEntries()`).
- Commands run immediately even while streaming; `ctx.waitForIdle()` defers to idle.
- `ctx.ui.setStatus`, `ctx.ui.setWidget(..., { placement: "aboveEditor" })` and `ctx.ui.notify` provide the UI.
- `subagent` requires `name` and `task`; `subagent_resume` requires `sessionPath` and takes optional `message`.

## Milestones

1. Package scaffold, `config`, `paths`, and tests.
2. `tool-policy` and `shell-policy`, with bypass tests.
3. Commands, UI, session persistence and restore.
4. Subagent instruction injection.
5. README, usage docs, and manual verification checklist.

Commit after each milestone with tests passing.

## Session state

- Brand-new sessions start in normal mode.
- Resume and `/reload` preserve the session's mode.
- Forking or navigating the session tree restores the mode at the relevant branch point.
- Restore state from the active session branch, not merely the last mode entry anywhere in the session history.
- Exiting removes plan-mode instructions and restrictions without disturbing unrelated tool configuration.

## Agent guidance

While active, tell the parent agent that it may research and maintain documents inside the configured writable directories, but must not implement changes elsewhere. Explain the shell, safe-tool, and subagent policies clearly.

Do not automatically begin implementation when exiting plan mode.

## Verification

Cover at least:

- Global fallback, local replacement, empty lists, missing files, and invalid configuration.
- Multiple directories, external paths, path traversal, directory-name prefix collisions, symlinks, and nonexistent targets.
- Allowed and blocked file operations.
- Shell-policy bypass attempts and unknown tool calls.
- Availability of approved web-search and question tools.
- Research instructions on subagent launches and follow-ups, including the `/tmp/` exception.
- Explicit documentation that child restrictions are instruction-based.
- Command aliases, idempotent entry/exit, invalid arguments, and coexistence with the existing `/plan` command.
- UI entry, exit, reload, and restoration.
- New-session defaults, resume, forks, and session-tree navigation.
- Preservation of unrelated tools and UI.

## Out of scope

- OS-level sandboxing or a hard filesystem security boundary.
- Enforced child-process policy inheritance in v1.
- Automatic implementation or execution of a completed plan.
- Task tracking, progress checklists, or a required plan format.
- Changes to or a fork of the installed subagent extension.
