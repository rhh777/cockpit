# AGENTS.md

Codex reads this file before working in this repository. Keep it aligned with `CLAUDE.md`; when changing durable project rules, update both files or make one clearly point to the other.

## Repository Context

`cockpit` is a local-first AI CLI session viewer and collaboration console.

- It reads native Claude Code / Codex / OpenCode CLI sessions and renders timelines.
- It can start cross-agent follow-up, review, and group chat on top of an existing session.
- Cockpit data is written under `~/.cockpit/`; native CLI files are not directly edited by Cockpit.
- Native resume must go through the official CLI subprocess and must be explicitly chosen by the user.

## Read Before Editing

- `CLAUDE.md` — canonical project guidance shared with other coding agents.
- `docs/01-architecture.md` — architecture contracts, data flow, invariants, safety, extension points.
- `docs/02-session-formats.md` — measured Claude / Codex JSONL schemas.
- `docs/04-ui-design.md` — UI visual and interaction rules.
- `docs/05-group-chat-design.md` — group chat transcript, summary, and @mention scheduling.
- `docs/07-native-continuation-and-handoff.md` — native continuation, deep links, handoff bundles.

Documented decisions are project contracts, not loose suggestions.

## Commands

```bash
pnpm dev
pnpm electron:dev
pnpm test
pnpm typecheck
pnpm electron:build
```

Use `pnpm` for this repo.

## Core Constraints

1. Do not write, delete, or modify native Claude/Codex/OpenCode CLI files directly.
2. UI consumes only `NormalizedEvent` / `EventEnvelope`, never native CLI schemas.
3. Loaders are best-effort: bad lines become warnings/meta and must not block a session.
4. Adapters must use `serializeForAgent`; do not feed raw native events directly to an agent.
5. Any route that resolves `:id` into a path must validate and constrain it to allowed roots first.
6. API keys must not enter the frontend bundle.
7. Cockpit events need `origin`; follow-up/group events need `turnId`; adapter streams need `runId`.
8. Interface changes should be additive unless the relevant design doc is updated first.

## UI Synchronization Rules

Every UI change must consider related pages and modes, especially single-session follow-up, native resume, and group chat. Avoid fixing the visible page while letting another mode drift.

- Agent names, order, labels, and defaults come from `src/lib/agents.ts`.
- Agent icons must go through `src/components/AgentIcon.tsx`.
- Single-agent selection should use `AgentPicker`; group chat member lists, @mention menus, and per-agent model pickers must reuse the same icon/label/active-state language.
- When changing agent UI, check `AgentIcon`, `AgentPicker`, `FollowupComposer`, `SessionList`, `SessionDetail`, `ReviewPanel`, `StreamingStatus`, and settings/CLI detection.
- When changing composer layout or behavior, check all states: Cockpit follow-up, native resume, and group chat.
- When changing copy or placeholders, update i18n and confirm single-chat/group-chat differences are intentional.
- New agents or CLI parameters must be wired through agent options, @mentions, group members, single-chat defaults, streaming status, permission/model pickers, settings, and server adapter registry.
- Prefer shared constants/components. Only add page-specific UI when the information architecture truly differs, and leave a short code comment explaining why.

Before finishing a UI change, manually inspect at least:

- A native session detail page with the single-chat composer.
- A Cockpit group chat page with the group composer and agent list.

If a change intentionally affects only one mode, say why in the final response or PR description.
