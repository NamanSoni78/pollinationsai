/**
 * OpenCode agent config writer: writes/merges
 * `<workspace>/.opencode/opencode.json` with a `pollinations` provider whose
 * block shape mirrors `providerBlock` in
 * packages/polli-cli/src/harnesses/opencode.ts (npm
 * "@ai-sdk/openai-compatible", options.baseURL at the BYOP proxy,
 * options.apiKey "byop-proxy", models with tool_call/limit/modalities), plus
 * our MCP servers. Default MCP server commands are repo-relative
 * placeholders — pass `mcpServers` and/or `repoRoot` for real paths.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson } from "./context.js";

const PROVIDER = "pollinations";
const PROVIDER_NPM = "@ai-sdk/openai-compatible";
const DEFAULT_MODEL = "openai/gpt-6-sol";
const DEFAULT_MODEL_IDS = [
    "openai/gpt-5.4-nano",
    "openai/gpt-6-sol",
    "openai/gpt-6.1-sol",
    "openai/gpt-6.1-terra",
];
const DEFAULT_REPO_ROOT = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
);

const modelEntry = (id, overrides = {}) => ({
    name: id,
    tool_call: true,
    limit: { context: 262144, output: 32768 },
    modalities: { input: ["text"], output: ["text"] },
    ...overrides,
});

/** models may be an array of ids / {id, ...} or an object of id → overrides. */
const modelsMap = (models) => {
    const map = {};
    if (Array.isArray(models)) {
        for (const entry of models) {
            if (typeof entry === "string") map[entry] = modelEntry(entry);
            else if (entry?.id) map[entry.id] = modelEntry(entry.id, entry);
        }
    } else if (models && typeof models === "object") {
        for (const [id, overrides] of Object.entries(models))
            map[id] = modelEntry(id, overrides ?? {});
    } else {
        for (const id of DEFAULT_MODEL_IDS) map[id] = modelEntry(id);
    }
    return map;
};

const defaultMcpServers = (repoRoot) => ({
    "agent-ground": {
        command: "node",
        args: [
            join(repoRoot, "packages", "agent-ground-mcp", "src", "mcp-cli.js"),
        ],
    },
    "harness-tools": {
        command: "node",
        args: [join(repoRoot, "packages", "harness-sdk", "src", "mcp-cli.js")],
    },
    "mcp-publish": {
        command: "node",
        args: [join(repoRoot, "packages", "mcp-publish", "src", "mcp-cli.js")],
    },
});

const readJsonIfExists = (path) => {
    if (!existsSync(path)) return null;
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        throw new Error(`could not parse existing config at ${path}`, {
            cause: error,
        });
    }
};

/**
 * Write/merge the OpenCode config for a child VM agent.
 *
 * @param {{proxyBase: string, workspace: string, models?: Array|string[]|object,
 *   mcpServers?: object, repoRoot?: string, model?: string}} options
 * @returns {{configPath: string, config: object}} the persisted config
 */
export function configureOpenCodeAgent({
    proxyBase,
    workspace,
    models,
    mcpServers,
    repoRoot,
    model,
} = {}) {
    if (!proxyBase)
        throw new Error("configureOpenCodeAgent requires proxyBase");
    if (!workspace)
        throw new Error("configureOpenCodeAgent requires workspace");
    const root = repoRoot ?? DEFAULT_REPO_ROOT;
    const configPath = join(workspace, ".opencode", "opencode.json");
    const config = readJsonIfExists(configPath) ?? {};
    if (typeof config.$schema !== "string")
        config.$schema = "https://opencode.ai/config.json";
    config.provider = {
        ...(config.provider ?? {}),
        [PROVIDER]: {
            npm: PROVIDER_NPM,
            name: "Pollinations",
            options: { baseURL: `${proxyBase}/v1`, apiKey: "byop-proxy" },
            models: modelsMap(models),
        },
    };
    config.model = `${PROVIDER}/${model ?? DEFAULT_MODEL}`;
    config.mcp = {
        ...(config.mcp ?? {}),
        servers: { ...defaultMcpServers(root), ...(mcpServers ?? {}) },
    };
    atomicWriteJson(configPath, config);
    return { configPath, config };
}
