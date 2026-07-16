import { create } from 'zustand'

type ExplorerPaths = {
  localPath: string
  remotePath: string
}

type ExplorerStore = {
  /** Local cwd per server id. */
  localByServerId: Record<string, string>
  /** Remote cwd per server id. */
  remoteByServerId: Record<string, string>
  setLocalPath: (serverId: string, path: string) => void
  setRemotePath: (serverId: string, path: string) => void
  getPaths: (serverId: string, persistedLocalPath?: string) => ExplorerPaths
}

const DEFAULT_LOCAL = 'C:/'
const DEFAULT_REMOTE = '/'

export const useExplorerStore = create<ExplorerStore>((set, get) => ({
  localByServerId: {},
  remoteByServerId: {},

  setLocalPath: (serverId, path) =>
    set(state => ({
      localByServerId: { ...state.localByServerId, [serverId]: path },
    })),

  setRemotePath: (serverId, path) =>
    set(state => ({
      remoteByServerId: { ...state.remoteByServerId, [serverId]: path },
    })),

  getPaths: (serverId, persistedLocalPath) => {
    const state = get()
    return {
      localPath: state.localByServerId[serverId] || persistedLocalPath || DEFAULT_LOCAL,
      remotePath: state.remoteByServerId[serverId] || DEFAULT_REMOTE,
    }
  },
}))
