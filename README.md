# cockpit

> **Read your Claude Code, Codex, OpenCode, and Cursor sessions in one place — then put those agents in the same room.**

[简体中文](./README.zh-CN.md)

![Cockpit group chat with Claude, Codex, Cursor, and OpenCode replying in one thread](./docs/assets/screenshot-group-chat.png)

## What It Is

`cockpit` is a local AI CLI session viewer and collaboration console.

- Browse complete Claude Code / Codex CLI / OpenCode / Cursor Agent CLI session timelines.
- Start cross-agent follow-ups, reviews, or group chats from an existing session.
- Run a **Review Room**: point any set of agents at a repo, folder, file, document, or existing session and have them review each other's plan, then fix and verify.
- Store Cockpit-owned data under `~/.cockpit/` without rewriting native CLI files.

Follow-up agents run read-only by default. The "resume native session" mode writes to native history only through the official CLI subprocess.

## Scope

**Available today:**

- **Viewer** — Claude Code / Codex JSONL, OpenCode SQLite, and Cursor Agent CLI JSONL sessions; unified timeline, tool activity summary, patch diffs, filtering, virtualized long sessions, live refresh over SSE.
- **Follow-up** — continue any native session with Claude, Codex, OpenCode, or Cursor; history lands in `~/.cockpit/threads/`, never in native CLI files.
- **Group chat** — Cockpit-owned threads with `@mention` parallel dispatch (`@all` / `@everyone` / `@所有人` fan out to the whole roster), plus **serial relay discussion** where each agent hands off via a `Next:` protocol.
- **Review Room** — workflow-ized group thread: source snapshot → parallel or serial review → structured findings compare → fix (single writer) → verify → fresh review. Reviewers are any subset of your enabled agents (Claude + Codex by default); serial mode needs at least two.
- **Approvals & write access** — per-run permission tiers (`ask` / `auto-safe` / `full-access`), with real per-operation approval cards from the Codex app-server, the Claude SDK, and the OpenCode SDK; approve once / always / reject. Cursor runs under CLI-level permission flags and has no interactive approval yet.
- **Background runs** — runs are owned by a `RunRegistry`, survive page switches, and can be re-attached by `runId`.
- **Native continuation & handoff** — write back into native history for Claude, Codex, and OpenCode through the official CLI subprocess, plus handoff bundles, Codex deep links, Codex app-server linked threads, and a one-shot Codex thread mirror.
- **Settings** — per-agent model and reasoning-effort discovery from the installed CLIs, plus theme, language, font size, default agent, and layout, persisted to `~/.cockpit/settings.json`.
- Attachments, Electron shell, i18n scaffolding.

### Where Data Lives

Cockpit reads native CLI sessions in place and writes only under `~/.cockpit/`.

| Read (never written) | Written by Cockpit |
| --- | --- |
| `~/.claude/projects/` | `~/.cockpit/threads/<src>/<id>/` — single-session follow-ups |
| `~/.codex/sessions/` | `~/.cockpit/group-threads/<id>/` — group chats, Review Rooms, attachments |
| `~/.local/share/opencode/` | `~/.cockpit/handoffs/<id>/` — handoff bundles |
| `~/.cursor/projects/`, `~/.cursor/chats/` | `~/.cockpit/runs/` — background run index and native-resume shadow logs |
| | `~/.cockpit/settings.json`, `~/.cockpit/cache/` (disposable) |

Path resolution is restricted to those roots; anything outside them is rejected.

**Not built yet:** full-text search across sessions, export to Markdown/HTML, artifact/patch management, session notes and tags, branch visualization, a Cockpit-side policy engine (path/command classifiers for `auto-safe`), and sandboxed diff-then-merge for risky writes.

**Known rough edges before you rely on this:** plural forms are not handled everywhere ("1 events"), live token deltas have the documented redaction limitation in `docs/01 §十`, and release binaries are unsigned unless signing secrets are configured. See `docs/03-roadmap.md` for the authoritative capability map and `docs/13` / `docs/14` for per-phase implementation status.

## Documentation

