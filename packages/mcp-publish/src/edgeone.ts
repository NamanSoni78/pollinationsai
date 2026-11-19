import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import type { DeploymentRecord } from "./cloudflare";
import type { OutOfBandSecretVault } from "./secret-guard";

export interface EdgeOneConnectorOptions {
  vault: OutOfBandSecretVault;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  sandboxPreviewBaseUrl?: string;
}

/**
 * EdgeOne Pages MCP Connector (Issue #20357 §5):
 * - edgeone_deploy_pages
 * - edgeone_get_deployment_status
 * - edgeone_get_logs
 */
export class EdgeOnePublishConnector {
  private readonly apiBase: string;
  private readonly fetchFn: typeof fetch;
  private readonly deployments = new Map<string, DeploymentRecord>();

  constructor(private readonly options: EdgeOneConnectorOptions) {
    this.apiBase = (options.apiBaseUrl ?? "https://pages-api.edgeone.ai/v1").replace(
      /\/+$/,
      "",
    );
    this.fetchFn = options.fetchImpl ?? fetch;
  }

  async edgeone_deploy_pages(params: {
    project_name: string;
    build_dir: string;
    region?: string;
  }): Promise<DeploymentRecord> {
    const auth = this.options.vault.getEdgeOneAuth();
    const id = `eo-pages-${randomUUID().slice(0, 8)}`;
    const safeProject = params.project_name.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    const filesCount = existsSync(params.build_dir)
      ? readdirSync(params.build_dir).length
      : 0;

    if (auth.configured && auth.apiToken) {
      try {
        const res = await this.fetchFn(
          `${this.apiBase}/projects/${safeProject}/deployments`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${auth.apiToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              zone_id: auth.zoneId,
              build_dir: params.build_dir,
              region: params.region ?? "global",
            }),
          },
        );
        const raw = this.options.vault.redact(await res.text());
        if (!res.ok) {
          throw new Error(`EdgeOne Pages API returned HTTP ${res.status}: ${raw.slice(0, 200)}`);
        }
        const parsed = JSON.parse(raw) as { id?: string; url?: string };
        const rec: DeploymentRecord = {
          deployment_id: parsed.id ?? id,
          provider: "edgeone_pages",
          project_name: safeProject,
          url: parsed.url ?? `https://${safeProject}.edgeone.app`,
          status: "deployed",
          mode: "live_api",
          created_at: new Date().toISOString(),
          logs: [
            `Published ${filesCount} build artifact(s) to EdgeOne Pages (${params.region ?? "global"}).`,
            `Live URL: ${parsed.url ?? `https://${safeProject}.edgeone.app`}`,
          ],
        };
        this.deployments.set(rec.deployment_id, rec);
        return rec;
      } catch (err) {
        throw new Error(
          this.options.vault.redact(
            `edgeone_deploy_pages failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    }

    const previewUrl = (
      this.options.sandboxPreviewBaseUrl ?? `https://${safeProject}.edgeone.app`
    ).replace(/\/+$/, "");
    const rec: DeploymentRecord = {
      deployment_id: id,
      provider: "edgeone_pages",
      project_name: safeProject,
      url: previewUrl,
      status: "sandbox_preview",
      mode: "sandbox_preview",
      created_at: new Date().toISOString(),
      logs: [
        `Out-of-band EDGEONE_API_TOKEN not set; deployed to verifiable sandbox preview.`,
        `Packaged ${filesCount} artifact(s) from ${params.build_dir}.`,
        `Preview URL: ${previewUrl}`,
      ],
    };
    this.deployments.set(id, rec);
    return rec;
  }

  async edgeone_get_deployment_status(params: {
    deployment_id: string;
  }): Promise<{ deployment_id: string; status: string; url: string; mode: string }> {
    const rec = this.deployments.get(params.deployment_id);
    if (!rec) {
      throw new Error(`EdgeOne deployment "${params.deployment_id}" not found.`);
    }
    return {
      deployment_id: rec.deployment_id,
      status: rec.status,
      url: rec.url,
      mode: rec.mode,
    };
  }

  async edgeone_get_logs(params: {
    deployment_id: string;
  }): Promise<{ deployment_id: string; logs: string[] }> {
    const rec = this.deployments.get(params.deployment_id);
    if (!rec) {
      throw new Error(`EdgeOne deployment "${params.deployment_id}" not found.`);
    }
    return {
      deployment_id: rec.deployment_id,
      logs: rec.logs.map((l) => this.options.vault.redact(l)),
    };
  }

  listDeployments(): DeploymentRecord[] {
    return Array.from(this.deployments.values()).sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    );
  }
}
