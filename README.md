# Own Codex CLI

A Windows-friendly local coding agent using Node.js built-ins. Version 0.5 adds live slash-command previews, a searchable model picker, private in-chat key entry, multiple encrypted API keys with automatic switching, and processing/tool activity indicators. It also supports durable sessions/resume, conflict-checked undo, planning, usage budgets, permission policies, native providers, project knowledge, MCP, and isolated Git worktrees. See [ARCHITECTURE.md](ARCHITECTURE.md) for the implementation map and platform limits.

## Interactive commands and API keys

Type `/` to see command suggestions update as you type; Tab completes commands and cached model IDs. `/model` loads the real provider catalog and opens a numbered picker. Enter a number, model ID, search text, `:free`, `:all`, `:next` or `:prev`; a blank line cancels. `/model free` opens the free-filtered picker. Direct `/model <id>` switching still works. Model previews use the most recently loaded catalog and do not send a request for each keystroke. Piped chat prints the catalog without opening a picker.

```text
/auth                    # status and interactive key menu
/auth add primary        # private prompt; never put the key on this line
/auth add backup         # add another encrypted key
/auth use primary        # choose a key; clear its rejected/cooldown state
/auth next               # select the next key in this session
/auth rotate on          # automatic failover (default)
/auth rotate round-robin # distribute new requests across keys
/auth rotate off         # use the selected key without fallback
/auth status             # labels, active key, availability and vault settings
/auth remove backup      # remove only this encrypted key
```

Key entry is hidden and excluded from chat, model context, audit events and readline history. Named keys belong to the selected provider; up to 32 encrypted keys are supported per provider. `add` refuses duplicate labels; `/auth login <label>` deliberately replaces one. An existing single-key vault is read automatically, and adding a key preserves it. Environment credentials start first, followed by vault keys; legacy auth is used when neither is configured. `/auth use` explicitly selects a key for the current process; a selected vault label is also saved for future launches where an environment override is absent. Vault changes are written atomically under an exclusive lock.

Failover keeps the endpoint, model and request unchanged. It tries each available key at most once on explicit HTTP 401/402/403/429 rejections, and reports the switch using key labels only. Authentication/access rejections disable that key in this process until `/auth use` or a reload; credit/rate-limit responses apply a cooldown using `Retry-After`, or 30 seconds when absent. If all keys are unavailable, the request fails visibly. It does not switch models/providers, replay interrupted streams, retry network/server failures, or rerun executed tools. Rejected attempts have unknown usage and are counted as such; strict token/dollar budgets stop before a fallback request when usage cannot be verified. Provider quotas and access restrictions still apply.

During model requests, a terminal spinner displays “Thinking / processing”, requested model, round and elapsed stage time; tool calls display their actual tool name. It clears before answer text or approval prompts. This is a processing indicator, not private model reasoning. JSON/JSONL/MCP and piped output remain free of animation.

For scripts, supply each key through stdin rather than command arguments:

```powershell
own-codex auth add --label primary --provider apinex --stdin-key
own-codex auth add --label backup --provider apinex --stdin-key
own-codex auth use primary --provider apinex
own-codex auth rotate round-robin --provider apinex
```

## Roadmap features in 0.4

```powershell
# Headless output or a machine-readable event stream
own-codex exec "Fix this project" --allow-run --json
own-codex -p "Explain the failure" --jsonl

# Read-only plan, or plan first and then implement
own-codex exec "Plan a checkout flow" --plan
own-codex exec "Implement the checkout flow" --plan-first --allow-run

# Saved sessions and verified file-tool undo
own-codex sessions --json
own-codex chat --resume last
own-codex undo --resume SESSION_ID --json

# Explicitly enable isolated child agents or a fresh Git worktree
own-codex chat --subagents --allow-run
own-codex chat --worktree --worktree-name checkout-task --allow-run

# MCP server over stdio, for another agent/client to drive
own-codex serve --root "C:\my-project" --read-only
```

