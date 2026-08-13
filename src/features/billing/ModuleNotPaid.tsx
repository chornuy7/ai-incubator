import { Link } from 'react-router-dom'
import { Package } from 'lucide-react'

/**
 * Экран «модуль не оплачен». Отдельный от «нет доступа роли»: причина другая и путь
 * другой — не к администратору, а в кабинет подписки. Держим одним компонентом,
 * потому что модулей три вида страниц (ModuleRunner, мейлинг, автопостинг), и
 * расходящиеся формулировки читались бы как разные проблемы.
 */
export function ModuleNotPaid({ title }: { title: string }) {
  return (
    <div className="mx-auto mt-16 max-w-md rounded-2xl border border-line bg-elevated p-8 text-center">
      <Package size={28} className="mx-auto text-amber-300/70" />
      <div className="mt-3 text-base font-semibold text-fg">Модуль не в вашей подписке</div>
      <div className="mt-1 text-sm text-muted">
        «{title}» не оплачен. Добавьте его в разделе «Подписки» — платите только за то, чем пользуетесь.
      </div>
      <Link to="/panel/user/subscription" className="btn-primary mt-5 inline-flex h-10">Подписки</Link>
    </div>
  )
}
