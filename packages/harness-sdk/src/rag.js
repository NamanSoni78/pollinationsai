/**
 * BM25 RAG (k1=1.5, b=0.75) over blank-line chunks (~40 lines max per chunk).
 * Scopes: `codebase` (code extensions), `docs` (*.md except WORKLOG.md),
 * `worklogs` (WORKLOG.md + .agent/logs/*.txt), `all` (everything).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { atomicWriteJson } from "./context.js";

const K1 = 1.5;
const B = 0.75;
const MAX_CHUNK_LINES = 40;
const MAX_FILE_BYTES = 512_000;

const CODE_EXTS = new Set([
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".jsx",
    ".py",
    ".rb",
    ".go",
    ".rs",
    ".java",
    ".kt",
    ".c",
    ".cc",
    ".cpp",
    ".h",
    ".hpp",
    ".cs",
    ".php",
    ".swift",
    ".scala",
    ".sh",
]);

/** Lowercase terms split on non [a-z0-9_]. */
export const tokenize = (text) =>
    String(text ?? "")
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter(Boolean);

/** Scope of a workspace-relative path (forward slashes). */
export const scopeOf = (relativePath) => {
    if (relativePath === "WORKLOG.md") return "worklogs";
    if (
        relativePath.startsWith(".agent/logs/") &&
        relativePath.endsWith(".txt")
    )
        return "worklogs";
    if (relativePath.endsWith(".md")) return "docs";
    if (CODE_EXTS.has(extname(relativePath))) return "codebase";
    return "misc";
};

/**
 * Split text into chunks at blank-line boundaries, at most `maxLines` lines
 * per chunk. Line numbers are 1-based inclusive.
 */
export function chunkText(text, maxLines = MAX_CHUNK_LINES) {
    const lines = String(text ?? "").split("\n");
    const chunks = [];
    let current = [];
    let start = 0;
    for (let i = 0; i <= lines.length; i++) {
        const atEnd = i === lines.length;
        const blank = !atEnd && lines[i].trim() === "";
        if (blank || atEnd) {
            if (current.length)
                chunks.push({
                    startLine: start + 1,
                    endLine: i,
                    text: current.join("\n"),
                });
            current = [];
            continue;
        }
        if (current.length === 0) start = i;
        current.push(lines[i]);
        if (current.length === maxLines) {
            chunks.push({
                startLine: start + 1,
                endLine: i + 1,
                text: current.join("\n"),
            });
            current = [];
        }
    }
    return chunks;
}

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
            entry.name === "dist"
        )
            continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            // Under .agent only the logs are indexed (never our own index).
            if (entry.name === ".agent") {
                walkFiles(root, join(full, "logs"), out);
                continue;
            }
            walkFiles(root, full, out);
        } else if (entry.isFile()) {
            out.push(relative(root, full));
        }
    }
    return out;
};

/**
 * Collect chunks from every indexable file in the workspace (pure read, no
 * index write — safe for shadow reads of foreign workspaces).
 *
 * @param {string} workspace absolute path
 * @returns {Array<{file: string, startLine: number, endLine: number, text: string, scope: string}>}
 */
export function collectChunks(workspace) {
    if (!workspace) throw new Error("collectChunks requires workspace");
    const chunks = [];
    for (const relativePath of walkFiles(workspace, workspace, [])) {
        const full = join(workspace, relativePath);
        let text;
        try {
            if (statSync(full).size > MAX_FILE_BYTES) continue;
            text = readFileSync(full, "utf8");
        } catch {
            continue;
        }
        if (text.includes("\0")) continue; // binary
        const file = relativePath.split(sep).join("/");
        for (const chunk of chunkText(text)) {
            chunks.push({
                file,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                text: chunk.text,
                scope: scopeOf(file),
            });
        }
    }
    return chunks;
}

/**
 * BM25-rank chunks against query terms (k1=1.5, b=0.75). Deterministic order:
 * score desc, then file asc, then startLine asc.
 *
 * @returns {Array<{file: string, startLine: number, endLine: number, score: number, preview: string}>}
 */
export function rankChunks(chunks, terms, topK = 5) {
    const query = [...(terms ?? [])];
    if (!query.length || !chunks?.length) return [];
    const docs = chunks.map((chunk) => ({
        chunk,
        tokens: tokenize(chunk.text),
    }));
    const avgdl =
        docs.reduce((total, doc) => total + doc.tokens.length, 0) /
            docs.length || 1;
    const df = new Map();
    for (const term of new Set(query)) {
        df.set(
            term,
            docs.reduce(
                (total, doc) => total + (doc.tokens.includes(term) ? 1 : 0),
                0,
            ),
        );
    }
    return docs
        .map(({ chunk, tokens }) => {
            let score = 0;
            for (const term of query) {
                const tf = tokens.filter((token) => token === term).length;
                if (!tf) continue;
                const termDf = df.get(term) ?? 0;
                const idf = Math.log(
                    1 + (docs.length - termDf + 0.5) / (termDf + 0.5),
                );
                score +=
                    (idf * (tf * (K1 + 1))) /
                    (tf + K1 * (1 - B + (B * tokens.length) / avgdl));
            }
            return { chunk, score };
        })
        .filter((entry) => entry.score > 0)
        .sort(
            (a, b) =>
                b.score - a.score ||
                a.chunk.file.localeCompare(b.chunk.file) ||
                a.chunk.startLine - b.chunk.startLine,
        )
        .slice(0, topK)
        .map(({ chunk, score }) => ({
            file: chunk.file,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            score: Math.round(score * 1000) / 1000,
            preview: chunk.text.slice(0, 240),
        }));
}

/**
 * Build the RAG index for a workspace and persist it atomically to
 * `<workspace>/.agent/rag/index.json`.
 *
 * @param {string} workspace absolute path
 * @returns {{generatedAt: string, chunks: Array<object>}} the persisted index
 */
export function buildIndex(workspace) {
    if (!workspace) throw new Error("buildIndex requires workspace");
    const index = {
        generatedAt: new Date().toISOString(),
        chunks: collectChunks(workspace),
    };
    atomicWriteJson(join(workspace, ".agent", "rag", "index.json"), index);
    return index;
}

/**
 * BM25 search over a built index.
 *
 * @param {{chunks: Array<object>}} index from buildIndex (or any {chunks})
 * @param {string} query free text
 * @param {{scope?: "codebase"|"docs"|"worklogs"|"all", top_k?: number}} [options]
 * @returns {Array<{file: string, startLine: number, endLine: number, score: number, preview: string}>}
 */
export function ragSearch(index, query, { scope = "all", top_k = 5 } = {}) {
    const chunks = (index?.chunks ?? []).filter(
        (chunk) => scope === "all" || chunk.scope === scope,
    );
    return rankChunks(chunks, tokenize(query), top_k);
}