The terminal renderer and `--jsonl` subscribe to the same core events. Interactive output supports streaming Markdown, live command suggestions, model selection, collapsed tool receipts, activity indicators and usage summaries. Readline supplies Emacs-style editing. It is not a full-screen vim TUI.

## Build directly in your project

```powershell
npm start -- --allow-run --all-context --model free/gpt-6-luna
```

Then type your request, for example `Create an Amazon-style storefront homepage in amazon-clone, with responsive layout, product cards, search, and working cart interactions. Create the actual files and verify them.` The model uses tools to build in the current project; it no longer receives a prompt telling it that it cannot create files.

Inside chat, these commands enable the same capabilities:

```text
/permissions all
/context all
/model free/gpt-6-luna
```

Editing is enabled by default with `workspace` / `auto-edit` permissions. `all` / `yolo` additionally enables local commands; `read-only` permits inspection only. `ask` displays the exact command/arguments or proposed diff and accepts approval once, for that target/session, or denial. Non-interactive runs cannot approve actions. Use `--permission-mode ask` or `/permissions ask`. All file tools check project boundaries, reject credential paths, and reject symbolic links/junctions. **With `--sandbox off` (the default), local commands run with your account's permissions and can access resources outside the project.** They start in a checked directory with separate executable/argument fields, hidden helper windows, filtered credential environment variables, bounded output, and timeout/cancellation of process trees.

`--sandbox required` fails before agent actions on unsupported hosts. Its Linux backend requires an installed, usable bubblewrap and blocks command networking. Windows and macOS OS-sandbox backends are not implemented. `--allow-host example.com` enables the text-only `web_fetch` tool for that exact host; it does not grant network access to sandboxed shell commands.

File overwrites require an explicit overwrite or a unique exact-text edit. Original contents are saved under `.own-cli-backups/<session>/...`. Session checkpoints record before/after hashes before replacement. `/undo` or the `undo` command restores the most recent recorded file-tool turn, including newly created files and empty folders, after verifying that later edits will not be overwritten. Conflicting files stop undo before restoration. Completed changes remain if a later API call, cancellation, or limit stops a turn; rollback is explicit. **Undo covers file-tool mutations, not arbitrary side effects of shell commands, network tools, or third-party MCP servers.** It restores content/modes, not every filesystem attribute or external resource.

Core tools are `list_directory`, `read_file`, `search_files`, `make_directory`, `write_file`, `edit_file`, `glob`, `todo`, `project_knowledge`, and `read_artifact` when recording sessions. Commands, web fetch, delegation, and external MCP tools are enabled by their corresponding options. Arguments are checked with the supported JSON-schema subset (types, required fields, nested objects/arrays, enums, local references, and basic bounds). Tool errors become observations so the model can correct them. Agent turns default to 20 rounds and 100 tool calls; `--max-steps` / `--max-turns` accepts 1–100. Native function calling is required; printed code blocks are never executed.

## Quick start

Requires Node.js 20.3 or newer and a working provider/model combination. The current validation host uses Node.js 22 on Windows.

```powershell
npm link
own-codex setup
```

Run `own-codex auth login --provider apinex` to enter a key without echoing it, or keep using the legacy `%USERPROFILE%\.own-codex\auth.json`. On Windows the encrypted vault uses your account's DPAPI; other platforms require `OWN_CODEX_VAULT_KEY` with at least 32 characters for scrypt/AES-GCM encryption. `auth status` lists encrypted entries without keys; `auth logout --provider apinex` removes only that vault entry. Environment variables and legacy auth files are separate sources and are not erased by vault logout. Review `%USERPROFILE%\.own-codex\config.toml`, then:

```powershell
own-codex config
own-codex doctor
own-codex doctor --live
own-codex ask "Explain this project and identify likely bugs"
```

Without linking, use `node src/cli.js` in place of `own-codex`. `own-cli` is also installed as an alias by `npm link`.

Setup retains the original APInex template:

