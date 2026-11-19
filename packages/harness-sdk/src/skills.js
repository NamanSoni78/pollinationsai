/**
 * Dynamic skills: scan SKILL.md catalogs (workspace first, then the repo's
 * `.agents/skills`), parse minimal YAML frontmatter and move skill bodies in
 * and out of Layer 2 (`state.skills`).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const KEPT_KEYS = new Set(["name", "description", "token_estimate"]);

/**
 * Parse SKILL.md frontmatter: YAML between the leading `---` lines. Only
 * `name`, `description` and `token_estimate` are kept; folded (`>`) and
 * literal (`|`) scalars are supported (plain regex, no yaml dependency).
 *
 * @param {string} text SKILL.md contents
 * @returns {{meta: {name?: string, description?: string, token_estimate?: number}, body: string}}
 */
export function parseFrontmatter(text) {
    const source = String(text ?? "");
    const match = FRONTMATTER_RE.exec(source);
    if (!match) return { meta: {}, body: source };
    const body = source.slice(match[0].length);
    const meta = {};
    const lines = match[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
        if (!kv) continue;
        const [, key, raw] = kv;
        let value = raw.trim();
        if (value === ">" || value === "|" || /^[>|][+-]$/.test(value)) {
            const block = [];
            i += 1;
            while (
                i < lines.length &&
                (lines[i].startsWith(" ") ||
                    lines[i].startsWith("\t") ||
                    lines[i] === "")
            ) {
                block.push(lines[i].replace(/^[ \t]+/, ""));
                i += 1;
            }
            i -= 1;
            value = value.startsWith(">")
                ? block.join(" ").replace(/\s+/g, " ").trim()
                : block.join("\n").trim();
        } else {
            value = value.replace(/^["']|["']$/g, "");
        }
        if (KEPT_KEYS.has(key)) {
            meta[key] =
                key === "token_estimate"
                    ? /^\d+$/.test(value)
                        ? Number.parseInt(value, 10)
                        : null
                    : value;
        }
    }
    return { meta, body };
}

const readSkillFile = (path) => {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return null;
    }
};

const scanRoot = (root, source, out, seen) => {
    const skillsDir =
        source === "workspace"
            ? join(root, "skills")
            : join(root, ".agents", "skills");
    if (!existsSync(skillsDir)) return;
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = join(skillsDir, entry.name, "SKILL.md");
        if (!existsSync(file)) continue;
        const { meta } = parseFrontmatter(readSkillFile(file) ?? "");
        const name = meta.name || entry.name;
        if (seen.has(name)) continue; // workspace wins on name clash
        seen.add(name);
        out.push({
            name,
            description: meta.description ?? "",
            token_estimate: meta.token_estimate ?? null,
            source,
            path: file,
        });
    }
};

/**
 * Scan skill catalogs in order: `<workspace>/skills/<name>/SKILL.md` first,
 * then `<repoRoot>/.agents/skills/<name>/SKILL.md` (workspace wins on clash).
 *
 * @param {{workspace?: string, repoRoot?: string}} roots
 * @returns {Array<{name: string, description: string, token_estimate: number|null, source: string, path: string}>}
 */
export function scanSkills({ workspace, repoRoot } = {}) {
    const out = [];
    const seen = new Set();
    if (workspace) scanRoot(workspace, "workspace", out, seen);
    if (repoRoot) scanRoot(repoRoot, "repo", out, seen);
    return out;
}

/**
 * List skills known to the state: catalog entries (plus any manually loaded
 * skills) with their Layer 2 load status and estimated tokens.
 *
 * @param {object} state agent state (`skills`, `skillsCatalog`)
 * @returns {Array<{name: string, description: string, source: string, loaded: boolean, tokens: number|null}>}
 */
export function listSkills(state = {}) {
    const loaded = new Map(
        (state.skills ?? []).map((skill) => [skill.name, skill]),
    );
    const entries = [...(state.skillsCatalog ?? [])];
    for (const skill of state.skills ?? []) {
        if (!entries.some((entry) => entry.name === skill.name)) {
            entries.push({
                name: skill.name,
                description: skill.description ?? "",
                token_estimate: null,
                source: "manual",
                path: null,
            });
        }
    }
    return entries.map((entry) => {
        const skill = loaded.get(entry.name);
        return {
            name: entry.name,
            description: entry.description ?? "",
            source: entry.source,
            loaded: Boolean(skill),
            tokens: skill ? skill.tokens : null,
        };
    });
}

/**
 * Load a skill into Layer 2 (`state.skills`): reads the SKILL.md body and
 * injects it. Estimated tokens come from frontmatter `token_estimate` or
 * `ceil(chars / 4)`. Idempotent for already-loaded skills.
 *
 * @param {object} state agent state (`skills`, `skillsCatalog`)
 * @param {string} name skill name
 * @returns {{name: string, description: string, body: string, tokens: number, path: string}}
 * @throws {Error} code `skill_not_found` when the name is not in the catalog
 */
export function loadSkill(state, name) {
    const existing = (state.skills ?? []).find((skill) => skill.name === name);
    if (existing) return existing;
    const entry = (state.skillsCatalog ?? []).find(
        (skill) => skill.name === name,
    );
    if (!entry) {
        const error = new Error(`skill not found: ${name}`);
        error.code = "skill_not_found";
        throw error;
    }
    const { body } = parseFrontmatter(readSkillFile(entry.path) ?? "");
    const skill = {
        name: entry.name,
        description: entry.description ?? "",
        body,
        tokens: entry.token_estimate ?? Math.ceil(body.length / 4),
        path: entry.path,
    };
    state.skills = [...(state.skills ?? []), skill];
    return skill;
}

/**
 * Remove a skill from Layer 2, freeing its tokens.
 *
 * @param {object} state agent state (`skills`)
 * @param {string} name skill name
 * @returns {boolean} true when a loaded skill was removed
 */
export function unloadSkill(state, name) {
    const before = (state.skills ?? []).length;
    state.skills = (state.skills ?? []).filter((skill) => skill.name !== name);
    return (state.skills ?? []).length < before;
}
