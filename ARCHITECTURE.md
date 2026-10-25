# Own Codex 0.5 architecture

The existing Node.js implementation is retained. Chat, headless execution, JSONL events, and the MCP stdio server use the same runtime and agent loop. No frontend owns the tool-execution rules.

| Layer | Working implementation | Limits |
| --- | --- | --- |
| Presentation | Streaming Markdown, live slash previews/Tab completion, searchable/paged model picker, private auth menu, activity spinner, diffs/approval, headless JSON/JSONL | Readline/Emacs-style input; no full-screen vim TUI; previews use the last fetched catalog |
| Orchestration | Event stream, bounded tool loop, read-only planning, todo state, explicit planner/lookup routing, isolated child loops | Three children per parent turn; no recursive delegation or silent model fallback |
| Permissions | read-only, auto-edit/workspace, ask, yolo/all; allow/deny/ask rules; normalized file paths; exact command previews | Tool policies are not OS isolation or a filter over every initial context read |
| Context | Stable system/tool ordering, pinned rules/plan/todos, recent verbatim history, labeled older excerpts, disk-backed observations | Extractive compaction; not lossless or a neural summarizer |
| Capabilities | File/folder tools, literal search, glob, commands, todo, memory/skills, opt-in web fetch and MCP | No LSP, AST editing, browser automation, or automatic execution of model text |
| Sessions | Append-only JSONL hash chain, fsynced semantic events, single writer, partial-tail recovery, completed-turn resume | Local consistency proof only; no external audit anchoring; failed in-flight calls are not replayed blindly |
| Recovery | Pre-write hashes/backups, verified undo, created-file/folder cleanup, conflict rejection | Covers file tools, not arbitrary shell/network/MCP side effects; not a whole-filesystem transaction |
| Providers | Responses/Chat Completions, native Anthropic, Gemini and Ollama, native catalogs | Models must support the relevant tool protocol; native provider fixtures are not live account certification |
| Credentials | Named encrypted keyrings, active-key selection, bounded same-provider failover, round-robin, rejected/cooldown tracking | Explicit HTTP 401/402/403/429 only; no interrupted-stream replay or model/provider switching; strict budgets stop on unknown rejection usage |
| Accounting | Input/output/cache counters, aggregate attempt counts, explicit USD cost fields, separately computed tariffs, turn budgets | Missing usage/currency is unavailable; input usage is learned after requests; local budgets are not provider billing caps |
| Knowledge | Root AGENTS.md/CLAUDE.md, project memory, BM25 plus local hashed vectors, on-demand skill content | Hashed vectors are not learned semantic embeddings; only the selected root's instruction files are auto-pinned |
| MCP | Explicit stdio/Streamable HTTP clients, JSON/SSE replies, namespaced tools, stdio server exposing agent_run | No legacy two-endpoint SSE transport or ACP server |
| Runtime | Fresh Git worktrees/branches, command timeouts/tree cleanup, credential filtering, encrypted vault | Worktrees require committed Git HEAD; no automatic merge or hidden copying of dirty parent state |
| OS sandbox | Required Linux bubblewrap preflight, filesystem mounts and command-network isolation; fail-closed unavailable mode | Windows/macOS sandbox backends are not implemented; Linux execution needs validation on a suitable host |

## Source map

```text
src/
  agent.js                 shared model/tool loop
  core/                    runtime, events, accounting, compaction, diff, async helpers
  providers/               native adapters; client.js retains compatible API entry points
  permissions/             policy evaluation and approval decisions
  session/                 JSONL audit/history/artifacts
  memory/                  rules, local retrieval and SKILL.md discovery
  tools/                   registry extensions and JSON-schema argument checks
  mcp/                     stdio and Streamable HTTP clients
  server/                  MCP stdio server
  runtime/                 Git worktree lifecycle
  sandbox/                 explicit off/required isolation posture
  tui/                     terminal Markdown/diff presentation
  workspace.js             checked filesystem and command execution
  config.js, config-vault.js
  cli.js                   argument parsing and presentation adapters
```

## One turn

The CLI assembles a bounded repository snapshot and prior completed conversation. The runtime adds project rules, matched skill metadata, retrieved memory, and plan/todos. An optional read-only planning pass runs before implementation. Every model round emits events, normalizes usage/tool calls, checks budgets, dispatches schema-validated tools, and sends bounded observations back. Large observations are kept as local artifacts. Successful file operations have checkpoint receipts; final results carry actual changes and commands. The UI subscribes to the event stream; JSONL and MCP remain machine-readable.

Native continuation formats remain inside adapters: Responses retains returned output items (including reasoning items), Anthropic retains content blocks/signatures, Gemini retains parts/thought signatures and function IDs, and Ollama converts canonical tool arguments back into native objects. Hidden reasoning is not printed as answer text.

## Storage and privacy

Project stores are keyed by the canonical checkout root under the configured Own Codex home. A worktree is its own checkout root, so resume with that root. Session locks prevent concurrent writers to one log. A dead process's recorded lease can be recovered; active sessions must close before resuming. Audit hashes detect changed complete records, while a torn final record is removed on recovery. Deleting/recomputing a whole locally owned log is outside that consistency model.

API credentials are injected into transport headers. The encrypted vault uses Windows account-bound DPAPI, or an explicit non-Windows master key with scrypt/AES-GCM, with named keyrings and atomic locked writes. Private terminal entry suppresses echo/history; active credentials are dynamically redacted from events, including after an in-chat auth change. Same-provider failover occurs only on explicit credential/quota HTTP rejections before a response is accepted. Legacy plaintext auth remains an explicit compatibility source; it is not silently migrated or erased. External processes are trusted code: removing credential environment variables and checking cwd does not stop an unsandboxed program from reading account-owned files.

## Validation boundaries

The automated suite exercises real temporary filesystem changes, undo conflicts, session corruption/recovery, permission denials, protocol fixtures for all adapters, MCP subprocesses/HTTP/SSE, Git worktrees, token/cost failure cases, CLI subprocesses, and Windows DPAPI. The opt-in live-runtime smoke check uses the configured provider in a disposable project and verifies file creation/readback, a real command exit, audit integrity, resume, and undo. There is no claim that the Windows validation host tested Linux namespace enforcement or every external model.

## Protocol references

- [Official OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [Anthropic Messages streaming](https://platform.claude.com/docs/en/api/messages/stream)
- [Gemini generateContent and function schemas](https://ai.google.dev/api/generate-content)
- [Ollama chat](https://docs.ollama.com/api/chat)
- [MCP stdio and Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [Windows DPAPI through ConvertFrom-SecureString](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/convertfrom-securestring)