```toml
model = "free/claude-opus-4.6"
model_provider = "apinex"

[model_providers.apinex]
name = "APInex"
base_url = "https://api.apinex.bond/v1"
wire_api = "responses"
requires_openai_auth = true
```

This is a configuration template, not a verified model catalog or availability guarantee. Select an endpoint and model available to your account. A placeholder key is reported as missing. `doctor` checks local settings; `doctor --live` sends only `Reply with OK only.` with a 16-token output budget and no repository context. Failed checks return a nonzero exit code.

## Upgrading from 0.1

Version 0.2 uses **`.own-codex`** rather than automatically reading the desktop app's `.codex` folder. This avoids combining an unrelated desktop model with the APInex endpoint or modifying shared authentication files.

Run `setup`, copy the relevant provider and model settings into the new `config.toml`, and put your provider key in the new `auth.json`. Existing `.codex` files are left in place. To explicitly read compatible old scalar configuration files, set both paths:

```powershell
$env:OWN_CODEX_CONFIG_PATH = "$env:USERPROFILE\.codex\config.toml"
$env:OWN_CODEX_AUTH_PATH = "$env:USERPROFILE\.codex\auth.json"
```

The built-in TOML reader supports scalar strings, booleans, numbers, dotted keys, provider tables, and comments. It does not implement arrays, inline tables, dates, or multiline strings. Copy only the relevant settings from larger desktop configurations.

`setup` never replaces existing files by default. `setup --force` backs up each existing file to a unique `.bak` path before replacing it, and prints the backup locations. It honors custom config/auth paths too.

## Commands

```powershell
# Inspect exactly which files and excerpts would be shared; no API call
own-codex context --json

# Focus the context; files have priority in the supplied order
own-codex ask "Propose a fix and a regression test" --file src\app.js --file test\app.test.js
own-codex ask "Review this module" --root "C:\my project" --dir src

# Skip the initial snapshot; file tools can still read files on demand
"Explain this error message" | own-codex ask --no-context
own-codex ask --no-context -- "Explain --some-flag"

# Inspect only, or enable editing plus commands
own-codex ask "Review this module" --read-only
own-codex ask "Fix the failing tests" --allow-run --all-context

# Complete output or JSON for scripts
own-codex ask "Explain the failure" --no-stream
own-codex ask "Explain the failure" --json

# Interactive conversation
own-codex chat

# List the provider's live catalog, with free models first
own-codex models
own-codex models --free
own-codex models --free --json

own-codex --help
own-codex --version
```

`ask` / `exec --json` returns final text, requested/reported model IDs, last-response usage, aggregate `accounting`, a `sessionId`, context metadata, and real change/command receipts. `--jsonl` emits core events as JSON lines with no raw response text on stdout. Normal human-readable notices use stderr. Failed requests exit nonzero; JSON errors include available accounting. A stream may print progress before failure; `--no-stream` / `--json` buffers answer text but does not postpone or roll back tool actions.

Chat commands:

- `/help` — show commands
- `/context` — show included, excerpted, and omitted files
- `/context all` — load all eligible project text up to the expanded budgets
- `/context auto`, `/context none`, `/context refresh` — select bounded automatic context, skip the snapshot, or reload it
- `/permissions` — show active permissions; `/permissions read-only`, `/permissions workspace`, `/permissions ask`, `/permissions all` change them for this session
- `/plan <task>` — inspect and produce a read-only plan
- `/todos`, `/status` — inspect task steps and usage/cost availability
- `/session`, `/sessions` — inspect the current session and project session list
- `/tools`, `/diff` — expand recorded tool results and proposed diffs; receipts establish which changes actually ran
- `/undo` — restore the latest recorded file-tool turn after conflict checks
- `/config` — inspect the requested model and provider
- `/model` — fetch all models from the provider, with free models first and the current model marked
- `/model free` — fetch and show only free-tagged models
- `/model <id>` — switch to a listed model for the current chat session; `/models` is an alias
- `/clear` — clear conversation turns while retaining the repository snapshot
- `/exit` or `/quit` — leave the session

