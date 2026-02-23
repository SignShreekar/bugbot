# PR: BugBot — UX Improvements, Crash Recovery & Duplicate Detection

**Branch:** `initial-changes` → `develop`

---

## What

- **Numbered repo selection** — replaced free-text repo input with a numbered menu in `listener.js`; user picks a number instead of typing
- **Step-by-step progress messages** — Slack now shows live updates during analysis (Step 1/3 Triage, Step 2/3 Repo Discovery, Step 3/3 Code Scan)
- **Duplicate bug detection** — if the same bug is reported again, the bot resumes from the last known analysis and informs the user
- **Crash recovery** — added `uncaughtException` and `unhandledRejection` handlers in `index.js`; fatal errors are logged and the process exits cleanly for pm2 to restart
- **File-based logging** — all logs written to `logs/bugbot.log` alongside console output
- **pm2 config** — added `pm2.config.js` for process management and auto-restart on failure
- **Descriptive branch names** — changed from generic timestamped slugs to `fix/<repo>-<rca-keywords>`
- **PR targets `develop`** — base branch changed from `defaultBranch` to `develop`
- **PR body template** — updated to use `## What` / `## Why` / `## Impact` sections

---

## Why

**RCA:** Several reliability and usability gaps in the initial implementation:

- No visible progress feedback during long-running AI calls (triage + scan can take 10–20s), leaving users uncertain if the bot was working
- Unhandled exceptions silently killed the process with no recovery or trace
- Re-reporting the same bug triggered a full re-analysis from scratch instead of resuming
- Free-text repo input was error-prone (typos, wrong casing); numbered options eliminate this
- Branch names included timestamps and noise words, making them hard to identify in GitHub

---

## Impact

- Users see live Slack updates at each analysis step instead of a silent wait
- Bot recovers automatically after a crash; errors are captured in `logs/bugbot.log` for debugging
- Duplicate reports surface the previous analysis instantly with an option to APPROVE or REJECT
- Repo selection is a simple numbered menu — no free-text input required
- Branches and PRs are now consistently based off `develop` with meaningful names
