// End-to-end integration test: the full Agent Ground story in scripted mode
// (offline stub GEN; the BYOP proxy meters REAL calls against it). Proves the
// quest's acceptance criteria in one run: multi-agent collaboration, Shadow
// Reader non-disruption, artifact blackboard + event wake, closed-loop with
// budget cutoff → Top-Up & Resume, and Warden REJECT → self-fix → APPROVE.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runDemo } from "../demo/orchestrator.mjs";

test("agent ground end-to-end: collaboration, closed loop, warden, budget", {
    timeout: 60000,
}, async () => {
    const t = await runDemo({
        mode: "scripted",
        narrate: false,
        resumeWaitMs: 15000,
    });

    // --- identity & BYOP propagation -------------------------------------
    assert.equal(t.identity.username, "NamanSoni78");
    assert.match(t.identity.email, /@users\.noreply\.github\.com$/);
    const gitAuthor = execFileSync("git", ["log", "-1", "--format=%an <%ae>"], {
        cwd: join(t.runDir, "frontend"),
        encoding: "utf8",
    }).trim();
    assert.equal(
        gitAuthor,
        "NamanSoni78 <NamanSoni78@users.noreply.github.com>",
    );

    // --- multi-agent collaboration ---------------------------------------
    assert.ok(t.agents.length >= 2, "at least two child VM agents registered");
    assert.ok(t.agents.every((a) => a.owner_pollinations_id === "NamanSoni78"));
    const backend = t.agents.find((a) => a.agent_id === "agent-backend-01");
    const frontend = t.agents.find((a) => a.agent_id === "agent-frontend-01");
    assert.ok(backend && frontend);
    assert.deepEqual(backend.owned_paths, ["api/**"]);
    assert.deepEqual(frontend.owned_paths, ["web/**"]);

    // sleep/until_event woke on the backend's artifact publish
    assert.equal(t.sleep.wakeReason, "event");
    assert.equal(t.sleep.eventKey, "openapi-spec");
    assert.ok(
        t.sleep.waitedMs < 9000,
        "woke on the event, not the max_wait fallback",
    );

    // Shadow Reader: answered with citations, target untouched
    assert.equal(t.readonly.status, "answered");
    assert.ok((t.readonly.citations ?? []).length >= 1);
    assert.match(t.readonly.answer, /401|unauthorized/);
    assert.equal(t.readonly.untouched, true);

    // negotiate_change: queued, delivered at the next step boundary
    assert.equal(t.negotiate.status, "queued");
    assert.equal(t.negotiate.deliveredCount, 1);
    // queued by the ask, delivered by the backend's NEXT step (not answered inline)
    assert.ok(
        t.negotiate.artifactEventsForFrontend >= 1,
        "subscription notified on the v2 publish",
    );
    const specOnDisk = readFileSync(
        join(t.runDir, "backend", "api", "openapi.json"),
        "utf8",
    );
    assert.match(
        specOnDisk,
        /"enabled": true/,
        "backend accepted the CORS change and republished",
    );

    // --- SDK surface ------------------------------------------------------
    assert.ok(t.sdk.ponytailLayer2, "load_skill injects into Layer 2");
    assert.ok(
        !/Ponytail/.test(t.sdk.layer2AfterUnload),
        "unload_skill reclaims Layer 2",
    );
    assert.ok(
        t.sdk.userAnchorPreserved,
        "Layer 3 keeps the original user prompt verbatim",
    );
    assert.ok(t.sdk.spill.path, "spill archived to .agent/logs");
    assert.ok(
        t.sdk.spill.preview.includes("Full output:"),
        "spill preview points at the archived log",
    );
    assert.ok(
        t.sdk.spill.preview.includes("lines total"),
        "spill preview shows the head/tail window",
    );
    assert.equal(
        t.sdk.doomloop.intervene,
        "consult_expert",
        "doom-loop breaker forces escalation",
    );
    assert.ok(t.sdk.repoMap.files >= 2, "indexer built the repo map");

    // --- closed loop + warden ---------------------------------------------
    assert.equal(t.closeLoop.phase, "COMPLETED");
    const verdicts = t.closeLoop.verdicts;
    assert.equal(verdicts.length, 2, "one REJECT then one APPROVE");
    assert.equal(verdicts[0].approved, false);
    const req3 = verdicts[0].results.find((r) => r.req_id === "REQ-3");
    assert.equal(req3.status, "FAIL");
    assert.match(
        req3.defect,
        /web\/app\.js/,
        "the defect names the offending file",
    );
    assert.equal(verdicts[1].approved, true);
    assert.ok(verdicts[1].results.every((r) => r.status === "PASS"));
    const contract = JSON.parse(
        readFileSync(join(t.runDir, "frontend", "CONTRACT.json"), "utf8"),
    );
    assert.equal(contract.requirements.length, 3);

    // --- budget firewall ---------------------------------------------------
    assert.equal(t.pausedEvents.length, 1, "exactly one cutoff pause");
    assert.ok(
        t.pausedEvents[0].gitSha,
        "pause recorded a clean git checkpoint",
    );
    assert.equal(t.topUps.length, 1);
    assert.equal(t.resumed, true);
    const ledger = t.proxy.ledger;
    assert.equal(
        ledger.length,
        8,
        "8 metered generation calls (2 backend + 6 closed-loop)",
    );
    assert.ok(
        Math.abs(t.proxy.state.spent - 0.008) < 1e-9,
        `spent ${t.proxy.state.spent} Pollen`,
    );
    assert.ok(
        t.proxy.state.pct < 75,
        "final burn back under conservation after the top-up",
    );
    // the stub balance dropped in lockstep with the usage-based costing
    assert.ok(
        Math.abs((t.proxy.stubBalance ?? 2) - (2 - 0.008)) < 1e-9,
        "reconciliation agrees with the ledger",
    );

    // --- durable state ----------------------------------------------------
    const snapshot = JSON.parse(
        readFileSync(
            join(t.runDir, "frontend", ".agent", "state.json"),
            "utf8",
        ),
    );
    assert.equal(snapshot.phase, "COMPLETED");
    assert.ok(snapshot.git_sha);

    // --- publish step (honest without credentials) -------------------------
    assert.ok(t.publish.skipped === true || t.publish.deployed === true);
    if (t.publish.skipped) {
        assert.match(t.publish.reason, /CLOUDFLARE/);
    }
});
