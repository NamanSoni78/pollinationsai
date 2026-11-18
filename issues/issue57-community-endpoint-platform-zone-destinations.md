# Issue 57 — Community endpoints accept the platform's own zones as destinations: self-referential proxy loops (streaming egress-bucket amplification, coordinator self-join deadlock, agent cycles)

- **Severity:** High (cross-tenant DoS amplification against the shared Workers-egress IP bucket; coordinator DO deadlock; free to run — owner traffic on private models bills $0)
- **Affected:** `shared/community-endpoint-urls.ts` (`validateCommunityEndpointUrl`/`isBlockedHostname`), `enter.pollinations.ai/src/routes/community-endpoints.ts:88` (registration), `gen.pollinations.ai/src/community-models.ts` (catalog/runtime), `gen.pollinations.ai/src/text/communityEndpoint.ts:186-197` (the proxy config: `directEndpoint: endpoint.baseUrl` + stored bearer + free-form `upstreamModel`) — upstream `pollinations/pollinations` main @ `52fd0a6c824`
- **Fix branch:** `solution55-community-self-origin-block` — **PR:** [#66](https://github.com/NamanSoni78/pollinationsai/pull/66)

## Root cause

The community-endpoint destination policy refuses only private/loopback/credentialed hosts. The platform's **own public zones all pass** — live module probe on unpatched `main` (read-only, `node --experimental-strip-types` against the real module):

```
ACCEPTED : https://gen.pollinations.ai/v1/chat/completions
ACCEPTED : https://api.pollinations.ai/v1/chat/completions
ACCEPTED : https://mcp.pollinations.ai/mcp/composio
ACCEPTED : https://enter.pollinations.ai/api/anything
ACCEPTED : https://image.pollinations.ai/x
ACCEPTED : https://media.pollinations.ai/y
ACCEPTED : https://something.myceli.ai/z
ACCEPTED : https://evil.pollinations.ai.attacker.com/v1   (correct: attacker-owned, not a platform zone)
REJECTED : https://127.0.0.1/v1 → "Endpoint URL cannot target a private host"
```

Registration never probes the endpoint, `visibility: "private"` needs no publish allowlist, `perUserRpm` defaults null (`model-rate-limit.ts:11-12` → no per-user limit), and `upstreamModel` is free-form (`schemas.ts:135`). At runtime, for `type: "proxy"` the leg builds:

```ts
{ provider: "openai", authKey: /* decrypted stored bearer */,
  model: endpoint.upstreamModel,
  ...(api === "responses" ? { responsesEndpoint: endpoint.baseUrl }
                          : { directEndpoint: endpoint.baseUrl }) }
```

so one call to the owner's own model makes gen `fetch` the platform zone with the owner's key; the nested request re-enters the full public path (edge limits → D1 auth → model resolution → community leg → …) and fetches the same destination again. **No depth, destination or cycle guard exists anywhere on the path.** `global_fetch_strictly_public` (gen `wrangler.toml:11`) guarantees the self-fetch goes through the public zone — the config's own `GENERATION_EXECUTION_ORIGIN = "https://gen.pollinations.ai"` documents that gen self-fetch works.

**Variants:**

| Variant | Mechanism | Bound |
|---|---|---|
| A — streaming | `stream: true` skips dedup (`generation-deduplication.ts:170-172`); each hop is a real pending request awaiting its child's first SSE event | nested against the saved key's 600/10 s edge bucket and — the real payload — the **shared Workers-egress IP bucket (1000/10 s per colo, gen wrangler.toml:210-221)** that all platform worker→gen traffic shares; sustained until the 300 s community deadline |
| B — non-streaming | the nested request re-joins the same GenerationCoordinator identity and parks as a joiner (`GenerationCoordinator.ts:119-133`) while its own execution awaits it | self-join deadlock per outer request, wedging a coordinator DO until the 125 s origin-fetch timeout (`:263-292`) |
| C — agent cycles | `requireValidBaseModel` blocks agent→agent but allows a prompt agent's baseModel to be any community proxy; a proxy pointing at the agent (or at `mcp.pollinations.ai`, also accepted) yields agent↔proxy cycles on free owner traffic with 1800 s run tokens | minutes-long self-sustaining loops of full 24-step agent executions |

The amplification bounds in variants A/B are **architecture-derived estimates** from the in-repo rate-limit configuration and coordinator timeouts, not measured in production — no load was ever generated against production (that would be the destructive prong this program never exercises). The mechanism itself (re-entry with the stored bearer, no guard) is pinned by the tests below.

**Cost to the attacker:** owner traffic on private models is billed $0 (`shared/billing/track-helpers.ts:226-242`), so the loop is free to run; two concurrent requests can occupy the shared egress bucket that the MCP gateway's own tool calls use — cross-tenant impact.

## Safe reproduction (non-destructive)

1. **Live module probe** (above) — read-only import of the real validator; platform zones accepted on unpatched `main`.
2. **Red on unpatched `main`** (`gen.pollinations.ai`, `npx vitest run test/community-endpoints.test.ts -t "self-origin"`):
   - `refuses platform zones as endpoint destinations` — FAIL: `expected [Function] to throw an error` (the policy accepts `gen/api/mcp/enter/image/media.pollinations.ai`, `pollinations.ai`, `*.myceli.ai`, trailing-dot spellings).
   - `drops a proxy pointed at the platform instead of fetching it` — FAIL: `expected [ …(6) ] to have a length of +0 but got 1` (`getCommunityModelRegistryEntries` **serves** the gen-zone row), and the request-level assertion fails `expected 200 to be 400` — a full-pipeline request to the self-referential model **completes 200** through the real leg.
3. **Honest harness note:** the leg's outbound fetch routes at the workerd level and does not traverse the vitest test realm's `globalThis.fetch` (stubbing captured the pipeline's analytics fetches but not the leg hop), so the full in-sandbox recursion count is not asserted; the loop is instead pinned at the three layers that decide it — policy, catalog membership, and request outcome — plus the module probe and the code trace above (issue-14 precedent: layered evidence, no destructive live run).

## Fix (`solution55-community-self-origin-block`)

1. `shared/community-endpoint-urls.ts`: `validateCommunityEndpointUrl` refuses the platform's own zones via `isPlatformZoneHostname` (`/(^|\.)(pollinations|myceli)\.ai\.?$/` after house hostname normalization — the exact host set `fetchClientMetadata` already refuses for OAuth client ids). One rule covers Enter registration, every runtime URL builder (`communityResponsesUrl` et al.), and both apps that import the shared validator.
2. `gen.pollinations.ai/src/community-models.ts`: the catalog drops rows whose `baseUrl` fails validation (same pattern as the existing missing-field drop), so **pre-existing rows are neutralized at request time too** — the model resolves as "invalid model", indistinguishable from a nonexistent one.
3. Tests: 10 blocked-zone and 6 must-stay-open spellings (attacker lookalikes, `notpollinations.ai`, `.invalid` agent placeholders); registry-drop pin; request-refusal pin; a new Enter-API test registering four platform-zone URLs expecting 400 `"Endpoint URL cannot target the platform's own zone"`.

**Product-behavior change, stated openly:** the former "Pollinations-compatible endpoint" test enshrined the exact self-referential configuration this removes (registering `url: https://gen.pollinations.ai/v1/chat/completions` and proxying through it). That e2e coverage is preserved against a normal upstream (`upstream.example.com`) — same registration/maturation/`/test`/throttle/gen-usage flow. If upstream wants to keep a platform-pointing mode, it needs a depth guard (hop marker refused on re-entry) plus explicit rates — an open destination is the vulnerability, not the feature.

## Verification

`npx vitest run test/community-endpoints.test.ts` — **166/166** (163 existing + 3 new/rewritten; the only existing test changed is the enshrined-pattern one above, rewritten, plus its replacement coverage). `npm run typecheck` (`tsc --noEmit`) clean. Composio/media/realtime suites untouched. No production state created; no billing path exercised.
