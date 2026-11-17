# COVERAGE_MATRIX

| Module | Investigator | Status | Notes |
|---|---|---|---|
| enter/src/routes/auth | W1-A | covered (rounds 3–6) | controls verified; issue 9 fixed |
| enter/src/routes/payments | W1-B | covered (rounds 3–6, R7-C) | issue 17 fixed (refund/dispute reversal) |
| gen/src/routes/realtime | W1-C | covered (rounds 5–6) | controls verified |
| gen/src/routes/audio+text | W1-D | covered (rounds 1–7) | issues 1–4, 8, 16 fixed |
| apps/* MCP servers | W1-E | covered (rounds 1–2, R7-D) | issues 5–7 fixed; residual apps swept clean |
| shared/ billing+auth | W1-F | covered (rounds 2–7) | issues 10–11, 17 |
| operations/ + repo CI | R7-A | covered (round 7) | secrets SOPS-encrypted, workflow gates verified; 0 new |
| packages/ + pollinations.ai frontend | R7-B | covered (round 7) | no XSS sinks, OAuth solid; 0 new |
| media.pollinations.ai + image pipeline | R7-E | covered (rounds 4–5, 7) | issues 12–15; residual swept clean |
| pollinations.ai frontend (play) | R7-B | covered (round 7) | two newest play commits reviewed end-to-end |

Wave 2 of SECURITY_AUDIT.md is now fully swept. Next fresh areas: new upstream commits as they land (diff-audit), deeper product-level decisions on deferred candidates.
