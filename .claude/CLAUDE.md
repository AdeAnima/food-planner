# thermoxMix — Local Project Instructions

## Worktree Policy (MANDATORY)

Any task that writes to this repo MUST run inside a git worktree, not the main checkout.

**Writing tasks include:** creating/editing/deleting files, running code generators, applying migrations, installing dependencies, scaffolding, refactors, bug fixes, dependency upgrades, doc edits, config changes — anything that mutates tracked or untracked files in the working tree.

**Read-only tasks are exempt:** answering questions, exploring, grepping, reading logs, running non-mutating commands (`git status`, `git log`, type-checks, `--dry-run`), summarizing code.

### How to comply

1. Before the first write, spawn a worktree via the `Agent` tool with `isolation: "worktree"`, OR call `EnterWorktree` to enter one in the current session.
2. Perform all edits, builds, and commits inside the worktree.
3. Return the worktree path + branch name to the user when done. The user merges or discards.
4. If a write is attempted outside a worktree, STOP and create one first. Do not proceed.

### Why

- Main checkout stays clean for parallel work, review, and quick context switches.
- Failed/abandoned attempts leave no residue on `main`.
- Multiple agents/tasks can run concurrently without stomping each other.

### Exceptions

- User explicitly says "edit in place", "skip the worktree", or equivalent.
- Hotfix on `main` the user has already approved with full context.

When in doubt: worktree.
