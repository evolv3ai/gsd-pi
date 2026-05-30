# Test Evaluation Report

Generated: 2026-05-26T02:41:03.351Z

## Summary

| Metric | Count |
|--------|------:|
| Source files | 2121 |
| Covered (named test) | 393 |
| Indirect (stem/other-name tests) | 38 |
| Untested | 1690 |
| Unwired | 0 |
| Critical untested | 162 |
| High untested | 273 |

## Untested by area (top 20)

| Area | Untested / Total | Critical untested |
|------|----------------:|------------------:|
| web | 813 / 823 | 45 |
| ext:gsd | 228 / 474 | 20 |
| pkg:pi-coding-agent | 179 / 208 | 29 |
| pkg:pi-ai | 65 / 73 | 13 |
| pkg:gsd-agent-modes | 48 / 70 | 10 |
| ext:browser-tools | 31 / 31 | 1 |
| pkg:native | 31 / 31 | 0 |
| scripts | 30 / 42 | 0 |
| src:web | 28 / 28 | 1 |
| vscode | 25 / 25 | 3 |
| pkg:pi-agent-core | 22 / 31 | 10 |
| pkg:pi-tui | 22 / 34 | 0 |
| ext:shared | 14 / 18 | 1 |
| ext:remote-questions | 14 / 14 | 0 |
| pkg:mcp-server | 12 / 19 | 1 |
| ext:bg-shell | 10 / 11 | 10 |
| pkg:gsd-agent-core | 10 / 19 | 4 |
| pkg:daemon | 10 / 24 | 1 |
| ext:search-the-web | 9 / 12 | 0 |
| ext:ollama | 7 / 10 | 0 |

## Priority gaps (critical/high untested)

- `packages/cloud-mcp-gateway/src/cli.ts` (high)
- `packages/daemon/src/cli.ts` (high)
- `packages/daemon/src/cloud-cli.ts` (high)
- `packages/daemon/src/cloud-token.ts` (critical)
- `packages/daemon/src/mcp-runtime-cli.ts` (high)
- `packages/gsd-agent-core/src/agent-session-runtime.ts` (critical)
- `packages/gsd-agent-core/src/agent-session-services.ts` (critical)
- `packages/gsd-agent-core/src/compaction/branch-summarization.ts` (critical)
- `packages/gsd-agent-core/src/compaction/utils.ts` (critical)
- `packages/gsd-agent-core/src/export-html/tool-renderer.ts` (high)
- `packages/gsd-agent-modes/src/cli/config-selector.ts` (high)
- `packages/gsd-agent-modes/src/cli/file-processor.ts` (high)
- `packages/gsd-agent-modes/src/cli/session-picker.ts` (critical)
- `packages/gsd-agent-modes/src/modes/interactive/components/bordered-loader.ts` (high)
- `packages/gsd-agent-modes/src/modes/interactive/components/compaction-summary-message.ts` (critical)
- `packages/gsd-agent-modes/src/modes/interactive/components/model-selector.ts` (high)
- `packages/gsd-agent-modes/src/modes/interactive/components/oauth-selector.ts` (critical)
- `packages/gsd-agent-modes/src/modes/interactive/components/provider-manager.ts` (high)
- `packages/gsd-agent-modes/src/modes/interactive/components/scoped-models-selector.ts` (high)
- `packages/gsd-agent-modes/src/modes/interactive/components/session-selector-search.ts` (critical)
- `packages/gsd-agent-modes/src/modes/interactive/components/session-selector.ts` (critical)
- `packages/gsd-agent-modes/src/modes/interactive/controllers/model-controller.ts` (high)
- `packages/gsd-agent-modes/src/modes/rpc/jsonl.ts` (critical)
- `packages/gsd-agent-modes/src/modes/rpc/remote-terminal.ts` (critical)
- `packages/gsd-agent-modes/src/modes/rpc/rpc-client.ts` (critical)
- `packages/gsd-agent-modes/src/modes/rpc/rpc-mode.ts` (critical)
- `packages/gsd-agent-modes/src/modes/rpc/rpc-types.ts` (critical)
- `packages/mcp-server/src/cli.ts` (high)
- `packages/mcp-server/src/session-manager.ts` (critical)
- `packages/native/src/clipboard/index.ts` (high)
- `packages/native/src/clipboard/types.ts` (high)
- `packages/pi-agent-core/src/harness/compaction/branch-summarization.ts` (critical)
- `packages/pi-agent-core/src/harness/compaction/utils.ts` (critical)
- `packages/pi-agent-core/src/harness/session/jsonl-repo.ts` (critical)
- `packages/pi-agent-core/src/harness/session/jsonl-storage.ts` (critical)
- `packages/pi-agent-core/src/harness/session/memory-repo.ts` (critical)
- `packages/pi-agent-core/src/harness/session/memory-storage.ts` (critical)
- `packages/pi-agent-core/src/harness/session/repo-utils.ts` (critical)
- `packages/pi-agent-core/src/harness/session/uuid.ts` (critical)
- `packages/pi-agent-core/src/harness/utils/shell-output.ts` (critical)

Regenerate: `npm run audit:test-matrix -- --write-report`
