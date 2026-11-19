---
name: edgeone-deploy
description: Publish static and full-stack bundles to EdgeOne Pages with out-of-band auth and live status verification.
required_tools: [edgeone_deploy_pages, edgeone_get_deployment_status, edgeone_get_logs, publish_smoke_test]
---
# EdgeOne Pages Autonomous Deployment Skill

1. Confirm production artifacts exist in `dist/` and contain a valid `index.html`.
2. Call `edgeone_deploy_pages(project_name, build_dir, region)` — credentials remain out-of-band in the MCP host.
3. Poll `edgeone_get_deployment_status` until deployment reaches `deployed` or `sandbox_preview`, then tail `edgeone_get_logs` on any warning.
4. Run `publish_smoke_test` against the public URL and attach the result to the Warden EvidenceBundle.
