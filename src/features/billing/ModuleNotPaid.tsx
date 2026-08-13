import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Package, Check, Eye } from 'lucide-react'
import { fetchPricing } from '@/api/balanceApi'
import { moduleTagline, MODULE_FEATURES } from '@/pages/landing/catalog'

/**
 * Экран «модуль не оплачен» = панель «купить доступ» (MR-157). Отдельный от «нет доступа
 * роли»: причина другая и путь другой — не к администратору, а в кабинет подписки.
 * Держим одним компонентом: модулей три вида страниц (ModuleRunner, мейлинг, автопостинг),
 * расходящиеся формулировки читались бы как разные проблемы.
 *
 * moduleKey (если передан) включает цену, «Превью» с фичами и прямую оплату этого модуля.
 */
export function ModuleNotPaid({ title, moduleKey }: { title: string; moduleKey?: string }) {
  const [price, setPrice] = useState<number | null>(null)
  const [preview, setPreview] = useState(false)

  useEffect(() => {
    if (!moduleKey) return
    void fetchPricing().then((p) => {
      const it = p.items.find((i) => i.key === moduleKey)
      // MR-150: цену показываем целой (CEIL).
      if (it) setPrice(Math.ceil(it.price))
    }).catch(() => {})
  }, [moduleKey])

  const tagline = moduleKey ? moduleTagline(moduleKey) : ''
  const features = moduleKey ? (MODULE_FEATURES[moduleKey] || []) : []
  // ?apply=<key> — страница подписки предвыбирает этот модуль поверх текущего набора.
  const applyHref = moduleKey ? `/panel/user/subscription?apply=${moduleKey}` : '/panel/user/subscription'

  return (
    <div className="mx-auto mt-16 max-w-md rounded-2xl border border-line bg-elevated p-8 text-center">
      <Package size={28} className="mx-auto text-amber-300/70" />
      <div className="mt-3 text-base font-semibold text-fg">«{title}» — платный модуль</div>
      <div className="mt-1 text-sm text-muted">{tagline || 'Модуль не в вашей подписке — платите только за то, чем пользуетесь.'}</div>

      {price != null && (
        <div className="mt-4 flex items-baseline justify-center gap-1.5">
          <span className="font-display text-3xl font-bold text-fg">{price} $</span>
          <span className="text-sm text-muted">/ мес</span>
        </div>
      )}

      {preview && features.length > 0 && (
        <ul className="mt-4 space-y-1.5 rounded-xl border border-line bg-surface/40 p-3 text-left">
          {features.map((f) => (
            <li key={f} className="flex items-start gap-2 text-sm text-muted"><Check size={15} className="mt-0.5 shrink-0 text-spark-400" /> {f}</li>
          ))}
        </ul>
      )}

      <div className="mt-5 flex flex-col gap-2">
        <Link to={applyHref} className="btn-primary inline-flex h-10 items-center justify-center">
          {price != null ? `Оплатить за месяц · ${price} $` : 'Оплатить доступ'}
        </Link>
        <div className="flex gap-2">
          {features.length > 0 && (
            <button onClick={() => setPreview((v) => !v)} className="btn-ghost inline-flex h-9 flex-1 items-center justify-center gap-1.5 border border-line">
              <Eye size={14} /> {preview ? 'Скрыть превью' : 'Превью'}
            </button>
          )}
          <Link to="/panel/user/subscription" className="btn-ghost inline-flex h-9 flex-1 items-center justify-center border border-line">Все подписки</Link>
        </div>
      </div>
    </div>
  )
}
