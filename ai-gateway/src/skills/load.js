import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_BY_ID } from "./catalog.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../skills");
const cache = new Map(); // id -> { mtimeMs, body }

export function skillPath(id) {
  return join(ROOT, String(id), "SKILL.md");
}

export function loadSkill(id) {
  const meta = SKILL_BY_ID.get(id);
  if (!meta) return null;
  const path = skillPath(id);
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  const hit = cache.get(id);
  if (hit && hit.mtimeMs === st.mtimeMs) return { ...meta, body: hit.body, path };
  let body;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  cache.set(id, { mtimeMs: st.mtimeMs, body });
  return { ...meta, body, path };
}

export function __resetSkillCache() {
  cache.clear();
}
