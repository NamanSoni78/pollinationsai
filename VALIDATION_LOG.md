# VALIDATION_LOG

| ID | Candidate | Test method | Result |
|---|---|---|---|
| — | (wave 1 pending) | — | — |
| 22 | Community text-proxy unbounded response buffering | 6 isolated unit tests (declared + lying/chunked oversize rejected with upstream cancel; bounded pass-through; deadline signal; client honors config.fetcher); regressions community-endpoints 170/170, generateTextPortkey+genericOpenAIClient 107/107, byop/text-cache/generation-vcr 162/162; tsc clean | Fixed & pinned |
| 23 | Stripe refunds/lost chargebacks never reverse Pollen | 4 integration tests on the signed webhook route (exact-once incl. replay, partial scaling + cumulative clamp, pending/non-checkout no-ops, lost vs won dispute); regressions integration/stripe 105/105, fraud-ban, quests 58/58; tsc no new errors | Fixed & pinned |
