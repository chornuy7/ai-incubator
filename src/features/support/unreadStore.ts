import { useEffect } from 'react'
import { create } from 'zustand'
import { fetchTicketsUnread } from '@/api/ticketsApi'

/**
 * ОДИН счётчик непрочитанных обращений на всё приложение.
 *
 * Приёмка 31.08: сотрудник прочитал ответ администратора — значок на кнопке поддержки
 * погас, а в боковом меню «Поддержка 1» осталась. Ничего не сломалось: счётчик считали
 * ДВА независимых потребителя своими таймерами — виджет раз в 30 секунд, меню раз в 60.
 * До минуты они честно показывали разное, и понять, где правда, было нельзя.
 *
 * Лечим тем же приёмом, что и баланс (MR-151): общее значение, один таймер на всех
 * подписчиков и дедупликация запросов. Плюс `refreshUnread()` — прочитали обращение,
 * позвали, и цифра меняется сразу у обоих, не дожидаясь следующего тика.
 *
 * Сторона важна: поддержка считает ЧУЖИЕ обращения, остальные — свои. Смена стороны
 * сбрасывает значение, иначе на секунду показался бы чужой счёт.
 */
const POLL_MS = 30000

interface UnreadStore {
  count: number
  /** Чья сторона считается сейчас: поддержка видит все обращения, остальные — свои. */
  side: boolean
  refresh: () => Promise<number>
}

let inflight: Promise<number> | null = null

export const useUnreadStore = create<UnreadStore>((set, get) => ({
  count: 0,
  side: false,
  refresh: () => {
    if (inflight) return inflight
    inflight = fetchTicketsUnread(get().side)
      .then((n) => { set({ count: n }); return n })
      // Сеть легла — оставляем прошлое значение: мигающий счётчик хуже неточного.
      .catch(() => get().count)
      .finally(() => { inflight = null })
    return inflight
  },
}))

/** Перечитать счётчик из любого места: после прочтения обращения, ответа, закрытия. */
export const refreshUnread = () => useUnreadStore.getState().refresh()

let timer: number | null = null
let watchers = 0

/**
 * Счётчик непрочитанного + участие в общем опросе.
 * @param side true — считаем как поддержка (все обращения), иначе свои.
 */
export function useUnread(side: boolean): number {
  const count = useUnreadStore((s) => s.count)
  useEffect(() => {
    if (useUnreadStore.getState().side !== side) useUnreadStore.setState({ side, count: 0 })
    watchers += 1
    void refreshUnread()
    if (timer === null) {
      timer = window.setInterval(() => {
        // Скрытая вкладка — не опрашиваем: значок всё равно никто не видит.
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        void refreshUnread()
      }, POLL_MS)
    }
    return () => {
      watchers -= 1
      if (watchers === 0 && timer !== null) { window.clearInterval(timer); timer = null }
    }
  }, [side])
  return count
}
