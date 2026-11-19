import type { BudgetTier, PollenBudgetFirewall } from "../../pollinations-byop-proxy/src/index";
import type { ModelRole, RoleModelConfig } from "./types";

/**
 * Verified Pollinations model aliases from `GET https://gen.pollinations.ai/v1/models`.
 * Configurable per deployment so maintainers/users can swap aliases without touching harness code.
 */
export const DEFAULT_ROLE_MODELS: RoleModelConfig = {
  indexer: "openai/gpt-5.4-nano",
  worker: "openai/gpt-5.4-mini",
  workerConserve: "openai/gpt-5.4-nano",
  subagent: "openai/gpt-5.4-nano",
  embedding: "openai/text-embedding-3-small",
  vision: "openai/gpt-5.4-mini",
  expert: "openai/gpt-5.5",
  warden: "openai/gpt-5.5",
  image_gen: "black-forest-labs/flux.1-schnell",
};

export interface PollinationsRouterOptions {
  baseUrl: string; // Metering Proxy URL or https://gen.pollinations.ai
  apiKey?: string;
  agentId: string;
  models?: Partial<RoleModelConfig>;
  firewall?: PollenBudgetFirewall;
  fetchImpl?: typeof fetch;
}

export interface ChatCompletionResult {
  model: string;
  role: ModelRole;
  content: string;
  promptTokens: number;
  completionTokens: number;
  pollenCost: number;
}

/**
 * Routes Multi-LLM calls across Pollinations AI APIs with automatic budget-tier
 * downshifting (at >= 75% burn, Worker downshifts to `workerConserve`).
 */
export class PollinationsModelRouter {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly agentId: string;
  private readonly models: RoleModelConfig;
  private readonly firewall?: PollenBudgetFirewall;
  private readonly fetchFn: typeof fetch;

  constructor(options: PollinationsRouterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.agentId = options.agentId;
    this.models = { ...DEFAULT_ROLE_MODELS, ...options.models };
    this.firewall = options.firewall;
    this.fetchFn = options.fetchImpl ?? fetch;
  }

  resolveModelForRole(role: ModelRole, tier?: BudgetTier): string {
    const activeTier = tier ?? this.firewall?.getTier() ?? "NOMINAL";
    if (role === "worker" && (activeTier === "CONSERVE" || activeTier === "WRAP_UP")) {
      return this.models.workerConserve;
    }
    return this.models[role];
  }

  getModelMatrix(): RoleModelConfig {
    return { ...this.models };
  }

  async chat(params: {
    role: Exclude<ModelRole, "embedding" | "image_gen">;
    messages: Array<{
      role: "system" | "user" | "assistant";
      content:
        | string
        | Array<
            | { type: "text"; text: string }
            | { type: "image_url"; image_url: { url: string } }
          >;
    }>;
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
  }): Promise<ChatCompletionResult> {
    if (this.firewall) {
      await this.firewall.assertCanSpend(this.agentId, 0);
    }

    const model = this.resolveModelForRole(params.role);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-agent-id": this.agentId,
      "x-agent-role": params.role,
    };
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    const body: Record<string, unknown> = {
      model,
      messages: params.messages,
      temperature: params.temperature ?? 0.2,
    };
    if (params.maxTokens) body.max_tokens = params.maxTokens;
    if (params.jsonMode) body.response_format = { type: "json_object" };

    const res = await this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(
        `Pollinations ${params.role} call (${model}) failed with HTTP ${res.status}: ${errText.slice(0, 240)}`,
      );
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const content = data.choices?.[0]?.message?.content ?? "";
    const promptTokens = data.usage?.prompt_tokens ?? 0;
    const completionTokens = data.usage?.completion_tokens ?? 0;
    const costHeader = res.headers.get("x-pollen-spent");
    const pollenCost = costHeader ? Number.parseFloat(costHeader) || 0 : 0.0005;

    return {
      model,
      role: params.role,
      content,
      promptTokens,
      completionTokens,
      pollenCost,
    };
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (this.firewall) {
      await this.firewall.assertCanSpend(this.agentId, 0);
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-agent-id": this.agentId,
      "x-agent-role": "embedding",
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const res = await this.fetchFn(`${this.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: this.models.embedding, input: texts }),
    });
    if (!res.ok) {
      throw new Error(`Pollinations embedding call failed (HTTP ${res.status})`);
    }
    const data = (await res.json()) as {
      data?: Array<{ embedding: number[] }>;
    };
    return (data.data ?? []).map((d) => d.embedding);
  }

  /**
   * Builds a Pollinations Image Generation URL (for Pollinations Image Gen MCP assets).
   */
  buildImageGenUrl(params: {
    prompt: string;
    width?: number;
    height?: number;
    seed?: number;
    model?: string;
  }): string {
    const model = params.model ?? this.models.image_gen;
    const encoded = encodeURIComponent(params.prompt);
    const url = new URL(`https://gen.pollinations.ai/image/${encoded}`);
    url.searchParams.set("model", model);
    if (params.width) url.searchParams.set("width", String(params.width));
    if (params.height) url.searchParams.set("height", String(params.height));
    if (params.seed !== undefined) url.searchParams.set("seed", String(params.seed));
    return url.toString();
  }
}
