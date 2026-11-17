# SECURITY_AUDIT — Pollinations Platform (EXTREME MODE)

**Audit period:** 2026-11-17 (round 3; continuing rounds 1–2)
**Baseline:** upstream `pollinations/pollinations` main @ `2c09da7`
**Fork:** NamanSoni78/pollinationsai, tracking branch `issues_mds` @ `0fbc2a0`
**Authorization:** bug bounty / responsible disclosure context, own API key only

## Scope

| Area | LOC | Status |
|---|---|---|
| enter.pollinations.ai (auth/payments/keys/community) | 98k | Wave 1 |
| gen.pollinations.ai (generation API, realtime WS, audio/text/image) | 150k | Wave 1 |
| shared/ (billing, auth, registry, error, community) | 27k | Wave 1 |
| apps/ (MCP servers, agents, bots) | 41k | Wave 1 |
| operations/ (dashboards, CI) | 59k | Wave 2 |
| pollinations.ai (frontend) | — | Wave 2 |
| image.pollinations.ai / media.pollinations.ai | — | Wave 2 |
| packages/ | — | Wave 2 |

## Prior rounds (context, already reported)

Rounds 1–2 delivered 8 confirmed findings (issues_mds issues 1–8, PRs
#19951–#19962 + fork #10/#11). This round re-baselines to `2c09da7` and aims
for full-coverage independent discovery. **Dedup rule: anything with the same
root cause as issues 1–8 below is NOT a new finding.**

1. Pre-auth identity-blind generation cache (keyless replay)
2. xAI video post-render moderation unbilled
3. AssemblyAI timeout unbilled + no transcription size cap
4. Community text-proxy fetches no timeout
5. polli API tool restrictions schema-only
6. ffmpeg-mcp args protocol bypass
7. exa-mcp web_fetch_exa unbounded urls/maxCharacters
8. Community-endpoint upstream host/body disclosure

## Dedup registry, rounds 3–7 (issues 9–20 — same root cause = NOT a new finding)

9. Discord OAuth callback state replay → account takeover (provider-agnostic state, no PKCE, unverified-email trust)
10. Community publishers bill callers on unbounded self-reported usage
11. polli web_scrape/fetch_file SSRF (no destination policy from the credentialed bot container)
12. media JSON upload ≈4.6× pre-decode allocation OOMs the Worker below the documented cap
13. media upload gate misses agent-run `ag_` tokens (upload/publish while DELETE refuses)
14. User-media redirect hops skip the URL policy (SSRF via 302 to loopback/private/metadata)
15. EXIF UserComment unbounded public content + input URL disclosure on the media host
16. /3d/ routes forward unvalidated user URLs to providers (SSRF by proxy)
17. composio-mcp COMPOSIO_MULTI_EXECUTE_TOOL unbounded tools[] (billing + execution amplification under the platform key)
18. catgpt/opposite-prompt Discord bots: ungated, unrate-limited platform-key spend per mention with retry amplification
19. repo-auto-fix-polli-issues.yml untrusted issue content into a write-capable agent + job-env Pollen key + unused id-token write
20. gen fetchUserImage: no time bound on user-supplied image URL fetches (slow-loris slot pinning incl. detached coordinator alarms)

## Rules

- LIVE-TESTED findings only count toward the confirmed total.
- One root cause = one finding, regardless of affected endpoints.
- Severity: CRITICAL/HIGH/MEDIUM per real impact, no inflation.
- Sync gate: push `issues_mds` after every 5 confirmed findings.