- `docs/01-architecture.md` — architecture, data flow, modules, extension points, invariants
- `docs/02-session-formats.md` — observed Claude / Codex / OpenCode / Cursor session file formats
- `docs/03-roadmap.md` — current capabilities, boundaries, and roadmap
- `docs/04-ui-design.md` — UI visual and interaction guidelines
- `docs/05-group-chat-design.md` — group chat mode, @mention dispatch, shared summaries
- `docs/06-background-runs-design.md` — background runs (`RunRegistry`, attach, cancel)
- `docs/07-native-continuation-and-handoff.md` — native continuation, deep links, and handoff bundles
- `docs/08-agent-adapters-design.md` — CLI agent adapter design, including OpenCode and Cursor
- `docs/09-approval-and-write-access.md` — permission tiers and the approval layer
- `docs/10-agent-integration.md` — how an agent adapter is wired end to end
- `docs/11-agent-runtime-latency-plan.md` — runtime warmup and context-projection work
- `docs/12-design-review-findings.md` — 2026-07 design review; all 17 findings closed
- `docs/13-serial-agent-discussion-design.md` — serial relay discussion mode
- `docs/14-review-room-workflow-design.md` — Review Room workflow and fresh review
- `docs/15-release-process.md` — tagged releases, checksums, signing and notarization

## Quick Start

### Requirements

- **Node.js >= 20** and **pnpm >= 9**
- A locally installed and authenticated **Claude Code CLI** (`claude`) and/or **Codex CLI** (`codex`) for follow-up execution. **OpenCode** and **Cursor Agent** CLIs are optional additional agents. They are runtime subprocess dependencies, not npm packages — Cockpit never handles their credentials. Read-only viewer mode does not require any of them; it only needs the session files an already-used CLI left on disk.

### Run Locally

```bash
pnpm install
pnpm dev
```

### Test And Build

```bash
pnpm typecheck        # TypeScript check
pnpm test             # Server-side unit tests
pnpm build            # Web production build
pnpm electron:dev     # Electron development mode
pnpm electron:build   # Electron package for the current platform
```

### Cross-Platform Packages

CI builds Electron packages on the matching GitHub Actions runner for each platform:

- macOS: `pnpm electron:build:mac`
- Windows: `pnpm electron:build:win`
- Linux: `pnpm electron:build:linux`

macOS packages generally need a macOS runner for packaging and signing. Windows and Linux packages are also built on their native runners so installer formats and platform-specific tooling stay predictable.

## i18n

Cockpit ships with a lightweight i18n layer in `src/lib/i18n.ts`. The app currently supports:

- `system` language detection
- English (`en`)
- Simplified Chinese (`zh-CN`)

The language can be changed from Settings -> Interface -> Language.

## Stack

Vite + React 19 + TypeScript, with the Node backend running in the same process through Vite middleware. Streaming uses SSE, styling uses Tailwind v4, and Markdown/code rendering uses `react-markdown` + `shiki`. There is no database.

## Design Principles

1. **Read native paths directly** — sessions come from `~/.claude/projects/`, `~/.codex/sessions/`, the OpenCode session database, and the Cursor Agent CLI transcripts under `~/.cursor/`; `~/.cockpit/cache` is only a disposable index.
2. **Best-effort formats** — Claude / Codex / Cursor JSONL schemas are not official specs and will change. Loaders ignore unknown fields and fall back for new types instead of blocking rendering; a bad line degrades to a warning rather than failing the session.
3. **Non-invasive by default** — Cockpit never rewrites native CLI files. Native resume is delegated to the official CLI subprocess, and only for Claude, Codex, and OpenCode — Cursor sessions are read-only for now.
4. **Read-only and traceable** — follow-up agents default to read-only. Cockpit-generated events include `turnId`, `runId`, and `origin`, with terminal status for completion, cancellation, and failure.
5. **Lightweight** — Vite + React, no DB, no standalone backend service. The optional Electron shell reuses the same app code.

## Contributing

Issues and PRs are welcome. See `CLAUDE.md` and `docs/` for development conventions. Before submitting, run:

```bash
pnpm typecheck && pnpm test
```

## License

[MIT](./LICENSE) © haorenhui
