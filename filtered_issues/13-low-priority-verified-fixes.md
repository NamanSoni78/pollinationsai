# F-13 — Appendix: verified, tested, low-priority fixes (take when convenient)

These five findings passed the same verification gate (red/green tests on real modules) but sit below the security-priority line of the main reports. They are real, their fix PRs are open and tested, and they are listed here so no verified work is lost in the consolidation.

| Issue | One-line | Verification | Fork PR |
|---|---|---|---|
| [#28](../issues/issue28-klein-truncated-response-acceptance.md) | Klein (4th GPU backend) accepts truncated image responses, caching and billing them as successes — upstream #18202 added completeness checks to the three sibling pools and missed the fourth; today's protection is incidental (CF Images re-encode) and silently off when the binding is absent | Integration test (mocked `KLEIN_VPC`, truncated PNG): unpatched 200 + cache write + $0.005 billed; fixed 502, zero billed events | [#32](https://github.com/NamanSoni78/pollinationsai/pull/32) |
| [#83](../issues/issue83-3d-docs-paid-balance-parity.md) | 3D docs still claim `microsoft/trellis-2` "works with the Quest balance" but every 3D model is `paidOnly: true` since `d7b749c2fc` — the documented default path 402s for every Quest-funded caller; first docs↔enforcement parity gate in the repo | Docs-parity tests (red on unpatched main); 402 path verified from registry flags + gate code | [#95](https://github.com/NamanSoni78/pollinationsai/pull/95) |
| [#89](../issues/issue89-nova2-reference-image-cap.md) | `amazon/nova-2-lite-v1` advertises 20 reference images; AWS Nova 2 documents **5** — every 6–20-image request downloads all sources (platform-paid egress) then fails a deterministic provider 400 on all three entry points | Unit red/green (6th image rejected pre-fetch with exactly 5 fetch calls asserted); AWS vendor doc verified; live 400 deliberately not probed (paidOnly) | [#101](https://github.com/NamanSoni78/pollinationsai/pull/101) |
| [#111](../issues/issue111-responses-transform-bypass.md) | The native `/v1/responses` direct path bypasses every model transform — the #19789 `reasoning.effort` remaps and the Mistral strip never run on it (free-form effort strings forwarded raw → settled 400/500s with no fallback on paidOnly models) | Unit red/green (remap function absent on main; none→low, max→xhigh, medium→stripped post-fix) | [#126](https://github.com/NamanSoni78/pollinationsai/pull/126) |
| [#112](../issues/issue112-effort-max-coverage.md) | `reasoning_effort:"max"` reaches providers unmapped (hard 400s on mandatory models) or silently downgrades (Claude 2048 vs 8192 budget; Gemini 4096); six same-deployment siblings of #19789-remapped models lack the remaps | Unit red/green (11+ red on main: 8 effort rows, 2 Claude, 1 Gemini; 452/452 green) | [#127](https://github.com/NamanSoni78/pollinationsai/pull/127) |

Notes:
- #126 + #127 (issues 111/112) are natural co-reviews — both complete upstream #19789's effort-remap sweep (the native path + the six siblings).
- #101 (issue 89) graduates the "doc nit" that issue 74's video-half fix explicitly deferred — same AWS limits table, image half.
- #95 (issue 83) is docs + a new parity test class — zero runtime risk.
- #32 (issue 28) is the only one with a billing consequence (garbage billed as success on the Klein pool); still availability/quality-tier rather than attacker-driven.
