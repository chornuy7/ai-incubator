import { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import { MODULE_FEATURES } from './catalog'

/**
 * §11.6: «картинка модуля» на его странице.
 *
 * Со звонка 29.07: «у каждого модуля должна быть картинка модуля — никому не упало
 * читать энциклопедию, все хотят смотреть глазками. Берёшь скриншот, разбиваешь на
 * куски и к каждому даёшь подпись: вот блок автоматизации, вот блок комментинга».
 *
 * Пока реальных скриншотов нет, показываем макет окна модуля с ПРОНУМЕРОВАННЫМИ
 * выносками — структура и подписи уже те, что нужны для продажи. Когда скриншоты
 * появятся, достаточно положить путь в `MODULE_SHOTS[key]`: макет заменится картинкой,
 * выноски и подписи останутся на месте.
 */
export const MODULE_SHOTS: Record<string, string> = {
  // Реальные скриншоты рабочих экранов (обрезаны: без сайдбара, шапки и ростера аккаунтов).
  'neuro-commenting': '/shots/neuro-commenting.png',
  'neuro-chatting': '/shots/neuro-chatting.png',
  'neuro-dialogs': '/shots/neuro-dialogs.png',
  'mass-react': '/shots/mass-react.png',
  'mass-looking': '/shots/mass-looking.png',
  warming: '/shots/warming.png',
  parsing: '/shots/parsing.png',
  autoposting: '/shots/autoposting.png',
  ggr: '/shots/ggr.png',
}

/** Подписи-выноски: берём возможности модуля — они уже написаны языком выгоды. */
function callouts(moduleKey: string): string[] {
  return (MODULE_FEATURES[moduleKey] || []).slice(0, 4)
}

export function ModuleShowcase({ moduleKey, title }: { moduleKey: string; title: string }) {
  const points = callouts(moduleKey)
  const shot = MODULE_SHOTS[moduleKey]
  // §11.6: клик по скриншоту раскрывает его на весь экран — в маленьком окне детали не читаются.
  const [zoom, setZoom] = useState(false)
  useEffect(() => {
    if (!zoom) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoom(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [zoom])
  if (!points.length) return null

  return (
    <div className="mt-4 rounded-2xl border border-line bg-card p-5">
      <div className="mb-1 text-sm font-semibold text-fg">Как это выглядит внутри</div>
      <p className="mb-4 text-xs text-muted">
        Экран модуля «{title}». Цифры на макете — блоки, которыми вы управляете.
      </p>

      <div className="grid gap-5 md:grid-cols-[1.15fr_1fr]">
        {/* Окно модуля: либо реальный скриншот, либо макет с блоками. */}
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
            <span className="h-2 w-2 rounded-full bg-red-400/70" />
            <span className="h-2 w-2 rounded-full bg-amber-400/70" />
            <span className="h-2 w-2 rounded-full bg-spark-400/70" />
            <span className="ml-2 text-[11px] text-muted">{title}</span>
          </div>

          {shot ? (
            <button type="button" onClick={() => setZoom(true)} className="group relative block w-full cursor-zoom-in" title="Нажмите, чтобы увеличить">
              <img src={shot} alt={`Экран модуля «${title}»`} className="w-full" loading="lazy" />
              <span className="pointer-events-none absolute bottom-2 right-2 rounded-md bg-black/60 px-2 py-1 text-[10px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">Нажмите, чтобы увеличить</span>
            </button>
          ) : (
            <div className="space-y-2 p-3">
              {points.map((_, i) => (
                <div key={i} className="flex items-center gap-2.5 rounded-lg border border-line bg-card px-3 py-2.5">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-spark-500/15 text-[11px] font-bold text-spark-300">
                    {i + 1}
                  </span>
                  {/* Полоски — намеренно нейтральный «скелет» интерфейса: он не врёт
                      про конкретные цифры, а роль блока объясняет подпись справа. */}
                  <span className="h-2 flex-1 rounded-full bg-white/8" />
                  <span className="h-2 w-10 shrink-0 rounded-full bg-spark-500/25" />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Выноски: номер ↔ блок на макете. */}
        <ul className="space-y-2.5">
          {points.map((p, i) => (
            <li key={p} className="flex gap-2.5">
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-spark-500/15 text-[11px] font-bold text-spark-300">
                {i + 1}
              </span>
              <span className="text-sm leading-snug text-muted">{p}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Лайтбокс: скриншот на весь экран. Клик по фону или ✕ / Escape — закрыть. */}
      {zoom && shot && (
        <div
          onClick={() => setZoom(false)}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            onClick={() => setZoom(false)}
            className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-xl bg-white/10 text-white transition-colors hover:bg-white/20"
            aria-label="Закрыть"
          >
            <X size={18} />
          </button>
          <img
            src={shot}
            alt={`Экран модуля «${title}»`}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[92vh] max-w-[95vw] cursor-default rounded-xl border border-white/10 object-contain shadow-2xl"
          />
        </div>
      )}
    </div>
  )
}
