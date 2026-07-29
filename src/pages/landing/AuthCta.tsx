import { useNavigate } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { Avatar } from '@/shared/ui'
import { useSession } from '@/features/auth/session'

/**
 * §11.7: кнопка входа в шапке лендинга.
 *
 * Правило со звонка 29.07: если человек УЖЕ авторизован, «Войти» сбивает с толку —
 * читается как «ты ещё не вошёл». Поэтому залогиненному показываем аватар + имя и
 * зовём кнопку «Кабинет»; гостю — обычное «Войти».
 */
export function AuthCta({ className = '' }: { className?: string }) {
  const nav = useNavigate()
  const user = useSession((s) => s.user)

  if (!user) {
    return (
      <button onClick={() => nav('/login')} className={`btn-primary h-9 px-4 text-sm ${className}`}>
        Войти <ArrowRight size={15} />
      </button>
    )
  }

  const label = user.name?.trim() || user.email
  return (
    <button
      onClick={() => nav('/panel')}
      title={`Вы вошли как ${label}`}
      className={`flex h-9 items-center gap-2 rounded-xl border border-line bg-elevated/60 pl-1 pr-3 text-sm transition-colors hover:border-spark-500/40 ${className}`}
    >
      <Avatar name={label} color="var(--spark-500, #22c55e)" size={26} />
      <span className="max-w-[130px] truncate font-semibold text-fg">{label}</span>
      <span className="text-xs font-semibold text-spark-300">Кабинет</span>
    </button>
  )
}
