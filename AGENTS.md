# AGENTS.md

Guidance for agents working in this repo.

## Workflow

Implement and change code directly on `main`: edit, commit and ship in this repo's `main` branch, without creating a task worktree or a feature branch. Create a branch or worktree only when the user asks for one. This overrides the global rule that requires every change to land in a task-specific worktree.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues at `xuxzh/ruihui-skills`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles map 1:1 onto GitHub labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `GLOSSARY.md` at the repo root and ADRs under `docs/adr/`. See `docs/agents/domain.md`.
