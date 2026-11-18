# Issue 102 — News automation puts the spend-capable image API key in the URL query string (and transport-error prints)

- **Severity:** Medium (secret-in-URL: a funded key exposed to access logs, URI-logging intermediaries, and plaintext console output outside GitHub's secret masking — the same class as the filed community-monitor and dungeon-master fixes, at an unfixed location)
- **Affected:** `operations/news/scripts/common.py:generate_image` (pre-fix `:368-381`: `"key": token` in the `requests.get` params; the exception print at `:382` embeds the full URL) — callers `operations/news/scripts/posts.py` (daily news posts) and `deploy_posts.py` (PR ship posts); the key is `PLN_GITHUB_NEWS_KEY` from `.github/workflows/news-posts.yml` — upstream `pollinations/pollinations` main @ `a21005d397` (2026-11-18)
- **Fix branch:** `solution102-news-image-key-header` — fork PR [#116](https://github.com/NamanSoni78/pollinationsai/pull/116)
- **Dedup:** the filed key-in-URL fixes cover community-monitor (scoped-permissions round), the ai-dungeon-master app (issue 69's family), and CLI argv redaction (issue 53's family) — `operations/news/` appears in none of them.

## Root cause

```python
params = {
    "model": use_model,
    ...
    "seed": seed,
    "key": token,          # account key in the query string
    "image": "https://raw.githubusercontent.com/...",
}
try:
    response = requests.get(base_url, params=params, timeout=300)
except requests.exceptions.RequestException as e:
    print(f"  Request error: {e}")   # requests embeds the full URL incl. key in the message
```

Every news/PR-post image request carries `?...&key=<PLN_GITHUB_NEWS_KEY>`:

1. the key is persisted in gen/Cloudflare access logs and any intermediary that logs full URIs — the exact vector the two already-filed key-in-URL issues were fixed for;
2. on any transport error, the printed `requests` exception message embeds the full URL **including `key=...`** — inside GitHub Actions this is saved only by automatic secret masking; any execution outside Actions (local run, another host, a copied value) leaks the funded key in plaintext;
3. the key has real spend — it funds every daily post's LLM + image generation.

The same file's chat-completions call (`:304-309`) already uses an `Authorization: Bearer` header, and `apps/catgpt-bot/bot.ts:97-103` fetches the same `https://gen.pollinations.ai/image` endpoint with headers only — proving the header form is compatible.

## Safe repro (offline, deterministic, red on unpatched main)

`python3` verification with a mocked `requests.get` and mocked `load_shared`: call `generate_image("a bee mascot reading the news", token="sk_...")` and reconstruct the exact wire URL from the captured `(url, params)`. On unpatched main the key appears in the query string (`key=sk_...`); with the fix it appears only in the `Authorization` header. No network access; no live spend.

## Fix

Remove `"key": token` from the params and pass `headers={"Authorization": f"Bearer {token}"}` to the `requests.get`. The URL and every other param are unchanged; callers keep the same signature (`py_compile` clean on `common.py`, `posts.py`, `deploy_posts.py`).
