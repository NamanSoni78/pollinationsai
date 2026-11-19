# pollinations-mcp-publish

Cloudflare Pages/Workers + EdgeOne Pages deployment MCP tools for Agent Ground.
Zero-dependency core (global fetch + node:crypto), MCP adapter in `src/index.js`
(needs `npm install` for `@modelcontextprotocol/server` + `zod`). Core tests run
offline against local stub servers: `node --test test/` (no install needed).

## What

- `src/cloudflare.js` — `deployPages`, `deployWorker`, `setEnvVar`,
  `getDeploymentLogs` via the documented Cloudflare API v4 Direct Upload flow
  (project create → upload-token JWT → `/pages/assets/*` → manifest multipart).
- `src/edgeone.js` — `deployPages`, `getDeploymentStatus`, `getLogs` via the
  documented EdgeOne pages-api (Action-based POSTs + Tencent COS upload,
  signature per cos-nodejs-sdk-v5 / document 436/7778).
- `src/verify.js` — `verifyDeployment(url)`; every deploy auto-verifies its URL.
- `src/index.js` + `src/mcp-cli.js` — MCP tools `cloudflare_deploy_pages`,
  `cloudflare_deploy_worker`, `cloudflare_set_env_var`,
  `cloudflare_get_deployment_logs`, `edgeone_deploy_pages`,
  `edgeone_get_deployment_status`, `edgeone_get_logs` (stdio server).

## Env

- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (required for Cloudflare)
- `EDGEONE_API_TOKEN` (required for EdgeOne; API tokens:
  https://edgeone.ai/document/177158578324279296)
- `CLOUDFLARE_API_BASE` (default `https://api.cloudflare.com/client/v4`),
  `EDGEONE_API_BASE` (default `https://pages-api.edgeone.ai/v1`; China:
  `https://pages-api.cloud.tencent.com/v1`), `EDGEONE_COS_BASE` — test overrides.
- Missing credentials return `{configured:false, env, hint}` — never a fake
  deploy, and the token value never appears in any result.

## Run

```sh
npm test                # offline core tests (stub APIs, fake tokens)
npm install             # for the MCP adapter
node src/mcp-cli.js     # stdio MCP server
```
