import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CloudflarePublishConnector,
  EdgeOnePublishConnector,
  OutOfBandSecretVault,
  createPublishMcpServer,
  verifyLiveDeployment,
} from "./index";

test("Publish MCP deploys to Cloudflare & EdgeOne, redacts out-of-band credentials, and verifies HTTP 200 smoke test", async () => {
  const secretToken = "cf_super_secret_token_987654321";
  const edgeToken = "eo_super_secret_token_123456789";
  const vault = new OutOfBandSecretVault({
    cloudflareApiToken: secretToken,
    cloudflareAccountId: "acct-test-01",
    edgeoneApiToken: edgeToken,
    edgeoneZoneId: "zone-test-01",
  });

  // Safe status never leaks token strings
  assert.equal(JSON.stringify(vault.getSafeStatus()).includes(secretToken), false);

  // Spin up local HTTP server simulating a live deployed site for real HTTP 200 smoke test
  const liveSite = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><head><title>Agent Ground Preview</title></head><body><h1>Live</h1></body></html>");
  });
  await new Promise<void>((resolve) => liveSite.listen(0, "127.0.0.1", resolve));
  const livePort = (liveSite.address() as AddressInfo).port;
  const liveUrl = `http://127.0.0.1:${livePort}`;

  const dir = mkdtempSync(join(tmpdir(), "polli-pub-"));
  writeFileSync(join(dir, "index.html"), "<h1>Built</h1>", "utf8");

  const cfFetch: typeof fetch = async (_url, init) => {
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${secretToken}`);
    return new Response(
      JSON.stringify({ result: { id: "dep-cf-1", url: liveUrl } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const eoFetch: typeof fetch = async (_url, init) => {
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${edgeToken}`);
    return new Response(
      JSON.stringify({ id: "dep-eo-1", url: liveUrl }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const cloudflare = new CloudflarePublishConnector({ vault, fetchImpl: cfFetch });
  const edgeone = new EdgeOnePublishConnector({ vault, fetchImpl: eoFetch });
  const mcp = createPublishMcpServer({ vault, cloudflare, edgeone });
  const { url: mcpUrl } = await mcp.listen(0);

  try {
    // 1. Deploy via Cloudflare MCP tool
    const cfRes = await fetch(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "cloudflare_deploy_pages",
          arguments: { project_name: "agent-ground-demo", build_dir: dir },
        },
      }),
    });
    const cfRaw = await cfRes.text();
    assert.equal(cfRaw.includes(secretToken), false);
    const cfJson = JSON.parse(cfRaw) as {
      result: { structuredContent: { deployment_id: string; url: string; status: string } };
    };
    assert.equal(cfJson.result.structuredContent.status, "deployed");
    assert.equal(cfJson.result.structuredContent.url, liveUrl);

    // 2. Deploy via EdgeOne MCP tool
    const eoRec = await edgeone.edgeone_deploy_pages({
      project_name: "agent-ground-edge",
      build_dir: dir,
    });
    assert.equal(eoRec.status, "deployed");
    const eoStatus = await edgeone.edgeone_get_deployment_status({
      deployment_id: eoRec.deployment_id,
    });
    assert.equal(eoStatus.status, "deployed");

    // 3. Live HTTP 200 Smoke Test against real HTTP endpoint
    const smoke = await verifyLiveDeployment(liveUrl, { expectedSubstring: "Agent Ground Preview" });
    assert.equal(smoke.passed, true);
    assert.equal(smoke.http_status, 200);
    assert.equal(smoke.title, "Agent Ground Preview");

    // 4. Redaction check on accidental secret string
    assert.equal(vault.redact(`Error using ${secretToken}`), "Error using [REDACTED_OOB_SECRET]");
  } finally {
    await mcp.close();
    await new Promise<void>((resolve) => liveSite.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
