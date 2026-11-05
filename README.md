# pi-plan-mode

An explicit planning mode for [pi](https://github.com/earendil-works/pi). While it is active, the
agent can research freely but can only write files inside directories you list, and a `PLAN`
indicator is always visible.

> **This is an accident-prevention guardrail, not a security sandbox.** It stops the agent from
> making unintended changes. It does not guarantee the absence of every side effect, and it cannot
> contain a determined or malicious process. See [Limitations](#limitations).

## Install

```sh
pi install /absolute/path/to/plan-mode
```

pi loads the TypeScript source in place (no build step, nothing is copied). During development use
`/reload` while pi is idle. The directory can be moved later; run `pi install` again with the new path.

For a one-off trial: `pi -e /absolute/path/to/plan-mode/src/index.ts`.

## Commands

| Command | Behaviour |
| --- | --- |
| `/planmode` or `/pm` | Enter plan mode. If already on, stays on and reloads the configuration. |
| `/planmode exit` or `/pm exit` | Exit plan mode. If already off, stays off. |

Commands are explicit, not toggles. Any other argument prints usage and changes nothing. Transitions
wait until the agent is idle. The subagent extension's own `/plan` command is untouched.

While active you get a `PLAN` footer status, a widget above the editor listing the writable
directories and the exit instruction, and a notification on entry and exit. On exit, only this
extension's status and widget are removed. Exiting does not start any implementation.

## Configuration

Two optional files, both introduced by this extension:

- Global: `~/.pi/agent/plan-mode.json`
- Local: `<cwd>/.pi/plan-mode.json`

```json
{
    "allowedWriteDirectories": ["plan/", "docs/plan/", "/absolute/path/to/shared-specs/"],
    "allowedTools": ["my_readonly_tool"],
    "allowedShellCommands": ["make -n", "git stash list"]
}
```

| Key | Meaning |
| --- | --- |
| `allowedWriteDirectories` | Directories where `write` and `edit` are allowed (descendants included). |
| `allowedTools` | Extra tool names to permit, matched exactly (no wildcards). |
| `allowedShellCommands` | Extra shell commands to permit (see below). |

Rules:

- A **present local file replaces the global one entirely**. Lists are never merged. The global file is used only when the local file does not exist.
- An **invalid local file never falls back to global**.
- Relative entries resolve against pi's working directory, not the config file's directory. Absolute paths, `~/`, and `../` paths to external locations all work.
- An empty list (`[]`) permits no writes. With no configuration at all, plan mode is read-only and tells you how to configure it.
- Unknown keys are rejected, so a typo such as `allowedWriteDirs` cannot silently grant nothing.
- **Invalid configuration fails closed.** Plan mode still turns on, with no writable directories and no extras, and the error (file and problem) is shown in a notification and in the widget. It is never silently disabled and never broadened.
- Configuration is read when you enter plan mode (`/pm` again reloads it) and when a session is restored or reloaded. Files are not watched.

`allowedShellCommands` entries are whitespace-separated commands. For an executable that is not built
in, an entry matches by argv prefix (`make -n` permits `make -n all`). For a built-in executable
such as `git`, an entry must match the whole command exactly (`git stash list` permits only that),
so it can never loosen the built-in argument rules. Entries can never override the hard rejections
below. `allowedTools` cannot bypass the dedicated policies for `write`, `edit`, `bash`, `subagent` and `subagent_resume`.

## What the parent agent may do

Enforcement is a `tool_call` gate. Active tools are not changed, so unrelated tools stay as they were.
A blocked call explains the reason, the target and the effective writable directories, and suggests
only asking the user.

**Files.** `read`, `grep`, `find`, `ls` are always allowed. `write` and `edit` are allowed only when
the target is inside an allowed directory. Paths are normalised like pi's own tools (`@` prefix, `~`,
`file://`), and symlinks are resolved before the check, including for files that do not exist yet. A
symlink inside an allowed directory does not grant access to its destination, unless that destination
is itself allowed.

**Shell (`bash`).** Best effort. Only a small set of read-oriented command forms is allowed:

| Command | Allowed | Notably rejected |
| --- | --- | --- |
| `pwd`, `ls`, `cat`, `head`, `tail`, `wc`, `stat` | common read-only options | `tail -f` / `-F` |
| `file` | `-b -i -L -h -N`, `--mime*` | `-C` (writes), `-z` / `-Z` (decompressors), `-m`, `-f` |
| `tree` | listing options, `-L N` | `-o` / `--output`, `-R`, `-H` |
| `rg` | search options | `--pre`, `--pre-glob`, `--hostname-bin`, `-z` / `--search-zip` |
| `grep` | search options | `-f` |
| `find` | tests such as `-name -type -mtime -size -maxdepth -print` | `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint*`, `-fls` |
| `git` | `status`, `log`, `diff`, `show`, `branch` (listing only), `rev-parse`, `ls-files` | top-level `-c`, `-C`, `--git-dir`; `--output`, `--ext-diff`, `--no-index`, `-O`; creating or deleting refs |

Every option is checked against an exact allowlist, never by prefix, because tools accept abbreviated
options (`git log --out=file` would otherwise slip past a `--output` blocklist). Any command containing
`; & | < > $ \` ( ) { } * ? [ ]`, a backslash, a newline or a control character is rejected, as is any
argument starting with `~` or `#`. So pipes, chaining, redirection, substitution and globbing are all
out, and so are some legitimate commands such as `rg "foo|bar"`. Use the `write`/`edit` tools for
planning documents; shell writes are not allowed even into allowed directories.

**Other tools.** Allowed: `ask_user_question`, `web_search`, `url_context`, `subagents_list`,
`subagent_interrupt`, and `subagent` / `subagent_resume` under the policy below. Everything else is
denied by default, including `describe_image`, `browser_*`, `powershell`, anything that updates an
external system, and any tool this extension does not know. Add reviewed tools with `allowedTools`.
The web tools are research tools, not side-effect-free operations.

**Your own `!` and `!!` commands are not restricted.** The extension constrains the agent, not you.

## Research subagents

Research subagents are allowed. **Their restrictions are instruction-based and are not enforced.**

Children are separate processes. They do not inherit the parent's mode, tool gate or writable
directories, and the subagent extension has no hook to enforce them. So while plan mode is on, every
`subagent` launch (its `task`) and `subagent_resume` follow-up (its `message`) gets a block of
instructions appended: research only; temporary files and the side effects of research commands only
under `/tmp/` (preferably a dedicated subdirectory); do not modify project files or write elsewhere;
a symlink under `/tmp/` is no permission to write outside it; no external mutations; report findings in
the final response and mention temporary artifacts; pass the same restrictions to any further delegation.

Things to know:

- A child that ignores the instructions can still change files. Treat subagent use as trusted-but-unenforced.
- If the `task` is missing or not a string, the launch is blocked rather than sent without instructions.
- The parent's writable directories and the subagents' `/tmp/` allowance are separate. `/tmp/` is not added to the parent's directories, and children get no permission to edit planning documents.
- Other launch fields (`tools`, `denyTools`, `systemPrompt`) are left alone. `denyTools` is not a general enforcement mechanism for built-in tools, and a named agent's prompt can take precedence over `systemPrompt`, so the `task` text is the reliable channel.

## Sessions

New sessions start in normal mode. Resume and `/reload` keep the mode. Fork and tree navigation
restore the mode that applied at that branch point: state is read from the active branch only, never
from abandoned branches. The mode is stored as a `plan-mode:state` entry that is excluded from model context.

While on, a short guidance block is added to the system prompt for each run. It is not persisted, so
it disappears as soon as you exit.

## Limitations

- Not a sandbox: no OS-level containment. A permitted command can still have side effects (for example `git` reading a repository whose config runs a hook, or `file` reading a hostile file).
- Shell filtering is best effort and deliberately strict; it will reject some harmless commands.
- Subagent restrictions are instructions, not enforcement.
- Extensions and codemode scripts that act outside the `tool_call` path are not covered.
- Configuration changes are not watched; run `/pm` to reload.
- Out of scope for v1: task tracking, a required plan format, automatic plan execution, changes to the subagent extension.

## Development

```sh
npm install
npm test            # unit and wiring tests (node:test via tsx)
npm run typecheck
npm run smoke       # drives a real `pi --mode rpc` (no model calls); needs pi on PATH
```

```
src/
  index.ts           wiring: commands, hooks
  controller.ts      mode state, UI, tool gate, prompt guidance
  config.ts          load, validate and resolve configuration
  paths.ts           symlink-aware containment checks
  shell-policy.ts    bash allowlist and argument validation
  tool-policy.ts     per-tool decisions and block messages
  subagent-guard.ts  research instructions for subagent launches and resumes
  state.ts           branch-aware state restore
  guidance.ts        system prompt addition
  host.ts            the slice of pi's API used (structural types)
```

See [docs/verification.md](docs/verification.md) for the coverage map and the manual checklist, and
[SPEC.md](SPEC.md) for the agreed design.
