# Issue 110 — the enter-wide body-limit completion: the Stripe webhook (the money-path leg issue 105's sweep missed), the parse-before-401 validator class, and better-auth's library-level parse

- **Severity:** High (availability — unauthenticated isolate memory exhaustion on the shared enter control-plane worker; the completion of issue 105's anonymous-body sweep with zero file overlap)
- **Affected (all on upstream main, verified line-by-line):**
  - `enter.pollinations.ai/src/routes/stripe-webhooks.ts:577` — `await c.req.text()` **before** `verifyWebhookSignature` at `:588`. The money-path webhook is unauthenticated by design and fully buffers an attacker-sized raw body in the 128 MB isolate before the HMAC can reject it. Issue 105's sweep gated the **GitHub** secret-scanning webhook only — this route is the leg it missed.
  - The parse-before-401 class: `validator("json")` runs ahead of `requireUser()` on `POST /api/device/approve` (`device.ts:207` parse before `:209`), `POST /api/oauth/code` (consent, `oauth.ts:90` before `:92`), `POST /api/account/keys` (+PUT `:id`), `POST /api/account/polli/harness-on`, the six `POST /api/account/my-models/*` routes, `POST /api/account/integrations`, and `POST /api/account/sites/:name/upload`'s manifest — every one buffers the whole body for an anonymous caller before the 401. Issue 105 mounted limits on the deviceRoutes app and `/api/oauth/token` only.
  - better-auth's `/api/auth/*` family (`api.ts` `.route("/auth", …)`) parses JSON bodies at the library level with no bodyLimit configured anywhere in the enter auth stack.
- **Fix branch:** `solution106-enter-api-body-limit` (branch number predates the round-35 renumber; maps to this issue) — **PR:** fork [#125](https://github.com/NamanSoni78/pollinationsai/pull/125) (upstream PR creation remains 403-blocked by the token's `pull_requests:read` scope).
- **Relationship to issue 105 (concurrent, file-disjoint, complementary):** issue 105 / PR #119 gates the github-secret-scanning webhook (1 MiB) and the deviceRoutes app + `/api/oauth/token` (64 KiB) with mounts **inside the route modules**. This companion mounts the one enter-wide gate in `src/index.ts` — zero shared files, composing in layers: the enter-wide 8 MiB bound first, their tighter per-route ceilings last. The remaining deltas this issue owns are the Stripe webhook, the parse-before-401 validator class, and better-auth. Withdrawn duplicate: this session's `/register` finding was independently delivered as issue 108 / PR #122 by the concurrent round-34 session (PR #124 closed with the cross-reference).

## Root cause

Enter is the platform's auth/billing control plane, yet apart from issue 105's two route-local gates nothing bounds request bodies on it. `index.ts` mounts `cors → requestId → logger → X-Robots → rateLimit → /api routes` with no body gate, so every body-consuming handler not covered by issue 105 reads first and authenticates/verifies second. The Stripe webhook is the sharpest edge: signature verification *requires* the raw body, so the read cannot be reordered — a byte ceiling before the read is the only fix. An unauthenticated POST with an oversized body (Cloudflare accepts 100 MB+) buffers fully inside the shared isolate before a 400/401 is produced, and a handful of concurrent ones OOM the isolate simultaneously serving `/api/account/*`, Stripe billing, and OAuth for every user.

## Safe reproduction (non-destructive)

`enter.pollinations.ai/test/api-body-limit.test.ts` (new, 6 tests, real workerd `SELF.fetch`, no production traffic):

- **RED on unpatched main:** `POST /api/webhooks/stripe` with a 9 MiB body returns `400 Missing signature` — the full read ran, no 413 path exists on the route; same for `/api/webhooks/github-secret-scanning` (bogus signature headers so the presence check passes), `/api/oauth/token`, and `/api/device/code`.
- **GREEN with the gate:** all four return `413` naming the 8 MiB ceiling, before any handler runs.
- **Controls (unchanged):** a normal-size signature-less Stripe webhook still gets the route's own `400 Missing signature`; a normal-size device-code body with an unknown client still parses to `400 invalid_client`.

## Fix (`solution106-enter-api-body-limit`)

One enter-wide gate, mounted ahead of the rate limiter (and every handler):

```ts
// enter.pollinations.ai/src/index.ts
const API_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
const apiBodyLimit = bodyLimit({                 // hono/body-limit — the sites.ts precedent import
    maxSize: API_BODY_LIMIT_BYTES,
    onError: () => { throw new HTTPException(413, { message: "Request bodies on this API can be at most 8 MiB." }); },
});
…
.use("/api/*", apiBodyLimit)                       // before .use("/api/*", rateLimit(...))
```

Sizing follows the repo's own precedent: 8 MiB is the MCP-gateway cap (issue 94, chosen over the 5 MB `deploySite` payloads with headroom) and clears the largest legitimate enter body — the 5 MiB inline site deploy (`SITE_LIMITS.bytesPerInlineDeploy`) — whose route-local gate and error message stay first-in-line (5 MiB < 8 MiB), so no existing behavior or test changes. Site *file bytes* never transit this worker (Cloudflare direct upload URLs). Composes with issue 105's tighter per-route limits (1 MiB webhook / 64 KiB token endpoints), which run deeper in the chain and stay the effective ceiling on their routes.

`tsc --noEmit` byte-identical error count to unpatched main (193, all pre-existing un-built-UI); surrounding enter suites green: sites (incl. the 5 MiB inline-deploy gate first-in-line), device-auth, oauth-code, account-key/balance, admin-auth, stripe, oauth-provider — 157 tests total.
