import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { fetchBalance, type Balance } from '@/api/balanceApi'
import { useUi } from '@/shared/lib/uiStore'
import { coins as fmtCoins } from '@/shared/lib/utils'

/**
 * §10.1: постоянная лента-предупреждение о низком балансе.
 *
 * Правило из созвона 27.07: тонкая полоса на всю ширину в самом верху, «осталось
 * мало — не хватит закрыть задачу», клик → биллинг. ЗАКРЫТЬ НЕЛЬЗЯ никогда — цель
 * пушить клиента платить. Поэтому у ленты нет крестика, а не «забыли добавить».
 *
 * Порог — абсолютный (монеты), пока курс токен→доллар не задан (§10.1 ждёт числа
 * от Николая): точную «$2 не хватит» посчитать нечем. Когда курс появится, сюда
 * встанет расчёт «хватит ли на типичную задачу».
 */
const LOW = 5 // ⚡ — мало
const CRITICAL = 0.5 // ⚡ — почти ноль

export function LowBalanceBar() {
  const [balance, setBalance] = useState<Balance | null>(null)
  const setCoinsOpen = useUi((s) => s.setCoinsOpen)

  useEffect(() => {
    const load = () => { void fetchBalance().then(setBalance).catch(() => {}) }
    load()
    // Тот же тик, что у шапки: баланс меняется от списаний, лента не должна отставать.
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [])

  const coins = balance?.coins
  if (coins === undefined || coins > LOW) return null

  // Три состояния: ноль (модули УЖЕ стоят), почти ноль (не запустятся), мало (скоро не хватит).
  // При 0.00 «почти на нуле» противоречит цифре — деньги не «почти», а закончились.
  const empty = coins <= 0
  const critical = coins <= CRITICAL
  return (
    <button
      onClick={() => setCoinsOpen(true)}
      className={
        'flex h-9 w-full shrink-0 items-center justify-center gap-2 px-4 text-xs font-semibold transition-colors ' +
        (critical
          ? 'bg-red-500/90 text-white hover:bg-red-500'
          : 'bg-amber-500/90 text-[#1a1205] hover:bg-amber-500')
      }
      title="Пополнить баланс"
    >
      <AlertTriangle size={14} />
      {empty
        ? 'Баланс на нуле — боевые модули остановлены. Пополнить →'
        : critical
          ? `Баланс почти на нуле: ${fmtCoins(coins)} ⚡ — задачи не запустятся. Пополнить →`
          : `Осталось ${fmtCoins(coins)} ⚡ — скоро не хватит закрыть задачу. Пополнить →`}
    </button>
  )
}
