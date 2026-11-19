/**
 * Repo indexer: walks a workspace (skipping .git, node_modules, .agent) and
 * writes a deterministic map of exports and routes to
 * `.agent/repo_map.json`. No LLM — pure regex extraction.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { atomicWriteJson } from "./context.js";

const MAX_FILE_BYTES = 512_000;

const NAMED_EXPORT_RE =
    /\bexport\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z0-9_$]+)/g;
const DEFAULT_FN_EXPORT_RE =
    /\bexport\s+default\s+(?:async\s+)?function\*?\s+([A-Za-z0-9_$]+)/g;
const DEFAULT_EXPORT_RE =
    /\bexport\s+default\s+(?!function\b|class\b|async\b|new\b|\{|\()([A-Za-z0-9_$]+)/g;
const ROUTE_RE =
    /\b(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/g;
const API_LITERAL_RE = /["'](\/api\/[^"']+)["']/g;

const walkFiles = (root, dir, out) => {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (
            entry.name === ".git" ||
            entry.name === "node_modules" ||
            entry.name === ".agent"
        )
            continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walkFiles(root, full, out);
        else if (entry.isFile()) out.push(relative(root, full));
    }
    return out;
};

const exportsOf = (text) => {
    const names = new Set();
    for (const regex of [
        NAMED_EXPORT_RE,
        DEFAULT_FN_EXPORT_RE,
        DEFAULT_EXPORT_RE,
    ]) {
        for (const match of text.matchAll(regex)) names.add(match[1]);
    }
    return [...names].sort();
};

const routesOf = (text) => {
    const methodRoutes = new Map();
    for (const match of text.matchAll(ROUTE_RE)) {
        methodRoutes.set(match[2], `${match[1].toUpperCase()} ${match[2]}`);
    }
    const routes = new Set(methodRoutes.values());
    for (const match of text.matchAll(API_LITERAL_RE)) {
        if (!methodRoutes.has(match[1])) routes.add(match[1]);
    }
    return [...routes].sort();
};

const buildTree = (paths) => {
    const root = { children: {} };
    for (const path of paths) {
        const parts = path.split("/");
        let node = root;
        parts.forEach((part, index) => {
            if (index === parts.length - 1) {
                node.children[part] = null;
            } else {
                node.children[part] ??= { children: {} };
                node = node.children[part];
            }
        });
    }
    const render = (node) =>
        Object.keys(node.children)
            .sort((a, b) => a.localeCompare(b))
            .map((name) =>
                node.children[name] === null
                    ? { name, type: "file" }
                    : {
                          name,
                          type: "dir",
                          children: render(node.children[name]),
                      },
            );
    return { name: ".", type: "dir", children: render(root) };
};

/**
 * Build the repo map for a workspace and persist it to
 * `<workspace>/.agent/repo_map.json`.
 *
 * @param {string} workspace absolute path
 * @returns {{generatedAt: string, files: Array<{path: string, exports: string[], routes: string[]}>, tree: object}}
 */
export function buildRepoMap(workspace) {
    if (!workspace) throw new Error("buildRepoMap requires workspace");
    const files = [];
    for (const relativePath of walkFiles(workspace, workspace, [])) {
        const full = join(workspace, relativePath);
        let text = "";
        try {
            if (statSync(full).size > MAX_FILE_BYTES) continue;
            text = readFileSync(full, "utf8");
        } catch {
            continue;
        }
        const entry = {
            path: relativePath.split(sep).join("/"),
            exports: [],
            routes: [],
        };
        if (!text.includes("\0")) {
            entry.exports = exportsOf(text);
            entry.routes = routesOf(text);
        }
        files.push(entry);
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const map = {
        generatedAt: new Date().toISOString(),
        files,
        tree: buildTree(files.map((file) => file.path)),
    };
    atomicWriteJson(join(workspace, ".agent", "repo_map.json"), map);
    return map;
}
