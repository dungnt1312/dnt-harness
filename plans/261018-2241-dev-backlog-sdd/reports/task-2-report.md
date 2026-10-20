# Task 2 report

## DeepSeek reasoning smoke (PH4-G): pass
- providers.json `ocproxy-2` stores `apiKey` in plain text; baseUrl has no `/v1` and `DeepSeekProvider` posts `{baseUrl}/chat/completions`, so the stored baseUrl was used as is.
- Scratch runner (outside repo) read the entry and spawned `bun scripts/smoke-deepseek-reasoning.ts deepseek-v4.1-flash-free` with DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL in the child env only; output was redacted.
- Result: `PH4-G pass: model=deepseek-v4.1-flash-free assistants=3 withReasoning=1 toolResults=2` then `assistants=5 withReasoning=2 toolResults=3`; exit 0.

## Public HTTPS MCP (RH1-G): partial pass
- Scratch script built `McpServerClient` (default outbound transport, custom Undici connect) for https://mcp.deepwiki.com/mcp under Bun 1.4.3: connected, tools/list returned ask_wiki_question, read_wiki_contents, read_wiki_structure; called read_wiki_structure (isError=false, audit call:false).
- OAuth refresh/revoke not run: configured OAuth servers (clickup, notion) are real accounts; refresh/revoke would mutate live tokens. Media not run.

## Changes
- Only plans/261017-runtime-provider-hardening/reports/phase-06-final-report.md (rows PH4-G, RH1-G, pending gates 3/4, follow-up 3). No product code change, no bugs found. No secret printed or stored.
## Concerns
- PH4-G proves the ocproxy proxy, not first-party DeepSeek.
