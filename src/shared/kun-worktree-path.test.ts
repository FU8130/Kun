import { describe, expect, it } from 'vitest'
import {
  isKunBranchWorktreePath,
  parseKunBranchWorktreeLayout,
  resolveKunBranchWorktreeProjectPath
} from './kun-worktree-path'

describe('kun-worktree-path', () => {
  it('recognizes default Kun branch worktree paths', () => {
    const path = '/Users/zxy/.kun/worktrees/0ff7/Kook-VoiceShop-Bot'
    expect(isKunBranchWorktreePath(path)).toBe(true)
    expect(parseKunBranchWorktreeLayout(path)).toEqual({
      poolId: '0ff7',
      repoName: 'Kook-VoiceShop-Bot'
    })
    expect(
      resolveKunBranchWorktreeProjectPath(path, ['/Users/zxy/code/Kook-VoiceShop-Bot'])
    ).toBe('/Users/zxy/code/Kook-VoiceShop-Bot')
  })

  it('recognizes custom worktree roots that still use the worktrees layout', () => {
    const path = '/data/worktrees/ab12/my-repo'
    expect(isKunBranchWorktreePath(path)).toBe(true)
  })

  it('rejects regular project directories', () => {
    expect(isKunBranchWorktreePath('/Users/zxy/code/Kook-VoiceShop-Bot')).toBe(false)
    expect(isKunBranchWorktreePath('/Users/zxy/.kun/default_workspace')).toBe(false)
  })

  it('resolves a worktree path back to a known project root by repo basename', () => {
    const projectPath = '/Users/zxy/code/Kook-VoiceShop-Bot'
    const worktreePath = '/Users/zxy/.kun/worktrees/38e2/Kook-VoiceShop-Bot'
    expect(
      resolveKunBranchWorktreeProjectPath(worktreePath, [projectPath, '/Users/zxy/code/DeepSeek-GUI'])
    ).toBe(projectPath)
  })

  it('ignores worktree paths when matching project roots by repo basename', () => {
    expect(
      resolveKunBranchWorktreeProjectPath(
        '/Users/zxy/.kun/worktrees/ab12/Kook-VoiceShop-Bot',
        [
          '/Users/zxy/.kun/worktrees/ab12/Kook-VoiceShop-Bot',
          '/Users/zxy/code/Kook-VoiceShop-Bot'
        ]
      )
    ).toBe('/Users/zxy/code/Kook-VoiceShop-Bot')
  })
})
