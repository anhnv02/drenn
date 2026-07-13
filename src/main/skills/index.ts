import { promises as fs } from 'fs';
import { join, basename, dirname } from 'path';
import { homedir } from 'os';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { splitFrontmatter } from '../agent/subagent/store';

const execFileAsync = promisify(execFile);

const GLOBAL_SKILLS_DIR = join(homedir(), '.config', 'drenn', 'skills');
const GLOBAL_CLAUDE_SKILLS_DIR = join(homedir(), '.claude', 'skills');

interface SkillMeta {
  name: string;
  description: string;
  filePath: string;
  scope: 'global' | 'project';
}

interface Skill extends SkillMeta {
  body: string;
}

const SKILL_TTL_MS = 15_000;

const projectSkillsCache = new Map<string, { skills: Map<string, SkillMeta>; loadedAt: number }>();

async function readDirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function statSafe(path: string): Promise<import('fs').Stats | null> {
  try {
    return await fs.stat(path);
  } catch {
    return null;
  }
}

async function parseSkillFile(
  filePath: string,
  scope: 'global' | 'project',
): Promise<SkillMeta | null> {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const { data } = splitFrontmatter(text);

    const description =
      typeof data.description === 'string'
        ? data.description.trim()
        : typeof data.when_to_use === 'string'
          ? data.when_to_use.trim()
          : '';

    const dirName = basename(dirname(filePath));
    const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : dirName;

    return { name, description, filePath, scope };
  } catch {
    return null;
  }
}

async function scanSkillsDir(dir: string, scope: 'global' | 'project'): Promise<SkillMeta[]> {
  const entries = await readDirSafe(dir);
  const skills: SkillMeta[] = [];

  for (const entry of entries) {
    const skillDir = join(dir, entry);
    const stat = await statSafe(skillDir);
    if (!stat?.isDirectory()) continue;

    const skillFile = join(skillDir, 'SKILL.md');
    const skill = await parseSkillFile(skillFile, scope);
    if (skill) skills.push(skill);
  }

  return skills;
}

export async function refreshProjectSkills(cwd: string): Promise<void> {
  const cached = projectSkillsCache.get(cwd);
  if (cached && Date.now() - cached.loadedAt < SKILL_TTL_MS) return;

  const projectDrenn = join(cwd, '.drenn', 'skills');
  const projectClaude = join(cwd, '.claude', 'skills');

  const [drennProject, claudeProject, drennGlobal, claudeGlobal] = await Promise.all([
    scanSkillsDir(projectDrenn, 'project'),
    scanSkillsDir(projectClaude, 'project'),
    scanSkillsDir(GLOBAL_SKILLS_DIR, 'global'),
    scanSkillsDir(GLOBAL_CLAUDE_SKILLS_DIR, 'global'),
  ]);

  const byName = new Map<string, SkillMeta>();
  for (const s of drennGlobal) byName.set(s.name, s);
  for (const s of claudeGlobal) byName.set(s.name, s);
  for (const s of drennProject) byName.set(s.name, s);
  for (const s of claudeProject) byName.set(s.name, s);

  projectSkillsCache.set(cwd, { skills: byName, loadedAt: Date.now() });
}

export function listProjectSkills(cwd: string): SkillMeta[] {
  const skills = projectSkillsCache.get(cwd)?.skills;
  if (!skills) return [];
  return Array.from(skills.values());
}

export function getSkill(name: string, cwd: string): SkillMeta | undefined {
  return projectSkillsCache.get(cwd)?.skills.get(name);
}

export async function loadSkillContent(skill: SkillMeta, cwd: string): Promise<string | null> {
  try {
    const text = await fs.readFile(skill.filePath, 'utf8');
    const { body } = splitFrontmatter(text);
    return renderBody(body, cwd);
  } catch {
    return null;
  }
}

async function renderBody(body: string, cwd: string): Promise<string> {
  const inlinePattern = /!`([^`]+)`/g;
  const matches = [...body.matchAll(inlinePattern)];
  if (matches.length === 0) return body;

  let result = body;
  for (const match of matches) {
    const [full, cmd] = match;
    try {
      const { stdout } = await execFileAsync('bash', ['-c', cmd], {
        cwd,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      result = result.replace(full, stdout.trim());
    } catch {
      result = result.replace(full, `[command failed: ${cmd}]`);
    }
  }
  return result;
}

export function getSkillPromptSection(cwd: string): string {
  const skills = listProjectSkills(cwd);
  if (skills.length === 0) return '';
  const lines = skills.map((s) => `- ${s.name}: ${s.description || '(no description)'}`);
  return `Available skills (invoke via /skill-name, or the model may auto-load when relevant):\n${lines.join('\n')}`;
}
