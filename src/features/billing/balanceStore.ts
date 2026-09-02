import { useEffect } from 'react'
import { create } from 'zustand'
import { fetchBalance, type Balance } from '@/api/balanceApi'
import { onLive, liveConnected } from '@/shared/lib/liveSocket'

/**
 * MR-151: ОДИН источник баланса на всё приложение.
 *
 * Было три независимых потребителя одного и того же `/api/balance`, и каждый завёл
 * себе поллер на 30 секунд: чип в шапке (AppHeader), лента низкого баланса
 * (LowBalanceBar) и стор подписки (`plan.load`, которого шапка дёргает своим вторым
 * таймером). На любой странице панели это три одинаковых запроса каждые полминуты —
 * при том, что цифра в них одна. Хуже дубля был расход: ответы приходили в разном
 * порядке, и чип с лентой успевали показывать разные суммы.
 *
 * Лечим не выкидыванием поллинга (он нужен: списания идут в фоне, и цифра обязана
 * меняться без перезагрузки), а склейкой потребителей. Компонент зовёт `useBalance()`
 * и получает общее значение; таймер один на всех и живёт, пока есть хоть один
 * подписчик. Период — прежние 30 c, менять его эта правка не собиралась.
 */
const POLL_MS = 30000

interface BalanceStore {
  /** null — ещё не загружали (или первый запрос упал). */
  balance: Balance | null
  /**
   * Перечитать баланс. Дедупликация: пока летит один запрос, все вызовы получают
   * ЕГО промис, а не заводят второй. Именно это склеивает совпавшие тики разных
   * потребителей в один сетевой запрос.
   */
  refresh: () => Promise<Balance | null>
}

let inflight: Promise<Balance | null> | null = null

export const useBalanceStore = create<BalanceStore>((set) => ({
  balance: null,
  refresh: () => {
    if (inflight) return inflight
    inflight = fetchBalance()
      .then((b) => { set({ balance: b }); return b })
      // Сеть легла — оставляем прошлое значение: пустой чип пугает сильнее старой цифры.
      .catch(() => null)
      .finally(() => { inflight = null })
    return inflight
  },
}))

/** Перечитать баланс из не-React кода (после оплаты, покупки токенов и т.п.). */
export const refreshBalance = () => useBalanceStore.getState().refresh()

/**
 * Положить свежий баланс, который сервер уже вернул в ответе (покупка токенов,
 * оплата подписки). Лишний GET за тем, что только что пришло, не нужен, а цифра
 * не должна ждать следующего тика.
 */
export const setBalance = (b: Balance) => useBalanceStore.setState({ balance: b })

// Таймер общий: считаем подписчиков, а не заводим интервал на каждый компонент.
let timer: number | null = null
let watchers = 0

/**
 * Баланс + участие в общем поллинге. Возвращает то же значение всем, кто позвал.
 * Пока подписчиков нет, таймер остановлен — фоновых запросов на страницах без
 * баланса (лендинг, логин) не остаётся.
 */
export function useBalance(): Balance | null {
  const balance = useBalanceStore((s) => s.balance)
  useEffect(() => {
    watchers += 1
    void useBalanceStore.getState().refresh()

    /*
     * Кошелёк меняется РЕДКО и всегда по действию, о котором сервер знает: списание за
     * работу модуля, пополнение, покупка. Значит и перечитывать его надо по событию, а не
     * по таймеру. Опрос в шапке был одним из двух десятков запросов, которыми страница
     * открывалась, и почти всегда возвращал ту же цифру.
     */
    const off = onLive('balance', () => { void useBalanceStore.getState().refresh() })

    /*
     * Таймер остаётся ЗАПАСНЫМ и редким: канал может быть не поднят (старая версия
     * сервера), оборваться на спящем ноутбуке или не пройти через чужой прокси. Пока он
     * жив — не ходим вовсе.
     */
    if (timer === null) {
      timer = window.setInterval(() => {
        // Канал жив И значение уже есть — спрашивать нечего: об изменении скажет сервер.
        // Значения нет — первая загрузка не удалась, и вытащить нас может только опрос.
        if (liveConnected() && useBalanceStore.getState().balance) return
        void useBalanceStore.getState().refresh()
      }, POLL_MS)
    }
    return () => {
      off()
      watchers -= 1
      if (watchers === 0 && timer !== null) { window.clearInterval(timer); timer = null }
    }
  }, [])
  return balance
}
