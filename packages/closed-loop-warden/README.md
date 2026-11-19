# pollinations-closed-loop-warden

Closed-loop state machine daemon + zero-history adversarial Warden gate for Agent Ground.

## What
- FSM `IM_CHAT -> PREFLIGHT_INTERVIEW -> AUTONOMOUS_EXECUTION <=> WARDEN_AUDIT -> COMPLETED | BUDGET_PAUSED`; anything else throws `{code:"invalid_transition", from, to}`.
- One preflight interview batch; `freezeContract(answers)` validates and atomically writes `CONTRACT.json` (ids `REQ-1..n`; verification types `command|live_url_check|file_contains|no_stubs|e2e_browser`; deploy targets `cloudflare_pages|cloudflare_workers|edgeone_pages|none`).
- `runWardenAudit(contract, workspace, evidence, opts)` re-verifies every must-pass requirement independently. It is zero-history: the `evidence` argument is accepted for interface symmetry but never read, so worker narrative cannot reach the verdict.
- Rejected verdicts re-queue fixes (`options.fixers` keyed by req_id, else recorded actions) at the queue top; the same req failing twice consecutively injects a `consult_expert` escalation packet (`escalateOnDoubleReject`). After `options.maxWardenRounds` (default 3) rejections `run()` throws `{code:"warden_exhausted"}`.
- Durable `.agent/state.json` (atomic, tmp+rename) after every step; `resumeFromDisk()` restores phase, contract and rejected_count.
- `budget.cutoff` (via `options.proxy.events`) -> `BUDGET_PAUSED` and `run()` resolves `{approved:false, paused:true}`; `budget.resumed` -> back to `AUTONOMOUS_EXECUTION`. `askUser()` always throws `human_input_disabled`.

## Honest limits
- The persisted queue is advisory metadata: milestone functions cannot survive JSON — re-supply `options.plan` after `resumeFromDisk()`.
- `no_stubs` scans the workspace (minus `.git`/`.agent`/`node_modules`) including `CONTRACT.json`, so keep the marker words (`TODO|FIXME|XXX|HACK|stubbed|placeholder|@deprecated`) out of requirement text.
- The optional live Warden LLM pass (`options.live` + `wardenModel` + `proxy`) is wired but untested; deterministic results stay ground truth.
- `e2e_browser` fails honestly (`"browser tool not configured"`) unless `options.browser` is provided.

## Run
`npm test` (Node >= 20; `node --test test/*.test.js`). Fully offline: URL checks hit local `node:http` servers, `git` runs only inside temp workspaces. No env vars required.
