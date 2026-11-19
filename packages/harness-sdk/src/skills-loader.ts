import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens } from "./context-compiler";
import type { SkillMetadata } from "./types";

interface ParsedSkill {
  meta: SkillMetadata;
  body: string;
}

/**
 * Minimal zero-dependency YAML frontmatter parser compatible with
 * Pollinations `.agents/skills/<name>/SKILL.md` files (including Ponytail).
 */
export function parseSkillMarkdown(raw: string, filePath: string, fallbackName: string): ParsedSkill {
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  let name = fallbackName;
  let description = "";
  let requiredTools: string[] = [];
  let tokenEstimate: number | undefined;
  let body = raw;

  if (fmMatch) {
    const yamlBlock = fmMatch[1];
    body = fmMatch[2].trim();

    const lines = yamlBlock.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1].trim();
      let val = kv[2].trim();

      // Handle YAML folded scalar (`>` or `|`)
      if (val === ">" || val === "|") {
        const folded: string[] = [];
        while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
          i += 1;
          folded.push(lines[i].trim());
        }
        val = folded.join(" ");
      } else {
        val = val.replace(/^["']|["']$/g, "");
      }

      if (key === "name" && val) name = val;
      if (key === "description") description = val;
      if (key === "token_estimate") {
        const n = Number.parseInt(val, 10);
        if (Number.isFinite(n)) tokenEstimate = n;
      }
      if (key === "required_tools") {
        if (val.startsWith("[") && val.endsWith("]")) {
          requiredTools = val
            .slice(1, -1)
            .split(",")
            .map((s) => s.trim().replace(/^["']|["']$/g, ""))
            .filter(Boolean);
        } else if (val) {
          requiredTools = [val];
        }
      }
    }
  }

  return {
    meta: {
      name,
      description: description || `Domain skill loaded from ${filePath}`,
      required_tools: requiredTools,
      token_estimate: tokenEstimate ?? estimateTokens(body),
      filePath,
      loaded: false,
    },
    body,
  };
}

/**
 * Dynamic SDK Skills Loader (Progressive Disclosure — Issue #20357 §3.C).
 * Scans `.agents/skills/<name>/SKILL.md` and `skills/<name>/SKILL.md`. Exposes only tiny
 * metadata (`name` + 1-line `description`) at startup; dynamically mounts and
 * unmounts full instructions into Layer 2 on demand.
 */
export class DynamicSkillsLoader {
  private registry = new Map<string, ParsedSkill>();
  private activeSkillNames = new Set<string>();

  constructor(private readonly searchDirs: string[]) {
    this.discover();
  }

  discover(): number {
    this.registry.clear();
    for (const dir of this.searchDirs) {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const skillFile = join(dir, entry.name, "SKILL.md");
        if (!existsSync(skillFile)) continue;
        try {
          const raw = readFileSync(skillFile, "utf8");
          const parsed = parseSkillMarkdown(raw, skillFile, entry.name);
          this.registry.set(parsed.meta.name, parsed);
        } catch {
          // Skip unreadable or dangling symlink skills
        }
      }
    }
    return this.registry.size;
  }

  registerInlineSkill(params: {
    name: string;
    description: string;
    instructions: string;
    required_tools?: string[];
  }): void {
    this.registry.set(params.name, {
      meta: {
        name: params.name,
        description: params.description,
        required_tools: params.required_tools ?? [],
        token_estimate: estimateTokens(params.instructions),
        filePath: `inline://${params.name}/SKILL.md`,
        loaded: this.activeSkillNames.has(params.name),
      },
      body: params.instructions,
    });
  }

  list_skills(): Array<{
    name: string;
    description: string;
    loaded: boolean;
    est_tokens: number;
    required_tools: string[];
  }> {
    return Array.from(this.registry.values())
      .map((entry) => ({
        name: entry.meta.name,
        description: entry.meta.description,
        loaded: this.activeSkillNames.has(entry.meta.name),
        est_tokens: entry.meta.token_estimate,
        required_tools: entry.meta.required_tools,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  load_skill(params: { name: string }): {
    loaded: boolean;
    instructions_injected: boolean;
    tokens_added: number;
  } {
    const skill = this.registry.get(params.name);
    if (!skill) {
      throw new Error(`Skill "${params.name}" not found. Call list_skills() first.`);
    }
    const alreadyLoaded = this.activeSkillNames.has(params.name);
    this.activeSkillNames.add(params.name);
    skill.meta.loaded = true;
    return {
      loaded: true,
      instructions_injected: true,
      tokens_added: alreadyLoaded ? 0 : skill.meta.token_estimate,
    };
  }

  unload_skill(params: { name: string }): {
    unloaded: boolean;
    tokens_freed: number;
  } {
    const skill = this.registry.get(params.name);
    if (!skill || !this.activeSkillNames.has(params.name)) {
      return { unloaded: false, tokens_freed: 0 };
    }
    this.activeSkillNames.delete(params.name);
    skill.meta.loaded = false;
    return {
      unloaded: true,
      tokens_freed: skill.meta.token_estimate,
    };
  }

  getActiveSkillsForContext(): Array<{ name: string; instructions: string; est_tokens: number }> {
    const active: Array<{ name: string; instructions: string; est_tokens: number }> = [];
    for (const name of this.activeSkillNames) {
      const entry = this.registry.get(name);
      if (entry) {
        active.push({
          name: entry.meta.name,
          instructions: entry.body,
          est_tokens: entry.meta.token_estimate,
        });
      }
    }
    return active;
  }

  getActiveSkillNames(): string[] {
    return Array.from(this.activeSkillNames);
  }

  restoreActiveSkills(names: string[]): void {
    this.activeSkillNames.clear();
    for (const name of names) {
      if (this.registry.has(name)) {
        this.activeSkillNames.add(name);
      }
    }
  }
}
