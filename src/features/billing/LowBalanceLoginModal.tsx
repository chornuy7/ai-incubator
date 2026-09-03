import { useEffect, useState } from 'react'
import { Zap } from 'lucide-react'
import { Modal } from '@/shared/ui'
import { refreshBalance } from '@/features/billing/balanceStore'
import { useSession } from '@/features/auth/session'
import { useUi } from '@/shared/lib/uiStore'
import { coins as fmtCoins } from '@/shared/lib/utils'

/**
 * §10.1: модалка «баланс кончается» на каждом входе.
 *
 * Правило созвона 27.07: показывать при каждом логине, закрыл — пользуешься. Для
 * АДМИНОВ уже сейчас — чекбокс «не показывать снова» (обычным юзерам его не даём:
 * им лента и модалка должны пушить платить, цитата «не должно быть, что функция
 * просто отключается»).
 *
 * «Каждый вход» приравниваем к сессии вкладки: dismiss ставит sessionStorage-флаг,
 * чтобы модалка не всплывала при каждой навигации, но вернулась после нового входа.
 * Админский «не показывать» — постоянный localStorage-флаг.
 */
const SEEN = 'lowbal:seen' // на сессию вкладки
const HIDE = 'lowbal:hide' // навсегда (только админ)
const LOW = 5

export function LowBalanceLoginModal() {
  const user = useSession((s) => s.user)
  const isAdmin = !!user?.isAdmin
  const setCoinsOpen = useUi((s) => s.setCoinsOpen)
  const blocked = useUi((s) => s.accessBlocked)
  const [coins, setCoins] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  const [dontShow, setDontShow] = useState(false)

  useEffect(() => {
    // Уже сказали «не показывать» (админ) — не дёргаем даже баланс.
    if (isAdmin && localStorage.getItem(HIDE) === '1') return
    if (sessionStorage.getItem(SEEN) === '1') return
    // MR-151: общий источник — модалка открывается на входе одновременно с шапкой,
    // и раньше это был отдельный запрос за той же цифрой (дедупликация в balanceStore).
    void refreshBalance().then((b) => {
      if (!b) return
      setCoins(b.coins)
      if (b.coins <= LOW) setOpen(true)
    })
  }, [isAdmin])

  const close = () => {
    sessionStorage.setItem(SEEN, '1')
    if (isAdmin && dontShow) localStorage.setItem(HIDE, '1')
    setOpen(false)
  }

  // Доступ закрыт админом — про деньги молчим. Иначе поверх «Доступ закрыт» вставало
  // «Пополните баланс», и человек шёл платить, хотя платить не за что: ему выключили
  // доступ вручную (та же жалоба, что и в правке 21.08 про «продлите подписку»).
  if (blocked) return null
  if (!open || coins === null) return null

  // Ноль — это не «заканчивается», а «закончился»: боевые модули уже стоят. Разводим
  // формулировки, иначе при 0.00 заголовок противоречит цифре под ним.
  const empty = coins <= 0

  return (
    <Modal
      open={open}
      onClose={close}
      title={empty ? 'Баланс закончился' : 'Баланс заканчивается'}
      subtitle={empty ? 'На счету 0.00 ⚡' : `Осталось ${fmtCoins(coins)} ⚡`}
      icon={<Zap size={22} fill="currentColor" />}
      size="sm"
      footer={(
        <>
          <button onClick={close} className="btn-ghost">Понятно</button>
          {/* §11.5: «Пополнить» красным — критическое уведомление, не радостное действие. */}
          <button onClick={() => { close(); setCoinsOpen(true) }}
            className="inline-flex items-center gap-1.5 rounded-xl bg-red-500 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-red-400">
            <Zap size={16} /> Пополнить
          </button>
        </>
      )}
    >
      <p className="text-sm leading-relaxed text-muted">
        {empty
          ? 'Монеты закончились — боевые модули остановлены на нуле, прогресс сохранён. Пополните баланс, чтобы продолжить работу.'
          : 'Монет скоро не хватит, чтобы закрыть задачу — модули остановятся на нуле с сохранением прогресса. Пополните баланс, чтобы работа не прерывалась.'}
      </p>
      {isAdmin && (
        <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            checked={dontShow}
            onChange={(e) => setDontShow(e.target.checked)}
            className="h-4 w-4 rounded border-line accent-spark-500"
          />
          Не показывать снова
        </label>
      )}
    </Modal>
  )
}
