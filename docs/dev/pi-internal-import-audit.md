# Pi internal import audit (ADR-010)

Non-public imports of `packages/pi-coding-agent/src/**` that must switch to `@gsd/agent-core` or `@gsd/agent-modes` after the clean seam migration.

| File | Import | Target after migration |
|------|--------|------------------------|
| `src/web/bridge-service.ts` | `AgentSessionEvent`, `SessionStateChangeReason` from `core/agent-session.ts` | `@gsd/agent-core` |
| `web/lib/gsd-workspace-store.tsx` | `ContextualTips`, transcript reducers, and extension UI snapshot helpers from core internals | `@gsd/agent-core` public exports |
| `web/lib/browser-slash-command-dispatch.ts` | `BUILTIN_SLASH_COMMANDS` from `core/slash-commands.ts` | `@gsd/pi-coding-agent` (stays upstream) |
| `src/tests/blob-store.test.ts` | `blob-store.ts` | `@gsd/agent-core` |
| `src/tests/artifact-manager.test.ts` | `artifact-manager.ts` | `@gsd/agent-core` |
| `src/tests/rpc-golden-fixtures.test.ts` | `modes/rpc/jsonl.ts` | `@gsd/agent-modes` |
| `src/tests/*` (interactive/theme/modes) | various mode paths | `@gsd/agent-modes` |
| `src/tests/*` (core tools, registry) | upstream core paths | `@gsd/pi-coding-agent` public exports |

Extension code should continue importing from `@gsd/pi-coding-agent` for the extension API. Session orchestration (`AgentSession`, `createAgentSession`) moves to `@gsd/agent-core`; run modes and `main` move to `@gsd/agent-modes`.
