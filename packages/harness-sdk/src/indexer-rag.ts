import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import type { RagChunk, RepoMap, RepoMapEntry } from "./types";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".agent",
  ".playwright-cli",
]);

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".css",
  ".html",
  ".sql",
  ".yaml",
  ".yml",
]);

function walkWorkspaceFiles(rootDir: string, currentDir = rootDir, acc: string[] = []): string[] {
  if (!existsSync(currentDir)) return acc;
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkWorkspaceFiles(rootDir, full, acc);
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Fast Indexer: Walks workspace files, extracts exported symbols and HTTP routes,
 * and persists `.agent/repo_map.json` on boot & every Git commit.
 */
export function buildRepoMap(workspaceDir: string): RepoMap {
  const files = walkWorkspaceFiles(workspaceDir);
  const entries: RepoMapEntry[] = [];

  for (const fullPath of files) {
    const rel = relative(workspaceDir, fullPath).replace(/\\/g, "/");
    const stat = statSync(fullPath);
    if (stat.size > 256_000) continue; // skip oversized bundles
    const content = readFileSync(fullPath, "utf8");

    const exports: string[] = [];
    const exportRegex =
      /export\s+(?:async\s+)?(?:function|const|let|class|interface|type)\s+([A-Za-z0-9_]+)/g;
    let m: RegExpExecArray | null;
    while ((m = exportRegex.exec(content)) !== null) {
      exports.push(m[1]);
    }

    const routes: string[] = [];
    const routeRegex =
      /\.(?:get|post|put|patch|delete)\(\s*["'`](\/[^"'`]*)["'`]/g;
    while ((m = routeRegex.exec(content)) !== null) {
      routes.push(m[1]);
    }

    entries.push({
      path: rel,
      sizeBytes: stat.size,
      exports: exports.slice(0, 30),
      routes: routes.slice(0, 20),
    });
  }

  const repoMap: RepoMap = {
    indexedAt: new Date().toISOString(),
    rootDir: workspaceDir,
    totalFiles: entries.length,
    entries,
  };

  mkdirSync(join(workspaceDir, ".agent"), { recursive: true });
  writeFileSync(
    join(workspaceDir, ".agent", "repo_map.json"),
    JSON.stringify(repoMap, null, 2),
    "utf8",
  );
  return repoMap;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_/-]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/**
 * Deterministic hashed bag-of-trigrams vector for fast local semantic similarity
 * (blended with BM25 lexical scoring; optionally upgraded with Pollinations embeddings).
 */
function localDenseVector(text: string, dims = 64): number[] {
  const vec = new Array<number>(dims).fill(0);
  const tokens = tokenize(text);
  for (const tok of tokens) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = Math.abs(h) % dims;
    vec[idx] += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

function cosineSim(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}

interface StoredChunk {
  id: string;
  scope: "codebase" | "worklogs" | "docs";
  sourcePath: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  tokens: string[];
  tf: Map<string, number>;
  vector: number[];
}

/**
 * Hybrid BM25 + Vector Semantic RAG Retriever (`rag_search`).
 * Indexes codebase files, docs, and archived historical worklogs so details compacted
 * out of Layer 6 stay retrievable over multi-day runs.
 */
export class HybridRagIndex {
  private chunks: StoredChunk[] = [];
  private df = new Map<string, number>();

  addDocument(params: {
    sourcePath: string;
    scope: "codebase" | "worklogs" | "docs";
    content: string;
    chunkLines?: number;
  }): number {
    const chunkLines = params.chunkLines ?? 40;
    const lines = params.content.split("\n");
    let added = 0;

    for (let start = 0; start < lines.length; start += chunkLines) {
      const slice = lines.slice(start, start + chunkLines).join("\n").trim();
      if (!slice) continue;
      const tokens = tokenize(slice);
      const tf = new Map<string, number>();
      const seen = new Set<string>();
      for (const tok of tokens) {
        tf.set(tok, (tf.get(tok) ?? 0) + 1);
        if (!seen.has(tok)) {
          seen.add(tok);
          this.df.set(tok, (this.df.get(tok) ?? 0) + 1);
        }
      }

      this.chunks.push({
        id: randomUUID().slice(0, 12),
        scope: params.scope,
        sourcePath: params.sourcePath,
        lineStart: start + 1,
        lineEnd: Math.min(lines.length, start + chunkLines),
        content: slice,
        tokens,
        tf,
        vector: localDenseVector(slice),
      });
      added += 1;
    }

    return added;
  }

  indexWorkspace(workspaceDir: string): number {
    let total = 0;
    const files = walkWorkspaceFiles(workspaceDir);
    for (const full of files) {
      const rel = relative(workspaceDir, full).replace(/\\/g, "/");
      const content = readFileSync(full, "utf8");
      const scope =
        rel === "WORKLOG.md"
          ? "worklogs"
          : rel.endsWith(".md")
            ? "docs"
            : "codebase";
      total += this.addDocument({ sourcePath: rel, scope, content });
    }
    return total;
  }

  rag_search(params: {
    query: string;
    scope?: "codebase" | "worklogs" | "docs" | "all";
    top_k?: number;
  }): RagChunk[] {
    const scope = params.scope ?? "all";
    const topK = params.top_k ?? 5;
    const candidates =
      scope === "all"
        ? this.chunks
        : this.chunks.filter((c) => c.scope === scope);
    if (candidates.length === 0) return [];

    const qTokens = tokenize(params.query);
    const qVec = localDenseVector(params.query);
    const N = this.chunks.length;
    const avgLen =
      this.chunks.reduce((s, c) => s + c.tokens.length, 0) / Math.max(1, N);
    const k1 = 1.5;
    const b = 0.75;

    const scored = candidates
      .map((chunk) => {
        let bm25 = 0;
        for (const qt of qTokens) {
          const freq = chunk.tf.get(qt) ?? 0;
          if (freq === 0) continue;
          const docFreq = this.df.get(qt) ?? 1;
          const idf = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5));
          const denom = freq + k1 * (1 - b + b * (chunk.tokens.length / Math.max(1, avgLen)));
          bm25 += idf * ((freq * (k1 + 1)) / denom);
        }
        const sem = cosineSim(qVec, chunk.vector);
        const score = Number((bm25 * 0.75 + sem * 2.5).toFixed(4));
        return { chunk, score };
      })
      .filter((item) => item.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return scored.map(({ chunk, score }) => ({
      id: chunk.id,
      scope: chunk.scope,
      sourcePath: chunk.sourcePath,
      lineStart: chunk.lineStart,
      lineEnd: chunk.lineEnd,
      content: chunk.content,
      score,
    }));
  }

  size(): number {
    return this.chunks.length;
  }
}
