import { create } from 'zustand'

interface UiStore {
  tasksOpen: boolean
  coinsOpen: boolean
  setTasksOpen: (v: boolean) => void
  setCoinsOpen: (v: boolean) => void
}

export const useUi = create<UiStore>((set) => ({
  tasksOpen: false,
  coinsOpen: false,
  setTasksOpen: (v) => set({ tasksOpen: v }),
  setCoinsOpen: (v) => set({ coinsOpen: v }),
}))