Chat retains a bounded conversation and the repository snapshot in subsequent requests, including after old turns are evicted. The snapshot is refreshed after agent file edits; use `/context refresh` for changes made by other programs. File tools always read current disk contents. Failed turns are not added to history, and you can continue after an error. Ctrl+C cancels an active request/command; at an idle interactive prompt it closes chat. EOF also closes cleanly. Piped chats preserve all supplied lines and exit nonzero if any request fails.

For example, use `/model free` followed by `/model free/claude-sonnet-4.6` if that ID is listed. Switching validates the ID against the most recently fetched catalog, retains conversation history, and does not rewrite your config. `/model` and `/model free` fetch a fresh catalog; `/model <id>` fetches it first if you have not listed models yet. Restart an already running CLI after installing this update.

Model listing calls the provider catalog (`/models`, or Ollama `/api/tags`) and follows supported cursor pagination. It sends no repository context and makes no generation request. Free labels come from explicit zero token prices, provider free flags, or `free/…` / `…:free` IDs; explicit nonzero prices take precedence. Missing pricing is **PRICE UNKNOWN**. Labels do not establish account access or remove quotas/subscription requirements. Catalogs are capped at 100 pages/10000 entries with explicit errors at those limits.

## Sessions, budgets, policies, and integrations

Project state is stored under `%USERPROFILE%\.own-codex\projects\<project-hash>`. Each session has an append-only, hash-chained JSONL audit log, a single-writer lease, and content-addressed large-result artifacts. Partial final log lines can be recovered after a crash; corrupt complete records are rejected. Resuming restores completed conversation turns, plans and todos; it does not blindly repeat in-flight tool calls. The hash chain is a local consistency check, not an externally anchored proof against an account owner rewriting the whole log. Token deltas are transient events; assembled model text and semantic events are recorded durably. Use `--no-session` to disable logs/artifacts; project memory remains separate if explicitly written by a tool.

History compaction retains recent turns verbatim and labels older extractive excerpts. Large tool observations go to disk with artifact pointers. System/rules/tool ordering stays stable and changing memory/plan/history is appended after the stable prefix; actual provider cache hits are reported from usage rather than assumed.

`--max-ms` bounds a complete turn (default 600000 ms), including planning and children. `--max-tokens` sums actual provider-reported tokens and limits subsequent requests. Input token counts are only known after a request, so a single response can exceed the requested token cap; that stops further actions and is reported as an error. Missing required usage also stops budgeted runs. This is not a provider-side billing limit.

`--max-cost` requires `--prices rates.json`, with entries such as `{ "YOUR_MODEL_ID": { "input": 1, "output": 2, "cached": 0.5 } }` (example rates only, in USD per million tokens). It reserves a conservative input-byte/output-token allowance before requests and checks costs afterwards. Computed tariff costs are labeled separately from provider-reported dollars; reported dollars are shown only when the response explicitly identifies USD. Missing usage, unpriced returned models, and unexpected overruns stop further actions. Taxes, discounts, provider fees and invoice totals are not inferred.

`--policy policy.json` accepts a rules array, for example `{ "rules": [{ "tool": "run_command", "action": "ask", "commandRegex": "npm" }, { "tool": "write_file", "action": "deny", "pathRegex": "^generated/" }] }`. Actions are allow/deny/ask; matching denies take precedence. Built-in file paths are normalized before policy matching. Rules gate tool calls, not every read made by the initial context scanner; select context separately. Policies cannot turn a read-only mode into an editing mode. In `ask` mode an approved file target can be remembered for the session; command approvals are tied to exact executable/arguments/cwd.

`AGENTS.md` and `CLAUDE.md` at the selected root are loaded as project rules. `project_knowledge` stores/searches local decisions, preferences, failures and notes. Retrieval combines BM25 with deterministic local hashed vectors; it is not a neural embedding model. Skills are discovered in `.agents/skills`, `.own-cli/skills`, and `%OWN_CODEX_HOME%/skills` (default `.own-codex/skills`). Metadata matches descriptions; the full `SKILL.md` is loaded only on demand. No repository MCP processes are auto-started.

