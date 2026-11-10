# AGENTS.md

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on Jarvl/chess-goat (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Superpowers docs are never committed

The superpowers skills write specs and plans to `docs/superpowers/`. These are working notes, not project documentation: **do not `git add`, commit or push anything under `docs/superpowers/`**, and do not link to it from committed files. Keep such files local (the directory is gitignored). If a design needs to outlive the session, put it in `docs/` proper, a GitHub issue, or `docs/adr/` instead. Before committing, confirm `git status` shows nothing under `docs/superpowers/`.
