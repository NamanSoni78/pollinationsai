# COVERAGE_MATRIX

| Module | Investigator | Status | Notes |
|---|---|---|---|
| enter/src/routes/auth | W1-A | covered (rounds 3–6) | controls verified; issue 9 fixed |
| enter/src/routes/payments | W1-B | covered (rounds 3–6, 7s3, R9-C) | issue 23 fixed (refund/dispute Pollen reversal — resolves FINDINGS R3-D1) |
| gen/src/routes/realtime | W1-C | covered (rounds 5–6) | controls verified |
| gen/src/routes/audio+text | W1-D | covered (rounds 1–9) | issues 1–4, 8, 22 fixed |
| gen/src/image + user-image fetch | 7s3 / R9 | covered | issue 16 (3d URL policy), issue 20 (fetch deadline) |
| apps/* MCP servers + bots | W1-E / 7s3 / R9-D | covered (rounds 1–9) | issues 5–7, 17 (composio caps), 18 (discord bots), 21 (mcp audio) fixed; residual apps swept clean |
| shared/ billing+auth | W1-F | covered (rounds 2–9) | issues 10–11, 23 |
| operations/ + repo CI | R9-A | covered (rounds 7s3, 9) | secrets SOPS-encrypted, workflow gates verified; issues 19 (autofix untrusted content) fixed; community-monitor scoped-permissions hardening on `solution12-community-monitor-scoped-permissions` |
| packages/ + pollinations.ai frontend | R9-B | covered (rounds 8s4, 9) | no XSS sinks, OAuth solid; issue 21 (mcp audioService) fixed |
| media.pollinations.ai + image pipeline | R9-E | covered (rounds 4–5, 9) | issues 12–15; residual swept clean |
| pollinations.ai frontend (play) | R9-B | covered (round 9) | two newest play commits reviewed end-to-end |

Wave 2 of SECURITY_AUDIT.md is now fully swept (sessions 3–5 combined). Next fresh areas: new upstream commits as they land (diff-audit), deeper product-level decisions on deferred candidates.

| operations/infrastructure/gpu (zonos speech) | R15 | covered (round 15) | issues 50-51 (backend token, both-hop deadlines) + the mistral vision line (issue 49, companion to session-11's fleet-wide issue 46); flux/dreamshaper/klein previously swept clean; sessions 10-11 clean-lists superseded on the auth point |
| new-commit diff-audit b4d7ebcb..a38014db/8dd9e0ed | R14/R15 | covered (rounds 14-15, both sessions) | wording sweep, quests rework, games, packages/CI, community deadline, model registry — see both round-14/15 WORKLOG sections |
