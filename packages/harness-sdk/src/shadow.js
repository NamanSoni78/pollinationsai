/**
 * Shadow Reader: answer a question about ANOTHER agent's workspace using
 * BM25 over its files (chunks + WORKLOG), quoting excerpts with file:line
 * citations. Strictly read-only — zero writes to the target workspace.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { collectChunks, rankChunks, tokenize } from "./rag.js";

const WORKLOG_TAIL_LINES = 10;

const worklogTail = (targetWorkspace) => {
    const path = join(targetWorkspace, "WORKLOG.md");
    if (!existsSync(path)) return null;
    const lines = readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0);
    if (!lines.length) return null;
    return lines.slice(-WORKLOG_TAIL_LINES).join("\n");
};

/**
 * Read-only BM25 query over a target workspace.
 *
 * @param {string} targetWorkspace absolute path of the target agent workspace
 * @param {string} question free-text question
 * @returns {{answer: string, citations: string[], status: "answered"}}
 *   `citations` are `file:startLine-endLine` strings; the answer quotes the
 *   top 3 excerpts plus the WORKLOG tail.
 */
export function shadowRead(targetWorkspace, question) {
    if (!targetWorkspace)
        throw new Error("shadowRead requires targetWorkspace");
    const chunks = collectChunks(targetWorkspace);
    const top = rankChunks(chunks, tokenize(String(question ?? "")), 3);
    const citations = top.map(
        (chunk) => `${chunk.file}:${chunk.startLine}-${chunk.endLine}`,
    );
    const blocks = top.map(
        (chunk) =>
            `\`${chunk.file}:${chunk.startLine}-${chunk.endLine}\`\n${chunk.preview}`,
    );
    const tail = worklogTail(targetWorkspace);
    const parts = [];
    if (top.length) {
        parts.push(`Shadow read for: ${question}`, ...blocks);
    } else {
        parts.push(
            `No relevant content found in the target workspace for: ${question}`,
        );
    }
    if (tail) parts.push(`Recent WORKLOG milestones:\n${tail}`);
    return { answer: parts.join("\n\n"), citations, status: "answered" };
}
