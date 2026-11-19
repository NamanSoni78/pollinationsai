---
name: cloudflare-deploy
description: Build, configure out-of-band secrets, deploy to Cloudflare Pages or Workers, and verify HTTP 200 live smoke tests.
required_tools: [cloudflare_deploy_pages, cloudflare_deploy_worker, cloudflare_set_env_var, publish_smoke_test]
---
# Cloudflare Autonomous Deployment Skill

1. Run `npm run build` and verify zero TypeScript or bundler errors before deploying.
2. Never inspect, print, or commit `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID`. Credentials are injected out-of-band by the Publish MCP host.
3. Call `cloudflare_deploy_pages` for static/SPA bundles or `cloudflare_deploy_worker` for edge APIs.
4. Immediately invoke `publish_smoke_test` on the returned URL and verify HTTP `200`, non-empty HTML, and zero Cloudflare error banners (e.g., Error 1101) before requesting Warden sign-off.
