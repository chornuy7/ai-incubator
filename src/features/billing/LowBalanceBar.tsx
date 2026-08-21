import { AlertTriangle } from 'lucide-react'
import { useBalance } from '@/features/billing/balanceStore'
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
// §11.5: экспортируем — шапка красит чип баланса по тем же порогам, чтобы лента и
// чип не расходились в оценке «всё плохо».
export const LOW = 5 // ⚡ — мало
export const CRITICAL = 0.5 // ⚡ — почти ноль

export function LowBalanceBar() {
  // MR-151: тот же источник, что у шапки. Раньше лента заводила СВОЙ поллер на 30 c —
  // получался второй запрос `/api/balance` тик в тик с шапкой, а из-за разного порядка
  // ответов чип и лента успевали показывать разные суммы. Теперь цифра одна на всех.
  const balance = useBalance()
  const setCoinsOpen = useUi((s) => s.setCoinsOpen)

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