`--mcp config.json` explicitly connects up to eight stdio or Streamable HTTP servers, with up to 64 namespaced tools. See [examples/mcp.json](examples/mcp.json). HTTP JSON and SSE replies are supported; the older two-endpoint HTTP+SSE transport is not. Credential environment variables are filtered from stdio children unless listed in `passEnv`; HTTP bearer credentials use `env_key`. Unknown/mutating MCP tools remain unavailable in read-only mode unless the server marks them read-only. Server annotations are assertions from a trusted configured server, not a sandbox.

`--subagents` enables Explore, Plan and Review children with separate read-only loops and summary-only returns. Implement children get a fresh Git worktree, their own session/checkpoints, and return file artifacts for review; they never auto-merge. At most three children are allowed per parent turn, with no recursive delegation. `--planner-model` and `--lookup-model` explicitly select cheaper/different models on the same provider; no paid fallback is silently selected. Child usage shares the parent's budgets.

`--worktree` requires a Git repository with a committed HEAD, creates a branch/checkout under the local project store, and starts from committed files. Uncommitted/untracked parent work is not copied. Worktrees are retained for review; inspect/remove them with Git when finished. Resume using the printed worktree root. LSP/AST/browser tools, ACP, a full-screen TUI, neural embeddings, and automatic checkpoint/rollback of arbitrary shell effects remain future work; they are not advertised as implemented.

## Context limits

Defaults:

| Option | Default |
| --- | ---: |
| `--max-output-tokens` | 4096 |
| `--max-context-chars` | 24000 |
| `--max-file-chars` | 6000 |
| `--timeout-ms` | 120000 |

The timeout covers the entire request, including response-body reads and streaming. Unknown options, missing values, invalid numbers, and incompatible option combinations fail visibly. Both `--option value` and `--option=value` are supported. Use `--` before prompt text that starts with a dash.

Automatic discovery skips generated and hidden infrastructure folders, common credential filenames, symlinks/junctions, and common `.gitignore` patterns (`*`, `**`, `?`, anchored paths, directory rules, and `!` negation). Known source folders such as `.github`, `.gitlab`, `.devcontainer`, `.storybook`, and `.well-known` remain discoverable. Ignore handling is a bounded local scanner, not a complete Git implementation; global Git excludes and all advanced escaping/character-class patterns are not supported. Review `context --json` before sharing unfamiliar repositories: secret values inside ordinary source files cannot be identified by filename filtering.

Explicit `--file` selections can include arbitrary text files and override discovery/ignore selection. Explicit `--dir` selections scan the named folder with its own nested ignore rules; ancestor ignore rules do not restrict that focused scan. Common credential paths and paths resolving outside the root remain blocked. Missing or invalid explicit paths cause an error. Binary files are omitted with a warning.

Scanning is capped at 300 candidate files, 1000 directories, and 10000 directory entries per scan. Files are read in bounded excerpts; the strict character budget includes separators and JSON escaping. Snapshot content is JSON-quoted. Metadata distinguishes discovered names from file contents actually supplied and flags excerpts/omissions. A listing is not evidence that the model saw a file's contents.

`--all-context` or `/context all` expands the default snapshot to **1000000 characters**, **200000 characters per file**, and a scan of up to 5000 candidate files, 10000 directories and 100000 entries. It includes eligible text with arbitrary extensions, keeps generated/credential/ignore exclusions, and reports any omitted or excerpted files. Explicit `--max-context-chars` and `--max-file-chars` still take precedence. Large projects cannot be placed in a model prompt without limits; the agent can list, search, and read additional project files on demand in either context mode. Read tools return byte cursors for pagination. Text writes/edits are capped at 2 MiB per file, and command output is capped at 24000 characters with a 60-second default timeout (up to 300 seconds).

## Other providers

For a local service without authentication:

```toml
model = "your-local-model"
model_provider = "local"

[model_providers.local]
base_url = "http://localhost:1234/v1"
wire_api = "chat"
requires_openai_auth = false
```

