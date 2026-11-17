# Issue: polli agent `web_scrape`/`fetch_file` fetch arbitrary internal destinations from the credentialed bot container (SSRF)

**Severity:** High
**Status:** Confirmed by unit test with mocked HTTP clients (2026-11-18, `bbccf2f5`)
**Fix:** PR https://github.com/NamanSoni78/pollinationsai/pull/14 (branch `solution11-polli-scraper-ssrf-guard`)

## Summary

The polli agent (`apps/polli/`) fetches **model-supplied URLs server-side** from inside its container:

- `web_scrape` (`src/ai/tools.py:676-827`) → `scrape_url` (`src/integrations/web_scraper.py`) → the rnet / scrapling / Jina Reader / crawl4ai-Playwright fetcher chain;
- `fetch_file` → `fetch_discord_attachment` (`web_scraper.py:1143+`) → a raw `aiohttp.ClientSession().get(attachment_url)` with a 30s timeout and **no destination policy and no size cap**.

Tool arguments are attacker-influenced — any guild member the bot engages with (`bot.py`), GitHub users @mentioning the bot on whitelisted repos (`webhook_server.py:311`), or instructions injected inside scraped pages and fetched files (prompt injection) — and the fetched content flows back into the model context whose reply is posted to the requesting channel: a complete request → fetch → exfil loop.

Neither path had a destination policy:

- `scrape_url`'s only validation was presence of scheme + netloc (`web_scraper.py:527-536` pre-fix) — the message says "must include http:// or https://" but the check passes **any** scheme and **any** host (Playwright's `page.goto` renders `file://localhost/...` paths);
- `fetch_discord_attachment` validated nothing at all.

The container (`compose.yaml`: default bridge network, `.env` secrets, GitHub App key at `/app/polli.pem`, no egress filtering; API and webhook server bound to `0.0.0.0`) makes the reachable set concrete: the polli API (`127.0.0.1:55288`), the GitHub webhook server, the docker gateway (`172.17.0.1`), other compose services, and on cloud hosts `169.254.169.254` (AWS/GCP/Azure metadata) and `metadata.google.internal`.

This is a **different root cause** from the previously fixed schema-only tool restrictions (issue #5): that fix gated *which tools/actions* run; this is the *fetch layer itself* having no URL destination policy.

## Root cause

Untrusted, model-controlled URLs passed directly into server-side HTTP clients and a headless browser without a scheme allowlist or private/loopback/link-local destination blocklist.

## PoC (isolated unit test, mocked `aiohttp`, no real network)

`apps/polli/tests/test_scraper_destination_policy.py` (integration test), run against unpatched `origin/main` (`bbccf2f5`):

```python
result = asyncio.run(web_scraper.web_scrape_handler(
    action="fetch_file",
    file_url="http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    file_type="json",
))
```

Observed on unpatched code (verbatim from the test run):

```
PoC fetch_file result: {'success': True, ..., 'parsed': {'secret': 'metadata-credentials'}}
PoC fetched URLs: ['http://169.254.169.254/latest/meta-data/iam/security-credentials/']
>>> VULNERABLE: internal endpoint fetched by the bot container
```

The (mocked) metadata endpoint was fetched from inside the container and its parsed contents returned — in production this is the credentials-exfiltration primitive; the same path reaches the webhook server, the polli API and any compose-network service.

## Impact

- **Cloud metadata / credential theft:** on cloud hosts, the container-role credentials (and the IMDSv2 token, if the host allows unauthenticated GETs) are one tool call away.
- **Internal service access:** the polli API and webhook server (both `0.0.0.0`), the docker gateway, and every compose-network neighbor are fetchable and their responses exfiltrated into the conversation.
- **`file://` scheme:** Playwright's `page.goto` follows `file://localhost/...` paths, exposing local files.
- **Reachability:** any Discord user the bot engages with, or any GitHub user able to @mention it on whitelisted repos (prompt-injection chains need no social engineering at all).

## Fix

`blocked_destination_reason()` in `apps/polli/src/integrations/web_scraper.py`, mirroring the platform's own guard (`shared/user-media-url.ts` on the Cloudflare workers):

- http/https only (rejects `file://`, `ftp://`, `gopher://`, …);
- rejects `localhost`, `*.localhost`, `*.local` and the cloud-metadata DNS names (`metadata.google.internal`, `metadata.goog`);
- rejects loopback, private, link-local, reserved, multicast, unspecified and CGNAT (100.64.0.0/10) addresses — `ada-url` normalizes WHATWG IPv4 forms (hex/octal/decimal) so obfuscated literals (`http://0x7f.0.0.1/`, `http://2130706433/`) are caught.

Applied **before any client call** in both `scrape_url` and `fetch_discord_attachment`; `scrape_multiple` delegates per-URL to `scrape_url` so it is covered. Public destinations — including Discord CDN attachments and literal public IPs — are unaffected.

Verification after fix: 17 blocked destinations rejected, 6 public allowed; `fetch_file` on the metadata URL refuses **before any client call** (recording mock sees zero requests); `fetch_file` on a public Discord CDN URL still fetches; `scrape_url` on an internal URL reaches none of the five fetcher layers; full polli suite **211 passed, 4 skipped** (pre-existing live skips); `ruff check` + `ruff format` clean.
