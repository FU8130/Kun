/**
 * Path helpers for Kun-managed conversation worktrees created by git-service
 * under `<worktreeRoot>/<4-hex-id>/<repo-basename>`.
 */

export type KunBranchWorktreeLayout = {
  poolId: string
  repoName: string
}

function normalizePathForMatch(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

export function parseKunBranchWorktreeLayout(path: string): KunBranchWorktreeLayout | null {
  const normalized = normalizePathForMatch(path.trim())
  if (!normalized) return null
  const match = normalized.match(/\/([0-9a-f]{4})\/([^/]+)$/i)
  if (!match) return null
  const poolId = match[1] ?? ''
  const repoName = match[2] ?? ''
  if (!poolId || !repoName) return null
  const prefix = normalized.slice(0, -(poolId.length + repoName.length + 2))
  // Kun conversation worktrees always live under a ".../worktrees/..." root.
  // Scheduled-agent pool slots use ".../.kun/wt-N" instead and are excluded.
  if (!/\/worktrees(?:\/|$)/i.test(prefix)) return null
  if (/\/\.kun\/wt-\d+(?:\/|$)/i.test(prefix)) return null
  return { poolId, repoName }
}

export function isKunBranchWorktreePath(path: string): boolean {
  return parseKunBranchWorktreeLayout(path) != null
}

export function resolveKunBranchWorktreeProjectPath(
  worktreePath: string,
  candidateProjectPaths: readonly string[]
): string {
  const layout = parseKunBranchWorktreeLayout(worktreePath)
  if (!layout) return ''
  for (const candidate of candidateProjectPaths) {
    const trimmed = candidate.trim()
    if (!trimmed || isKunBranchWorktreePath(trimmed)) continue
    const normalized = normalizePathForMatch(trimmed)
    if (!normalized) continue
    const parts = normalized.split('/').filter(Boolean)
    if (parts[parts.length - 1] === layout.repoName) return trimmed
  }
  return ''
}
