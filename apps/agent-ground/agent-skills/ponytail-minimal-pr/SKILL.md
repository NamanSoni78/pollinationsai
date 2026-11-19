---
name: ponytail-minimal-pr
description: Enforce Ponytail minimal-change engineering discipline, root-cause fixes, and secret-free atomic Git checkpoints.
required_tools: [git_checkpoint, git_branch_experiment, git_rollback]
---
# Ponytail Minimal-Change Skill

1. Prefer stdlib and existing workspace utilities before introducing new dependencies or abstractions.
2. Fix root causes rather than patching individual symptoms across callers.
3. Isolate risky refactors onto `git_branch_experiment` and roll back cleanly via `git_rollback` if tests regress.
4. Never bypass the pre-commit secret-leak guard or skip required test suites before calling `request_warden_approval`.
