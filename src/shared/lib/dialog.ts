import { create } from 'zustand'

export type DialogTone = 'default' | 'danger'

interface ConfirmReq {
  kind: 'confirm'
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: DialogTone
  resolve: (v: boolean) => void
}
interface PromptReq {
  kind: 'prompt'
  title: string
  message?: string
  placeholder?: string
  defaultValue?: string
  confirmLabel?: string
  cancelLabel?: string
  resolve: (v: string | null) => void
}
export type DialogReq = ConfirmReq | PromptReq

interface DialogStore {
  current: DialogReq | null
  queue: DialogReq[]
  push: (req: DialogReq) => void
  resolveCurrent: (payload: boolean | string | null) => void
}

/** Очередь модальных диалогов (замена нативных confirm/prompt). Рендерит DialogHost. */
export const useDialog = create<DialogStore>((set, get) => ({
  current: null,
  queue: [],
  push: (req) => set((s) => (s.current ? { queue: [...s.queue, req] } : { current: req })),
  resolveCurrent: (payload) => {
    const cur = get().current
    if (cur) (cur.resolve as (v: boolean | string | null) => void)(payload)
    set((s) => {
      const [next, ...rest] = s.queue
      return { current: next ?? null, queue: rest }
    })
  },
}))

/** Красивое подтверждение вместо window.confirm. @returns true — подтвердил, false — отменил. */
export function confirmDialog(opts: Omit<ConfirmReq, 'kind' | 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => useDialog.getState().push({ kind: 'confirm', ...opts, resolve }))
}

/** Красивый ввод строки вместо window.prompt. @returns строка или null (отмена/пусто). */
export function promptDialog(opts: Omit<PromptReq, 'kind' | 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => useDialog.getState().push({ kind: 'prompt', ...opts, resolve }))
}
