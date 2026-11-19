import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClosedLoopDaemon,
  ClosedLoopHumanInputDisabledError,
  DirectCompletionForbiddenError,
} from "./index";

test("ClosedLoopDaemon enforces zero-human mode, crash/restart durability, Warden REJECT -> Fix -> APPROVE, and double-reject consult_expert", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polli-closed-loop-"));
  try {
    const daemon = new ClosedLoopDaemon("agent-fe-01", dir);
    assert.equal(daemon.getState(), "IM_CHAT");

    // 1. Click "Close the Loop" -> Pre-Flight Interview
    const interview = daemon.beginPreflightInterview();
    assert.equal(interview.state, "PREFLIGHT_INTERVIEW");
    assert.ok(interview.questions.length >= 3);

    // 2. Answer batch & freeze CONTRACT.json -> AUTONOMOUS_EXECUTION
    const contract = daemon.freezeContractAndStartAutonomous({
      goal: "Build responsive Pollinations analytics dashboard",
      deploy_target: "cloudflare_pages",
      answers: {
        design_direction: "Clean light dashboard, 1440px + 390px zero overflow",
        core_features: "Live budget meter and OAuth flow",
        deploy_target: "cloudflare_pages",
      },
    });
    assert.equal(daemon.getState(), "AUTONOMOUS_EXECUTION");
    assert.equal(contract.requirements.length, 3);

    // Human-asking pathways are hard-disabled at runtime!
    assert.throws(() => daemon.assertCanAskHuman(), ClosedLoopHumanInputDisabledError);
    // Worker cannot mark task COMPLETED directly!
    assert.throws(() => daemon.markCompletedDirectly(), DirectCompletionForbiddenError);

    // Save durable state, simulate sandbox crash, and restore fresh instance from disk
    daemon.updateCheckpointMetadata({
      worklogMarkdown: "# WORKLOG\n- Built Sidebar.tsx",
      activeSkills: ["cloudflare-deploy"],
      gitSha: "a1b2c3d",
      groundSubscriptions: ["openapi-spec"],
    });

    const restored = ClosedLoopDaemon.restoreFromDisk(dir);
    assert.equal(restored.getState(), "AUTONOMOUS_EXECUTION");
    assert.equal(restored.getContract()?.contract_id, contract.contract_id);
    assert.deepEqual(restored.exportSnapshot().active_skills, ["cloudflare-deploy"]);
    assert.equal(restored.exportSnapshot().git_sha, "a1b2c3d");

    // 3. First Warden Audit -> REJECTED (stubbed TODO in Analytics.tsx + mobile console error)
    writeFileSync(
      join(dir, "Analytics.tsx"),
      `export function Analytics() { /* TODO: handle empty state */ return null; }\n`,
      "utf8",
    );
    const reject1 = await restored.request_warden_approval({
      evidence: {
        contract_id: contract.contract_id,
        git_sha: "a1b2c3d",
        git_diff_stat: "1 file changed",
        test_command: "npm test",
        test_exit_code: 0,
        test_output_excerpt: "4 passing",
        preview_url: "https://analytics-demo.pages.dev",
        live_http_status: 200,
        console_errors: ["Uncaught TypeError: Cannot read properties of undefined on /analytics"],
        changed_files: ["Analytics.tsx"],
      },
    });
    assert.equal(reject1.verdict.approved, false);
    assert.equal(reject1.verdict.zero_history_verified, true);
    assert.equal(reject1.state, "AUTONOMOUS_EXECUTION");
    assert.equal(reject1.escalatedToExpert.length, 0);
    assert.ok(reject1.verdict.required_actions.length >= 2);

    // 4. Second consecutive rejection on REQ-2 -> triggers automatic consult_expert escalation!
    const reject2 = await restored.request_warden_approval({
      evidence: {
        contract_id: contract.contract_id,
        git_sha: "a1b2c3e",
        git_diff_stat: "1 file changed",
        test_command: "npm test",
        test_exit_code: 0,
        test_output_excerpt: "4 passing",
        preview_url: "https://analytics-demo.pages.dev",
        live_http_status: 200,
        console_errors: ["Uncaught TypeError still firing on /analytics"],
        changed_files: ["Analytics.tsx"],
      },
    });
    assert.equal(reject2.verdict.approved, false);
    assert.ok(reject2.escalatedToExpert.some((e) => e.req_id === "REQ-2"));
    assert.ok(restored.getExpertEscalations().length >= 1);

    // 5. Worker self-fixes Analytics.tsx (removes TODO & fixes console error) -> Warden APPROVES!
    writeFileSync(
      join(dir, "Analytics.tsx"),
      `export function Analytics({ rows = [] }: { rows?: number[] }) { return rows.length; }\n`,
      "utf8",
    );
    const approved = await restored.request_warden_approval({
      evidence: {
        contract_id: contract.contract_id,
        git_sha: "d4e5f6a",
        git_diff_stat: "1 file changed, 12 insertions(+), 2 deletions(-)",
        test_command: "npm test",
        test_exit_code: 0,
        test_output_excerpt: "5 passing",
        preview_url: "https://analytics-demo.pages.dev",
        live_http_status: 200,
        console_errors: [],
        screenshot_notes: ["1440px desktop clean", "390px mobile zero overflow"],
        changed_files: ["Analytics.tsx"],
      },
    });
    assert.equal(approved.verdict.approved, true);
    assert.equal(approved.state, "COMPLETED");
    assert.ok(approved.verdict.results.every((r) => r.status === "PASS"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
