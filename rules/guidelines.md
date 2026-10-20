## Tool Preferences

Prefer Pi's built-in tools over bash commands whenever possible:

- Use `read` instead of `cat`, `head`, `tail`, or `sed -n` to view files
- Use `grep` instead of `bash grep/rg` for searching file contents
- Use `find` instead of `bash find` for locating files
- Use `ls` instead of `bash ls` for listing directories
- Use `edit` for changing files. If unavailable, use `patch`.
- Use `write` instead of `bash echo/cat >` for creating files
- ALWAYS prefer `edit` instead of `write` when file needs to be changed
- Reserve `bash` for operations that genuinely need it: running builds, tests,
  git commands, installing packages, piping, or commands with no built-in
  equivalent.
- NEVER use `bash` + Python/Node scripts to read or modify files — use `read`,
  `edit`, or `write` instead.
- NEVER call `sudo`

## Markdown

When writing Markdown files, keep lines below 80 characters. Wrap longer
lines so each line stays under the 80-character limit.

## Git Commit

- NEVER add/amend/modify a git commit without the explicit user request

## Git Commit Fixes

- A request to fix commits authorizes amendments and rebase, not a push.
  Execute the fixes. Do not rebuild history with branches or cherry-picks.
- Inspect status and history; record the actual base and original HEAD.
  Ask before proceeding with unrelated work, active Git operations, or merges.
- Amend HEAD directly. For older commits, prefer fixups and autosquash with
  `GIT_SEQUENCE_EDITOR=true GIT_EDITOR=true git rebase -i --autosquash <base>`.
  If fixes need historical code, use an automated `edit` rebase instead.
  Sequence-editor scripts may edit Git's todo file only.
- Resolve clear conflicts and continue with `GIT_EDITOR=true`.
  Never amend during conflicts, blindly choose sides, or skip commits.
  Ask about unclear resolutions or unexpected empty commits.
- Preserve commit boundaries, authors, order, messages, and trailers.
  Existing messages and fixup subjects are exempt from message-length rules.
  Compare old and new history with `git range-diff`; test affected commits.
  Finish on the original branch with no extra commits. Report fixes and tests.

## Git Commit messages

- ALWAYS use `git commit -s` command when committing into git.
- ALWAYS keep commit messages concise.
- ALWAYS keep commit subject below or equal to 50 characters.
- ALWAYS keep commit line at maximum 72 characters long.
- NEVER add agent name in commit messages (e.g. Co-Developed-by: Claude).
- NEVER replicate the exact sequence of operations made in the patch with
  technical details. That's obviously inside the code itself (i.e. "run
  syscall X, then read functionA, while functionB is running").

## Output format

- NEVER format output text in LaTeX
- ALWAYS format the output in Markdown, unless user asks for something
  different

## Code Reference

ALWAYS check in `~/Projects/` first when looking for project source code:

| Project         | Path                          |
| --------------- | ----------------------------- |
| Linux kernel    | `~/Projects/linux/`           |
| glibc           | `~/Projects/glibc/`           |
| man pages       | `~/Projects/man-pages/`       |
| musl            | `~/Projects/musl/`            |
| liburing        | `~/Projects/liburing/`        |
| xfstests        | `~/Projects/xfstests/`        |
| blktests        | `~/Projects/blktests/`        |
| kvm-unit-tests  | `~/Projects/kvm-unit-tests/`  |
| audit-testsuite | `~/Projects/audit-testsuite/` |
