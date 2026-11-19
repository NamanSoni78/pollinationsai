import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RoleModelConfig } from "./types";
import { DEFAULT_ROLE_MODELS } from "./model-router";

export interface OpenCodeBridgeConfig {
  agentId: string;
  meteringProxyUrl: string;
  agentGroundMcpUrl: string;
  publishMcpUrl?: string;
  computerMcpUrl?: string;
  defaultModel?: string;
  models?: Partial<RoleModelConfig>;
}

/**
 * Extends Pollinations' existing OpenCode harness configuration pattern
 * (`packages/polli-cli/src/harnesses/opencode.ts`) rather than rewriting a coding
 * harness from scratch.
 *
 * Writes `opencode.json` pointing OpenCode's `pollinations` provider at the local
 * Pollen Metering Proxy (so the real BYOP key never enters the VM prompt or config
 * and every token is metered by the Pollen Budget Firewall) and registers the
 * Agent Ground A2A MCP, Publish MCP, and Pollinations Computer MCP servers.
 */
export function buildOpenCodeConfig(cfg: OpenCodeBridgeConfig): Record<string, unknown> {
  const models = { ...DEFAULT_ROLE_MODELS, ...cfg.models };
  const primaryModel = cfg.defaultModel ?? models.worker;

  const uniqueModelIds = Array.from(
    new Set([
      models.indexer,
      models.worker,
      models.workerConserve,
      models.subagent,
      models.vision,
      models.expert,
      models.warden,
    ]),
  );

  const modelEntries: Record<string, { name: string; limit: { context: number; output: number } }> =
    {};
  for (const id of uniqueModelIds) {
    modelEntries[id] = {
      name: id,
      limit: { context: 128000, output: 32768 },
    };
  }

  const mcpServers: Record<string, Record<string, unknown>> = {
    "agent-ground": {
      type: "remote",
      url: cfg.agentGroundMcpUrl,
      headers: { "x-agent-id": cfg.agentId },
      enabled: true,
    },
  };

  if (cfg.publishMcpUrl) {
    mcpServers["pollinations-publish"] = {
      type: "remote",
      url: cfg.publishMcpUrl,
      headers: { "x-agent-id": cfg.agentId },
      enabled: true,
    };
  }

  if (cfg.computerMcpUrl) {
    mcpServers["pollinations-computer"] = {
      type: "remote",
      url: cfg.computerMcpUrl,
      enabled: true,
    };
  }

  return {
    $schema: "https://opencode.ai/config.json",
    model: `pollinations/${primaryModel}`,
    provider: {
      pollinations: {
        npm: "@ai-sdk/openai-compatible",
        name: "Pollinations AI (BYOP Metered)",
        options: {
          baseURL: `${cfg.meteringProxyUrl.replace(/\/+$/, "")}/v1`,
          // Out-of-band proxy injects the real BYOP sk_ key; VM only sees a session sentinel
          apiKey: "pollinations-metered-proxy-session",
          headers: {
            "x-agent-id": cfg.agentId,
            "x-agent-role": "worker",
          },
        },
        models: modelEntries,
      },
    },
    mcp: mcpServers,
  };
}

/**
 * Materializes `opencode.json` inside a Child VM workspace directory so OpenCode
 * boots directly into the metered Pollinations BYOP + Agent Ground MCP environment.
 */
export function writeOpenCodeWorkspaceConfig(
  workspaceDir: string,
  cfg: OpenCodeBridgeConfig,
): { configPath: string; config: Record<string, unknown> } {
  const configDir = join(workspaceDir, ".opencode");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "opencode.json");
  const config = buildOpenCodeConfig(cfg);
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  return { configPath, config };
}
