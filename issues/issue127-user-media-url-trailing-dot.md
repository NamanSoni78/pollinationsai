# Issue 127 — trailing-root-dot loopback names bypass `validateUserMediaUrl` (`localhost.`, `foo.localhost.`)

- **Severity:** High (SSRF guard bypass on every user-media fetch gate — the issue-14 surface without needing a redirect)
- **Affected:** `shared/user-media-url.ts:7-26` (`isBlockedUserMediaHost` / `validateUserMediaUrl`) — upstream `pollinations/pollinations` main @ `8fc4c212a4`
- **Exposure map:** `gen.pollinations.ai/src/userImage.ts:36-38` (`fetchUserImage` — including the `redirect: "manual"` legs at `src/text/transforms/imageUrlToBase64Transform.ts:37-40` and `src/text/transforms/mediaToBedrock.ts:37`, where this validator is the **sole** gate by design); `src/routes/audio.ts:255-269` (`reference_audio`); `src/audio/sonilo.ts:36` (`reference_video`); `src/image/params.ts:54` + `src/image/utils/imageDownload.ts:119` (`image=`); `src/embeddings/input.ts:71` (`image_url`)
- **Fix branch:** `solution127-user-media-url-trailing-dot` — fork PR [#142](https://github.com/NamanSoni78/pollinationsai/pull/142)
- **Dedup:** the SSRF family (issues 11/14/16/20/57/78) covers policy *coverage* gaps (scrapers, redirect hops, 3d forwarding, deadlines, platform-zone destinations); none covers canonicalization *inside* `validateUserMediaUrl`. The WORKLOG kill note "numeric-IP obfuscation empirically killed (WHATWG canonicalizes)" concerns IPv4 literal obfuscation — the trailing-dot **name** forms are not canonicalized by the URL parser (`new URL("http://localhost./x").hostname === "localhost."`, verified). The "DNS rebinding subsumed by issue 14's class" kill note is a different mechanism (resolution-time, not syntactic). The sibling community validator `shared/community-endpoint-urls.ts:107-111` strips the trailing dot — the asymmetry proves intent.

## Root cause

`BLOCKED_HOSTNAMES = /^localhost$/i` requires the exact 9-character form, and the suffix rule checks `.endsWith(".localhost")`. WHATWG URL keeps the trailing root dot in the hostname, so:

- `http://localhost./x` → hostname `"localhost."` — matches neither rule;
- `http://foo.localhost./x` → `"foo.localhost."` — ends with `".localhost."`, not `".localhost"` → matches neither rule;
- the literal-IP rule (exactly 4 dotted parts) never fires on these names.

RFC 6761 §6.3 mandates that resolvers answer the absolute form `localhost.` with 127.0.0.1, so the worker-side fetch targets the colo loopback — exactly the destinations the guard exists to refuse, on the no-redirect paths where this validator is the only gate (the repo's own comment at `imageUrlToBase64Transform.ts:29-31` refuses redirects precisely because "a redirect lands on a host the URL guard never saw" — here the guard never saw the host *without* any redirect).

## Safe reproduction (deterministic offline; $0 live)

`gen.pollinations.ai/test/user-media-url.test.ts` — 4 tests **red on unpatched `8fc4c21`**:

- `validateUserMediaUrl("http://localhost./x").ok === true` (also `foo.localhost.`, `LOCALHOST.`, `FOO.LOCALHOST.` — the parser lowercases hostnames but preserves the dot);
- controls stay blocked on both sides: `http://localhost/x`, `http://foo.localhost/x`, `http://127.0.0.1/x`, `http://127.0.0.1./x` (IPv4 trailing-dot is parser-normalized), `http://[::1]/x`;
- public absolute names stay allowed: `https://example.com./x` (a legal DNS absolute name — the community validator allows the same form after its strip).

Live control probe design (issue-14 style, own key, sub-cent): submit a chat completion with `image_url=http://localhost./x` vs `http://localhost/x` — the guard-rejection error vs a fetch-failure error differ, proving production passes the dotted form. Not executed this round (offline PoC deterministic at the validator level; the production call chain is already live-verified by issue 14's probes).

## Fix (`solution127-user-media-url-trailing-dot`)

One line, mirroring the sibling: `host.toLowerCase().replace(/\.$/, "")` before the blocked-name rules — `localhost.` → `localhost` (regex match), `foo.localhost.` → `foo.localhost` (suffix match). The dot-strip also lands before the literal-IP 4-part check, hardening `1.2.3.4.` forms even though the URL parser already normalizes IPv4.

## Verification

12/12 green (4 red-on-main + 8 controls); `imageUrlToBase64Transform` + `media-cache` sibling suites 35 green; `tsc --noEmit` clean.
