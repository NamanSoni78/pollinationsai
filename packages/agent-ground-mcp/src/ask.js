import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", ".agent"]);
const MAX_FILE_BYTES = 262144;
const MAX_FILES = 300;
const TOP_K = 3;
const WORKLOG_TAIL = 10;

function badRequest(message) {
    const err = new Error(message);
    err.status = 400;
    err.code = "invalid_input";
    return err;
}

/** Lowercase alphanumeric tokens. */
export function tokenize(text) {
    return String(text ?? "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((term) => term.length > 0);
}

function walkFiles(dir, root = dir, out = []) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const entry of entries) {
        if (out.length >= MAX_FILES) return out;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) walkFiles(full, root, out);
        } else if (entry.isFile()) {
            try {
                if (fs.statSync(full).size <= MAX_FILE_BYTES) {
                    out.push({
                        abs: full,
                        rel: path
                            .relative(root, full)
                            .split(path.sep)
                            .join("/"),
                    });
                }
            } catch {
                /* unreadable file: skip */
            }
        }
    }
    return out;
}

function loadDoc(file) {
    let text;
    try {
        text = fs.readFileSync(file.abs, "utf8");
    } catch {
        return null;
    }
    if (text.includes("\0")) return null; // binary: skip
    return { rel: file.rel, lines: text.split("\n"), terms: tokenize(text) };
}

/** BM25 (k1=1.5, b=0.75) scores of `docs` against `queryTerms`. */
export function bm25Scores(queryTerms, docs, k1 = 1.5, b = 0.75) {
    const total = docs.length;
    if (total === 0) return [];
    const averageLength =
        docs.reduce((sum, doc) => sum + doc.terms.length, 0) / total || 1;
    const docFrequency = new Map();
    for (const doc of docs) {
        for (const term of new Set(doc.terms)) {
            docFrequency.set(term, (docFrequency.get(term) ?? 0) + 1);
        }
    }
    return docs.map((doc) => {
        const termFrequency = new Map();
        for (const term of doc.terms) {
            termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1);
        }
        let score = 0;
        for (const term of new Set(queryTerms)) {
            const frequency = termFrequency.get(term);
            if (!frequency) continue;
            const containing = docFrequency.get(term) ?? 0;
            const idf = Math.log(
                1 + (total - containing + 0.5) / (containing + 0.5),
            );
            score +=
                (idf * (frequency * (k1 + 1))) /
                (frequency +
                    k1 * (1 - b + b * (doc.terms.length / averageLength)));
        }
        return score;
    });
}

function bestLine(doc, queryTerms) {
    const wanted = new Set(queryTerms);
    let best = {
        line: 1,
        hits: 0,
        excerpt: (doc.lines[0] ?? "").trim().slice(0, 200),
    };
    for (let i = 0; i < doc.lines.length; i++) {
        const line = doc.lines[i];
        if (!line.trim()) continue;
        const hits = tokenize(line).filter((term) => wanted.has(term)).length;
        if (hits > best.hits) {
            best = { line: i + 1, hits, excerpt: line.trim().slice(0, 200) };
        }
    }
    return best;
}

function worklogTail(workspace) {
    try {
        const raw = fs.readFileSync(path.join(workspace, "WORKLOG.md"), "utf8");
        return raw
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== "")
            .slice(-WORKLOG_TAIL);
    } catch {
        return [];
    }
}

/**
 * Read-only Shadow Reader: BM25-rank the target workspace files, answer with
 * quoted excerpts + `path:line` citations and the WORKLOG tail. Never writes.
 */
export function shadowRead(workspace, question) {
    const queryTerms = tokenize(question);
    const docs = walkFiles(workspace).map(loadDoc).filter(Boolean);
    const scores = bm25Scores(queryTerms, docs);
    const ranked = docs
        .map((doc, i) => ({ doc, score: scores[i] }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, TOP_K);
    const citations = ranked.map(({ doc }) => {
        const { line, excerpt } = bestLine(doc, queryTerms);
        return { path: doc.rel, line, excerpt };
    });
    const tail = worklogTail(workspace);
    const parts = [];
    if (citations.length > 0) {
        parts.push(
            citations
                .map((c) => `- ${c.path}:${c.line}: "${c.excerpt}"`)
                .join("\n"),
        );
    } else {
        parts.push(
            "No strongly matching files were found for this question in the target workspace.",
        );
    }
    if (tail.length > 0) {
        parts.push(
            `Recent WORKLOG entries:\n${tail.map((line) => `- ${line}`).join("\n")}`,
        );
    }
    return { answer: parts.join("\n\n"), citations };
}

function atomicWriteJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(tmp, filePath);
}

/**
 * negotiate_change channel: append a pending request to the target's
 * `.agent/inbox.json` (atomic, create-if-missing). Delivered by the target
 * runtime at its next step boundary.
 */
export function negotiateChange({ workspace, from, question }) {
    const inboxPath = path.join(workspace, ".agent", "inbox.json");
    let entries = [];
    if (fs.existsSync(inboxPath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(inboxPath, "utf8"));
            if (Array.isArray(parsed)) entries = parsed;
        } catch {
            entries = []; // unreadable inbox: start a fresh queue
        }
    }
    const entry = {
        id: crypto.randomUUID(),
        from: from ?? "parent",
        question,
        at: new Date().toISOString(),
        status: "pending",
    };
    entries.push(entry);
    atomicWriteJson(inboxPath, entries);
    return entry;
}

function isDirectorySafe(candidate) {
    try {
        return fs.statSync(candidate).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Shoulder tap dispatcher. readonly_query -> shadowRead (zero writes);
 * negotiate_change -> inbox append. Emits ground.reply / ground.inbox.
 * `reply_timeout_sec` is accepted for API compatibility but not enforced
 * (the inbox queue has no expiry by design).
 */
export async function askAgent({ getCard, events, input }) {
    const {
        target_agent_id,
        question,
        mode = "readonly_query",
        from,
    } = input ?? {};
    if (typeof target_agent_id !== "string" || target_agent_id.trim() === "") {
        throw badRequest("target_agent_id is required");
    }
    if (typeof question !== "string" || question.trim() === "") {
        throw badRequest("question is required");
    }
    if (mode !== "readonly_query" && mode !== "negotiate_change") {
        throw badRequest("mode must be 'readonly_query' or 'negotiate_change'");
    }
    const card = getCard(target_agent_id);
    if (!card) {
        const err = new Error(`unknown agent: ${target_agent_id}`);
        err.status = 404;
        err.code = "unknown_agent";
        throw err;
    }
    const workspace = typeof card.workspace === "string" ? card.workspace : "";
    if (workspace === "" || !isDirectorySafe(workspace)) {
        return { answer: null, status: "unavailable" };
    }
    if (mode === "negotiate_change") {
        const entry = negotiateChange({ workspace, from, question });
        events.emit("ground.inbox", {
            agentId: target_agent_id,
            from: entry.from,
            request: question,
        });
        return { answer: null, status: "queued" };
    }
    const { answer, citations } = shadowRead(workspace, question);
    events.emit("ground.reply", {
        targetAgentId: target_agent_id,
        question,
        answer,
        status: "answered",
    });
    return { answer, citations, status: "answered" };
}
