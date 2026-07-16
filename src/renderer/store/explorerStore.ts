import { create } from 'zustand'

type ExplorerPaths = {
  localPath: string
  remotePath: string
}

type ExplorerStore = {
  /** Last local path used in any explorer session. */
  localPath: string
  /** Remote cwd per server id. */
  remoteByServerId: Record<string, string>
  setLocalPath: (path: string) => void
  setRemotePath: (serverId: string, path: string) => void
  getPaths: (serverId: string) => ExplorerPaths
}

const DEFAULT_LOCAL = 'C:/Users/Michael'
const DEFAULT_REMOTE = '/'

export const useExplorerStore = create<ExplorerStore>((set, get) => ({
  localPath: DEFAULT_LOCAL,
  remoteByServerId: {},

  setLocalPath: (path) => set({ localPath: path }),

  setRemotePath: (serverId, path) =>
    set(state => ({
      remoteByServerId: { ...state.remoteByServerId, [serverId]: path },
    })),

  getPaths: (serverId) => {
    const state = get()
    return {
      localPath: state.localPath || DEFAULT_LOCAL,
      remotePath: state.remoteByServerId[serverId] || DEFAULT_REMOTE,
    }
  },
}))
