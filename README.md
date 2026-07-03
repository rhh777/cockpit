# cockpit

> **View, continue, and coordinate Claude Code / Codex CLI sessions from one local cockpit.**

[简体中文](./README.zh-CN.md)

## What It Is

`cockpit` is a local AI CLI session viewer and collaboration console.

- Browse complete Claude Code / Codex CLI session timelines.
- Start cross-agent follow-ups, reviews, or group chats from an existing session.
- Store Cockpit-owned data under `~/.cockpit/` without rewriting native CLI files.

Follow-up agents run read-only by default. The "resume native session" mode writes to native history only through the official CLI subprocess.

## Scope

**Available today:** timeline, follow-up, group chat, native resume, live refresh, patch diffs, session filtering, attachments, model settings, Electron, and i18n.

**Not built yet:** follow-up write approvals, artifact/patch management, orchestration, background runs, and full-text search.

See `docs/01-architecture.md §十四` for the detailed capability map.

## Documentation

- `docs/01-architecture.md` — architecture, data flow, modules, extension points, invariants
- `docs/02-session-formats.md` — observed Claude / Codex session file formats
- `docs/03-roadmap.md` — current capabilities, boundaries, and roadmap
- `docs/04-ui-design.md` — UI visual and interaction guidelines
- `docs/05-group-chat-design.md` — group chat mode, @mention dispatch, shared summaries
- `docs/06-background-runs-design.md` — background run design, not implemented yet
- `docs/07-native-continuation-and-handoff.md` — native continuation, deep links, and handoff bundles
- `docs/08-agent-adapters-design.md` — CLI agent adapter design, including OpenCode and Cursor

## Quick Start

### Requirements

- **Node.js >= 20** and **pnpm >= 9**
- A locally installed and authenticated **Claude Code CLI** (`claude`) and/or **Codex CLI** (`codex`) for follow-up execution. They are runtime subprocess dependencies, not npm packages. Read-only viewer mode does not require them.

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

1. **Read native paths directly** — sessions come from `~/.claude/projects/` and `~/.codex/sessions/`; `~/.cockpit/cache` is only a disposable index.
2. **Best-effort formats** — Claude / Codex JSONL schemas are not official specs and will change. Loaders ignore unknown fields and fall back for new types instead of blocking rendering.
3. **Non-invasive by default** — Cockpit never rewrites native CLI files. Native resume is delegated to the official CLI subprocess.
4. **Read-only and traceable** — follow-up agents default to read-only. Cockpit-generated events include `turnId`, `runId`, and `origin`, with terminal status for completion, cancellation, and failure.
5. **Lightweight** — Vite + React, no DB, no standalone backend service. The optional Electron shell reuses the same app code.

## Contributing

Issues and PRs are welcome. See `CLAUDE.md` and `docs/` for development conventions. Before submitting, run:

```bash
pnpm typecheck && pnpm test
```

## License

[MIT](./LICENSE) © haorenhui
