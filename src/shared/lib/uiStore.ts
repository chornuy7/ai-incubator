import { create } from 'zustand'

interface UiStore {
  tasksOpen: boolean
  coinsOpen: boolean
  setTasksOpen: (v: boolean) => void
  setCoinsOpen: (v: boolean) => void

  /**
   * Текст ошибки «кончились монеты» (пусто = окна нет). Отдельное состояние, а не
   * тост: тост уезжает в угол и его пропускают — а запуск при этом НЕ состоялся,
   * и человек должен увидеть и причину, и путь к пополнению, не ища их сам.
   */
  noCoins: string
  setNoCoins: (v: string) => void

  /**
   * Текст ошибки «модуль не оплачен». Отдельно от `noCoins`: причина другая и
   * следующий шаг другой — в кабинет подписки, а не пополнять монеты.
   */
  noSubscription: string
  setNoSubscription: (v: string) => void

  /**
   * MR-153: доступ отключён администратором (ACCESS_DISABLED, 403 из accessGate).
   * Пусто = не заблокирован. Держим текст причины: показываем поп-ап с blur поверх всей
   * панели — заблокированному оставляем только «Мой аккаунт» и «Поддержку».
   */
  accessBlocked: string
  setAccessBlocked: (v: string) => void

  helpOpen: boolean
  helpTopic: string
  setHelpOpen: (v: boolean) => void
  setHelpTopic: (v: string) => void
}

export const useUi = create<UiStore>((set, get) => ({
  tasksOpen: false,
  coinsOpen: false,
  setTasksOpen: (v) => set({ tasksOpen: v }),
  setCoinsOpen: (v) => set({ coinsOpen: v }),

  // Пока доступ закрыт админом, окна про деньги молчат: советовать «пополните баланс»
  // человеку, которому выключили доступ, — врать о причине. Ровно это и просили убрать
  // на созвоне 19.08, только там речь шла про текст, а здесь окно наезжало сверху.
  noCoins: '',
  setNoCoins: (v) => set({ noCoins: get().accessBlocked ? '' : v }),

  noSubscription: '',
  setNoSubscription: (v) => set({ noSubscription: get().accessBlocked ? '' : v }),

  accessBlocked: '',
  // Блок пришёл — гасим всё, что успело всплыть до него: на экране должна остаться одна
  // причина, а не стопка окон.
  setAccessBlocked: (v) => set(v ? { accessBlocked: v, noCoins: '', noSubscription: '' } : { accessBlocked: '' }),

  helpOpen: false,
  helpTopic: '',
  setHelpOpen: (v) => set({ helpOpen: v }),
  setHelpTopic: (v) => set({ helpTopic: v }),
}))
