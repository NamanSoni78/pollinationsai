# Issue 5 — polli HTTP API: tool restrictions enforced only in the LLM tool schema; the executor never checks (bot identity can be made to write)

**Severity: High (privilege escalation)** — any API caller can make the official bot identity perform GitHub/Discord write actions (create issues, comment, edit/delete comments, subscribe)
**Original tracker:** issue #105 in the 2026-10-23 report set

## Vulnerable code (`apps/polli/src/ai/client.py`, current HEAD b373afb)

The API server declares API mode read-only and filters the **schema** offered to the model:

```python
# apps/polli/src/api/server.py:121
tool_context = {"is_admin": False, "is_http_api": True}
```

But the executor's write-restriction check fires only for mixed-user Discord batches:

```python
# apps/polli/src/ai/client.py:730
if (tool_context or {}).get("discord_mixed_batch") and (      # ← is_http_api never checked
    func_name in API_EXCLUDED_TOOLS
    or str(args.get("action", "")).lower() in API_RESTRICTED_ACTIONS.get(func_name, set())
):
    return {"error": "Mixed-user batch is read-only..."}
```

The model chooses the tool name and arguments at runtime — a schema is advisory. A crafted prompt (or injected content in anything the agent reads) makes `_execute_tools_parallel` execute `github_issue` with `action="create"` / `"comment"` / `"edit_comment"` / `"delete_comment"` under the bot's GitHub identity (`POLLINATIONS_TOKEN`), because the registry lookup executes model-chosen names that need not match the offered schema at all.

The restriction sets already exist and are shared with the schema builder (`apps/polli/src/ai/tool_filters.py`):

```python
API_EXCLUDED_TOOLS = {"github_custom", "subscribe_issue", "unsubscribe_issue",
                      "unsubscribe_all", "list_subscriptions", "render_visual"}
API_RESTRICTED_ACTIONS = {"discord_search": {"members", "roles"},
                          "github_issue": ADMIN_ACTIONS["github_issue"] | {"create", "comment",
                              "edit_comment", "delete_comment", "subscribe", ...}}
```

## Impact

- Any holder of an `ag_` agent-run token (or whatever front door leads to `is_http_api` tool context) can post comments / create issues / edit or delete the bot's comments on `pollinations/pollinations` using the official verified bot identity — impersonating maintainer communications on the platform's own repo.
- Deletes are irreversible; comments on security issues could be used to shape coordinator behavior.

## Recommended fix (implemented in `solution5-polli-api-tool-enforcement`)

Extend the existing executor guard to `is_http_api` requests — same sets, same check position, one condition change. Schema-only restrictions are advisory; the executor is the boundary. (Maintainers' own recommendation in the original report: "the maintainers already wrote exactly this check for mixed batches; the direct API path just never got it.")

## Verification

- `python3 -m py_compile` passes.
- No state was modified during this audit: the finding is from static code reading; no issue, comment, or subscription was created through this path on any repo.
