import { create } from 'zustand'

interface UiStore {
  tasksOpen: boolean
  coinsOpen: boolean
  setTasksOpen: (v: boolean) => void
  setCoinsOpen: (v: boolean) => void

  helpOpen: boolean
  helpTopic: string
  setHelpOpen: (v: boolean) => void
  setHelpTopic: (v: string) => void
}

export const useUi = create<UiStore>((set) => ({
  tasksOpen: false,
  coinsOpen: false,
  setTasksOpen: (v) => set({ tasksOpen: v }),
  setCoinsOpen: (v) => set({ coinsOpen: v }),

  helpOpen: false,
  helpTopic: '',
  setHelpOpen: (v) => set({ helpOpen: v }),
  setHelpTopic: (v) => set({ helpTopic: v }),
}))
