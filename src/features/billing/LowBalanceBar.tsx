import { AlertTriangle } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useBalance } from '@/features/billing/balanceStore'
import { useUi } from '@/shared/lib/uiStore'
import { useSession } from '@/features/auth/session'
import { expiryInfo } from '@/features/billing/expiry'
import { coins as fmtCoins } from '@/shared/lib/utils'

/**
 * §10.1: постоянная лента-предупреждение в самом верху.
 *
 * Правило из созвона 27.07: тонкая полоса на всю ширину, «осталось мало — не хватит
 * закрыть задачу», клик → биллинг. ЗАКРЫТЬ НЕЛЬЗЯ никогда — цель пушить клиента платить.
 * Поэтому у ленты нет крестика, а не «забыли добавить».
 *
 * Правка 21.08. Лента знала одну беду — деньги, и человеку без подписки писала «баланс
 * на нуле», хотя пополнение ему ничего не даст: модули не подключены, и запускать нечего.
 * Бед три, и они лечатся РАЗНЫМ действием, поэтому и ведут в разные места:
 *   нет подписки        → купить подписку   (страница «Подписки»)
 *   подписка кончилась  → продлить её       (туда же)
 *   подписка есть, а токенов нет → пополнить (окно пополнения)
 * Порядок именно такой: пока модуля нет, разговор про токены преждевременный.
 *
 * Порог — абсолютный (монеты), пока курс токен→доллар не задан (§10.1 ждёт числа
 * от Николая): точную «$2 не хватит» посчитать нечем.
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
  const isAdmin = !!useSession((s) => s.user?.isAdmin)
  const navigate = useNavigate()

  if (!balance) return null
  // Админу платформы лента не адресована: подписки у него нет по определению, и
  // «купите подписку» в админ-панели — просто мусор на экране.
  if (isAdmin) return null

  const coins = balance.coins
  const modules = balance.modules
  // 'all' — набор не выбирали (демо/общее пространство), это не «нет подписки».
  const noSub = Array.isArray(modules) && modules.length === 0
  const exp = expiryInfo(balance.expiresAt)
  // Модули есть, но срок вышел — подписка была и закончилась.
  const expired = !noSub && exp.expired

  // Ничего не сломано: подписка на месте, токенов достаточно.
  if (!noSub && !expired && (coins === undefined || coins > LOW)) return null

  const subProblem = noSub || expired
  const critical = subProblem || coins <= CRITICAL
  const empty = coins <= 0

  const text = noSub
    ? 'У вас нет подписки — модули не подключены. Купите подписку →'
    : expired
      ? `У вас закончилась подписка${exp.date ? ` (${exp.date})` : ''} — модули не запускаются. Продлите подписку →`
      : empty
        ? 'Баланс на нуле — боевые модули остановлены. Пополнить →'
        : coins <= CRITICAL
          ? `Баланс почти на нуле: ${fmtCoins(coins)} ⚡ — задачи не запустятся. Пополнить →`
          : `Осталось ${fmtCoins(coins)} ⚡ — скоро не хватит закрыть задачу. Пополнить →`

  return (
    <button
      onClick={() => (subProblem ? navigate('/panel/user/subscription') : setCoinsOpen(true))}
      className={
        'flex h-9 w-full shrink-0 items-center justify-center gap-2 px-4 text-xs font-semibold transition-colors ' +
        (critical
          ? 'bg-red-500/90 text-white hover:bg-red-500'
          : 'bg-amber-500/90 text-[#1a1205] hover:bg-amber-500')
      }
      title={subProblem ? 'Открыть «Подписки»' : 'Пополнить баланс'}
    >
      <AlertTriangle size={14} />
      {text}
    </button>
  )
}
