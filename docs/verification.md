# Verification

## Automated coverage (`npm test`, `npm run smoke`)

| SPEC verification item | Where |
| --- | --- |
| Global fallback, local replacement, empty lists, missing files, invalid config | `test/config.test.ts` |
| Multiple directories, external paths, traversal, prefix collisions, symlinks (incl. dangling, loops, symlinked allowed dir), nonexistent targets | `test/paths.test.ts` |
| Allowed and blocked file operations, block message contents, fail-closed on invalid config | `test/tool-policy.test.ts`, `test/controller.test.ts` |
| Shell-policy bypass attempts (`find -exec`, `git -c`, `rg --pre`, `$(..)`, `;`, `\|`, `>`, `$IFS`, newlines, abbreviated options, prototype-key names) | `test/shell-policy.test.ts` |
| Unknown tool calls; `allowedTools` cannot bypass guarded tools | `test/tool-policy.test.ts` |
| Availability of `web_search`, `url_context`, `ask_user_question` | `test/tool-policy.test.ts` |
| Research instructions on launches and follow-ups, `/tmp/` exception, idempotence, `/tmp/` not added to parent writes | `test/subagent-guard.test.ts` |
| Command aliases, idempotent entry/exit, invalid arguments, no `/plan` registration | `test/controller.test.ts`, `test/index.test.ts`, smoke |
| UI entry, exit, restoration; only own status/widget keys touched | `test/controller.test.ts`, smoke |
| New-session default, resume, fork (`session_start`), tree navigation (`session_tree`), branch-only restore | `test/controller.test.ts`, `test/index.test.ts`, smoke (`new_session`, `switch_session`, startup with `--session`) |
| Preservation of unrelated tools and UI | By design (no `setActiveTools`, own keys only); `test/controller.test.ts` |
| Child restrictions documented as instruction-based | `README.md`, the injected block, and the system-prompt guidance (tests assert the wording) |
| Extension loads in real pi and speaks the real UI protocol | `npm run smoke` |

## Manual checklist (interactive TUI)

Things the automated checks cannot see: they need a real terminal and a real model.
Use a scratch project with `.pi/plan-mode.json` containing `{"allowedWriteDirectories": ["plan/"]}`.

1. `pi install /abs/path/to/plan-mode`, start pi. `/pm` shows `plan • <model> • <thinking>` in the footer (`plan` in orange) and a widget above the editor listing `plan` and `/pm exit`, plus a notification.
2. Ask the agent to create `plan/notes.md`. It succeeds. Ask it to create `src/x.ts`. The call is blocked with the reason, target and allowed directories.
3. Ask the agent to write a file with `echo hi > plan/a.md` via bash. It is blocked.
4. Ask it to run `git status` and `rg TODO`. They run.
5. Ask it to run a `web_search`. It runs.
6. Ask it to launch a research subagent. Inspect the child's task (session file or pane): the `<plan-mode-research-restrictions>` block is present. Resume that subagent with a message: the block is present again.
7. Run `!touch /tmp/pm-user-shell` yourself. It works (user shell is unrestricted).
8. `/plan` (from the subagent extension) still works independently.
9. `/reload`: the `plan` footer marker and widget persist and no duplicate widgets appear.
10. Quit and `pi -c` (resume): still in plan mode. In a brand-new session: normal mode.
11. Use `/tree` to jump to a point before you entered plan mode: the `plan` footer marker and widget disappear and writes outside `plan/` work. Jump back after `/pm`: plan mode returns. `/fork` from a message after entry: plan mode is on in the fork.
12. `/pm exit`: status and widget disappear, other extensions' footer items and widgets are untouched, and the agent no longer mentions plan mode on the next prompt.
13. Break the config (`{ nope`), then `/pm`: plan mode turns on, an error names the file, the widget shows the error, and writes to `plan/` are blocked. Fix the file and run `/pm`: writes to `plan/` work.
14. Delete the local config and the global config, then `/pm`: read-only, with a message explaining how to configure writable directories.
