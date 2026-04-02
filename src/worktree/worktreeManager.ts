import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(tmpdir(), 'crew-worktrees');

export interface WorktreeRequest { repoUrl: string; baseRef?: string; runId: string; agentId: string; }
export interface WorktreeResult { worktreePath: string; branch: string; baseRef: string; }

function safeSlug(v: string): string { return v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }
function parseRepoKey(url: string): string { const c = url.replace(/\.git$/, ''); const p = c.split('/'); return safeSlug(p[p.length-2]||'x')+'--'+safeSlug(p[p.length-1]||'r'); }

export function prepareAgentWorktree(req: WorktreeRequest): WorktreeResult {
  const bareRoot = join(ROOT, 'bare');
  const treeRoot = join(ROOT, 'trees');
  mkdirSync(bareRoot, { recursive: true });
  mkdirSync(treeRoot, { recursive: true });
  const repoKey = parseRepoKey(req.repoUrl);
  const remoteUrl = req.repoUrl.endsWith('.git') ? req.repoUrl : req.repoUrl + '.git';
  const barePath = join(bareRoot, repoKey + '.git');
  const baseRef = req.baseRef || 'main';
  const branch = 'agent/' + safeSlug(req.runId) + '-' + safeSlug(req.agentId);
  const wtPath = join(treeRoot, repoKey + '--' + safeSlug(req.runId) + '--' + safeSlug(req.agentId));
  if (!existsSync(barePath)) { execFileSync('git', ['clone', '--bare', remoteUrl, barePath], { stdio: 'pipe', timeout: 120000 }); }
  else { execFileSync('git', ['--git-dir=' + barePath, 'fetch', '--all', '--prune'], { stdio: 'pipe', timeout: 120000 }); }
  if (!existsSync(wtPath)) {
    try { execFileSync('git', ['--git-dir=' + barePath, 'show-ref', '--verify', '--quiet', 'refs/heads/' + branch], { stdio: 'pipe' }); execFileSync('git', ['--git-dir=' + barePath, 'worktree', 'add', wtPath, branch], { stdio: 'pipe', timeout: 120000 }); }
    catch { execFileSync('git', ['--git-dir=' + barePath, 'worktree', 'add', wtPath, '-b', branch, 'origin/' + baseRef], { stdio: 'pipe', timeout: 120000 }); }
  }
  return { worktreePath: wtPath, branch, baseRef };
}

export function getWorktreeStatus(wtPath: string): { ahead: number; behind: number; headSha: string } {
  const sha = execFileSync('git', ['-C', wtPath, 'rev-parse', 'HEAD'], { stdio: 'pipe' }).toString().trim();
  return { ahead: 0, behind: 0, headSha: sha };
}

export function cleanupWorktrees(runId: string): void {
  // Remove worktrees for a specific run
  const treeRoot = join(ROOT, 'trees');
  if (!existsSync(treeRoot)) return;
  const slug = safeSlug(runId);
  for (const d of readdirSync(treeRoot)) { if (d.includes(slug)) { try { rmSync(join(treeRoot, d), { recursive: true, force: true }); } catch {} } }
}