Use `wire_api = "responses"` for Responses endpoints, or `"chat"` / `"chat_completions"` for Chat Completions. The Chat Completions adapter sends `max_tokens`; providers that require additional or different fields need an adapter change. The CLI does not silently switch protocols. Multiple-key failover is limited to explicit pre-response HTTP credential/quota rejections described above.

Native `wire_api` values `anthropic`, `gemini`, and `ollama` support their message/content formats, native tools, streaming, and continuation metadata. Built-in provider names select their usual base URL and named key variable; use an explicit `--model YOUR_MODEL_ID`, or configure the model and provider table. `--provider` can select any configured provider. Anthropic's API version defaults to `2023-06-01` and can be set with `api_version = "YYYY-MM-DD"` in its provider table. Native adapters are validated against local protocol fixtures; external provider/model access still requires valid credentials and compatibility with that provider's supported version.

## Environment settings

| Variable | Purpose |
| --- | --- |
| `OWN_CODEX_HOME` | Config folder; defaults to `%USERPROFILE%\.own-codex` |
| `OWN_CODEX_CONFIG_PATH` | Explicit config file |
| `OWN_CODEX_AUTH_PATH` | Explicit auth file |
| `OWN_CODEX_PROVIDER` | Provider table selection |
| `OWN_CODEX_MODEL` | Requested model |
| `OWN_CODEX_BASE_URL` | HTTP(S) endpoint base, usually ending in `/v1` |
| `OWN_CODEX_MAX_OUTPUT_TOKENS` | Positive integer response budget |
| `OWN_CODEX_TIMEOUT_MS` | Positive integer whole-request timeout |
| `APINEX_API_KEY` | Key for the `apinex` provider |
| `OPENAI_API_KEY` | Key for the `openai` provider |
| `ANTHROPIC_API_KEY` | Key for the `anthropic` provider |
| `GEMINI_API_KEY` | Key for the `gemini` provider |
| `OWN_CODEX_VAULT_KEY` | Non-Windows encrypted-vault unlock key; never stored in the vault |

A provider can set `env_key = "MY_PROVIDER_KEY"`. Authentication precedence is that variable, the provider's named environment variable, its encrypted-vault entry, then the selected legacy `auth.json`. A global OpenAI key is not implicitly sent to APInex. Headers receive credentials inside the provider layer; they are not included in model prompts or tool schemas. Config reports print the credential source without key characters, and known active keys are redacted from audit events/errors. Arbitrary programs run without an OS sandbox still have your account's privileges, including access to account-owned files.

## Verification

```powershell
npm test
npm run test:coverage
npm start -- --help
```

Tests use temporary fixtures and local HTTP servers, covering argument parsing, real subprocess output/exit codes, both API protocols, JSON fallback, split Unicode/CRLF streams, completion validation, timeout/cancellation, errors, setup backups, context boundaries, ignore rules, and long conversations. They do not call external providers or consume your API credits. `doctor --live` is the separate external connectivity check.

Agent tests also exercise real file creation/editing, overwrite backups, permission changes, directory boundaries, tool-result continuations, fragmented streaming function calls, command execution, command timeout/cancellation, and expanded context. To explicitly verify native tools with an external provider in a temporary directory, run `npm run test:live-agent -- free/gpt-6-luna`. This sends a small generation task that creates a file, reads it back, and runs a verification command; it uses the configured provider/key and consumes its quota. The fixture directory is removed after verification. Protocol implementation follows the [official OpenAI function-calling documentation](https://developers.openai.com/api/docs/guides/function-calling).

`npm run test:live-runtime -- free/gpt-6-luna` additionally verifies session closure/resume, audit hashes and undo after a live tool task. Automated tests use local HTTP/MCP fixtures and temporary Git repositories; DPAPI is exercised on Windows, while bubblewrap execution requires a separate Linux validation host. See [ARCHITECTURE.md](ARCHITECTURE.md) for the support matrix and protocol references.
