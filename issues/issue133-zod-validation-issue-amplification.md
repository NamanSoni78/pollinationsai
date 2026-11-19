# Issue 133 — zod < 4.6.6 validation-issue amplification: an anonymous ~1.6 MB body OOMs the shared gen isolate before auth runs (GHSA-mrhx-c7xc-m3w5)

- **Severity:** High (availability — deterministic cross-tenant isolate kill on the platform's flagship worker, pre-auth, pre-billing, within every shipped body cap; the same accepted class as registry issues 85/94/114)
- **Affected (upstream `main` @ `4f3585e97`):** zod pinned **4.5.4** in `package.json` / `enter.pollinations.ai` / `gen.pollinations.ai` / `media.pollinations.ai` / `shared` (root lockfile), and **4.4.3** in `packages/mcp`, `apps/exa-mcp`, `apps/ffmpeg-mcp` (+ 4.6.5 in `apps/ask-jev-mcp` — also < the 4.6.6 fix). Uncapped user-facing arrays: `gen.pollinations.ai/src/text/messages/schema.ts:172` (`messages`), `shared/schemas/openai.ts` (`messages`, `tools`), `gen.pollinations.ai/src/schemas/embeddings.ts:69` (content-parts), `media.pollinations.ai/src/index.ts:243` (`tags`), `packages/mcp/src/services/{imageService:148,182, model3dService:57, textService:186, embeddingService:65}`, `apps/exa-mcp/worker.js:168` (`urls`).
- **Fix branch:** `solution133-zod-issue-amplification` (off `upstream/main` `4f3585e97`) — fork PR [#149](https://github.com/NamanSoni78/pollinationsai/pull/149)
- **Dedup:** registry issues 85/94 (unbounded MCP body *reads*, fixed by byte caps — this mechanism **defeats byte caps by design**: a 1.6 MB body produces ~200 MB of issues), issue 114 (CPU-quadratic responses adapter), issue 55 (fetched-media retention), issue 117 (declared body-limit bypass) — none cover validation-time issue accumulation. The exa `urls` cap also implements the exa-mcp leg of the F-02 unbounded-urls finding (complementary). The MCP SDK's own GHSA-f897/46jr advisories (same exhaustion class, already registered via 85/94) are addressed upstream by bumping `@modelcontextprotocol/server` ≥2.3.0 — noted in the PR, out of scope here.

## Root cause

zod's `$ZodArray.handleArrayResult` appends one issue object (~1 KB each, measured) per failing element with no cap or early termination ([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), HIGH, CWE-770, fixed in 4.6.6). Every user-facing request schema declared unbounded element-count arrays, and the shared validator (`shared/middleware/validator.ts` → `safeParse`) materializes the **full** issue array before the handler uses only `result.error[0]`. The route chains validate before any auth or billing middleware (`textBodyLimit` → `validator("json", ...)` → handler on `/v1/messages`, `/v1/chat/completions`, `/text`, `/v1/embeddings`; garbage-bearer reachable on the MCP workers), so the allocation happens for anonymous callers.

**Measured on the exact pinned versions** (`node --expose-gc`, 100,000 `{"role":"nope"}` elements = 1.53 MiB JSON):

| zod | issues materialized | heap growth | amplification |
|---|---|---|---|
| 4.4.3 (MCP pins) | 200,000 | **+341 MiB** | **223×** |
| 4.5.4 (root workspace) | 200,000 | **+215 MiB** | **141×** |
| 4.6.6, unconstrained | 200,000 | +171 MiB | still accumulates |
| 4.6.6 + violated `.max()` | **1** | **+0.1 MiB** | short-circuit |
| 4.5.4 + violated `.max()` | 200,001 | +198 MiB | cap does NOT help on 4.5.4 |

A ~1 MB body is below every cap the platform has ever shipped (1 MiB ask-jev, 4–8 MiB MCP, 32 MiB text, 100 MiB media JSON) yet allocates >128 MB of retained issues against the 128 MiB workerd isolate → isolate reset ("error 1102"-class), killing all co-hosted in-flight requests on the shared worker, repeatable per request.

## Safe repro (deterministic offline; $0 live)

`gen.pollinations.ai/test/text/validation-issue-caps.test.ts` — **RED on unpatched `4f3585e97`** (5 failed: zod-version pin 4.5.4; both message-array cases produce 100k issues instead of ≤2; cap controls) / 2 passed. Companion `packages/mcp/test/zod-issue-caps.test.js` + the standalone measurement harness (amplification table above).

## Fix (both parts required — each alone measured insufficient)

1. **zod bump**: `4.5.4 → 4.6.6` in the five root-workspace package.jsons (lockfile: zod entries only); `^4.2.0/^4.4.3 → ^4.6.6` in packages/mcp + exa/ffmpeg/ask-jev (lockfiles resolve 4.6.7). On ≥4.6.6 a violated `.max()` aborts element validation and returns exactly 1 issue.
2. **Array caps** (tunable policy): `messages` `.max(2000)` on both the Messages and ChatCompletion schemas (`MAX_MESSAGES_PER_REQUEST` exported from `shared/schemas/openai.ts`), `tools` `.max(128)` (OpenAI's documented tools limit), embeddings content-parts `.max(32)` (matches the existing string-batch cap `MAX_EMBEDDING_BATCH_SIZE`), media `tags` `.max(32)` (embeddingService convention), MCP `image`/model3d reference arrays `.max(20)` (maxReferenceImages convention), textService content `.max(100)`, exa `urls` `.max(50)`.

## Tests

- **RED on main:** 5 failed / 2 passed (`validation-issue-caps.test.ts`).
- **GREEN with fix:** 7/7; affected gen suites (requestSchema, messages, api-examples, messages-thinking) **96/96**; gen `tsc --noEmit` clean.
- media full suite **81/81**; media `tsc` = the 1 pre-existing `request-inputs.ts(139)` error only (documented pre-existing).
- packages/mcp **54/54** (incl. 5 new zod-cap tests); ffmpeg-mcp 14/14; exa-mcp suite green; ask-jev syntax-checked.
- enter `tsc`: the same 2 pre-existing `accountPermissions` errors as clean main (verified side-by-side) — nothing new.

## Notes for maintainers

- Cap values are policy knobs — the security property only needs *a* cap (any violation short-circuits on ≥4.6.6); 2000 messages / 128 tools were chosen to sit above every legitimate use we could find in the repo and docs.
- The dependency sweep that found this (round 45, subagent 45-A) also recommends as follow-ups: bump `@modelcontextprotocol/server` 2.0.0 → ≥2.3.0 (GHSA-f897/46jr — the upstream complement to issues 85/94), add lockfiles to the 4 apps without them (discord-bot-family, catgpt-bot, opposite-prompt-bot, reimagine — axios pins unverifiable), and move root `wrangler` to devDependencies (deploy CLI, never bundled). All other runtime-dep advisories were verified unreachable (better-auth plugins not enabled, seroval SSR never invoked, hono jwt/serveStatic not used, undici preconditions absent — full table in the round-45 WORKLOG).
