import { useState, useEffect } from 'react'
import { X, ChevronLeft, ChevronRight, ZoomIn } from 'lucide-react'
import { MODULE_FEATURES } from './catalog'
import { ModuleMockScreen } from './ModuleMockScreen'

/**
 * §11.6: «как это выглядит внутри» — витрина экранов модуля.
 *
 * Со звонка 29.07: «у каждого модуля должна быть картинка — все хотят смотреть глазками».
 * Показываем НЕСКОЛЬКО экранов, у каждого подпись «что это»:
 *   • если положить реальные скриншоты в `MODULE_SHOTS[key]` (список `<key>-1.png`…) —
 *     это галерея картинок с зумом;
 *   • если скриншотов нет — рендерим экран модуля В КОДЕ (ModuleMockScreen): чётко при
 *     любом масштабе, два вида — «Настройка» и «Результаты». Картинки-файлы не нужны.
 * Справа — пронумерованные выноски (возможности модуля).
 */
export const MODULE_SHOTS: Record<string, string[]> = {
  // Реальные скриншоты (по желанию). Несколько экранов — добавьте `<key>-2.png` и т.д.
  // Пусто = показываем рендер экрана в коде (ModuleMockScreen).
}

/** Подписи-выноски: берём возможности модуля — они уже написаны языком выгоды. */
function callouts(moduleKey: string): string[] {
  const base = moduleKey.startsWith('parsing') ? 'parsing' : moduleKey
  return (MODULE_FEATURES[moduleKey] || MODULE_FEATURES[base] || []).slice(0, 4)
}

type View =
  | { type: 'img'; src: string; caption: string }
  | { type: 'mock'; kind: 'setup' | 'results'; caption: string }

export function ModuleShowcase({ moduleKey, title }: { moduleKey: string; title: string }) {
  const points = callouts(moduleKey)
  const shots = MODULE_SHOTS[moduleKey] || []

  // Единая модель «видов»: реальные скрины ИЛИ два рендер-экрана.
  const views: View[] = shots.length
    ? shots.map((src, i) => ({ type: 'img', src, caption: i === 0 ? 'Рабочий экран модуля' : `Экран ${i + 1}` }))
    : [
        { type: 'mock', kind: 'setup', caption: 'Настройка: цель, возможности, лимиты' },
        { type: 'mock', kind: 'results', caption: 'Результаты: лента действий и сводка за день' },
      ]

  const [active, setActive] = useState(0)
  const [zoom, setZoom] = useState(false)
  const clamped = Math.min(active, views.length - 1)
  const view = views[clamped]
  const isImg = view.type === 'img'

  useEffect(() => {
    if (!zoom) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoom(false)
      if (e.key === 'ArrowRight') setActive((i) => (i + 1) % views.length)
      if (e.key === 'ArrowLeft') setActive((i) => (i - 1 + views.length) % views.length)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [zoom, views.length])

  if (!points.length && !views.length) return null

  return (
    <div className="mt-4 rounded-2xl border border-line bg-card p-5">
      <div className="mb-1 flex items-center justify-between">
        <div className="text-sm font-semibold text-fg">Как это выглядит внутри</div>
        {views.length > 1 && <div className="text-[11px] font-medium text-muted">{clamped + 1} / {views.length}</div>}
      </div>
      <p className="mb-4 text-xs text-muted">
        Экран модуля «{title}». {isImg ? 'Нажмите на картинку, чтобы увеличить.' : 'Цифры — блоки, которыми вы управляете.'}
      </p>

      <div className="grid gap-5 md:grid-cols-[1.15fr_1fr]">
        <div>
          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
              <span className="h-2 w-2 rounded-full bg-red-400/70" />
              <span className="h-2 w-2 rounded-full bg-amber-400/70" />
              <span className="h-2 w-2 rounded-full bg-spark-400/70" />
              <span className="ml-2 truncate text-[11px] text-muted">{title} — {view.caption}</span>
            </div>

            <div className="relative">
              {isImg ? (
                <button type="button" onClick={() => setZoom(true)} className="group relative block w-full cursor-zoom-in" title="Нажмите, чтобы увеличить">
                  <img src={view.src} alt={`${title}: ${view.caption}`} className="w-full" loading="lazy" />
                  <span className="pointer-events-none absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-md bg-black/60 px-2 py-1 text-[10px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
                    <ZoomIn size={11} /> Увеличить
                  </span>
                </button>
              ) : (
                <ModuleMockScreen moduleKey={moduleKey} kind={view.kind} />
              )}

              {views.length > 1 && (
                <>
                  <button type="button" aria-label="Предыдущий экран"
                    onClick={() => setActive((i) => (i - 1 + views.length) % views.length)}
                    className="absolute left-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/70">
                    <ChevronLeft size={17} />
                  </button>
                  <button type="button" aria-label="Следующий экран"
                    onClick={() => setActive((i) => (i + 1) % views.length)}
                    className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/70">
                    <ChevronRight size={17} />
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Переключатель видов — миниатюры (картинки) или табы (рендер-экраны). */}
          {views.length > 1 && (
            <div className="mt-2.5 flex gap-2">
              {views.map((v, i) => (
                <button key={i} type="button" onClick={() => setActive(i)}
                  className={`shrink-0 overflow-hidden rounded-lg border text-[11px] transition-colors ${i === clamped ? 'border-spark-400 text-spark-200 ring-1 ring-spark-400/40' : 'border-line text-muted opacity-80 hover:opacity-100'} ${v.type === 'img' ? 'h-14 w-20' : 'px-3 py-1.5'}`}>
                  {v.type === 'img' ? <img src={v.src} alt="" className="h-full w-full object-cover" loading="lazy" /> : (v.kind === 'setup' ? 'Настройка' : 'Результаты')}
                </button>
              ))}
            </div>
          )}
          <p className="mt-2 text-xs leading-snug text-muted">{view.caption}</p>
        </div>

        {/* Выноски: номер ↔ возможность модуля. */}
        <ul className="space-y-2.5">
          {points.map((p, i) => (
            <li key={p} className="flex gap-2.5">
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-spark-500/15 text-[11px] font-bold text-spark-300">{i + 1}</span>
              <span className="text-sm leading-snug text-muted">{p}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Лайтбокс — только для реальных картинок. */}
      {zoom && isImg && (
        <div onClick={() => setZoom(false)} className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
          <button type="button" onClick={() => setZoom(false)} className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-xl bg-white/10 text-white transition-colors hover:bg-white/20" aria-label="Закрыть">
            <X size={18} />
          </button>
          {views.length > 1 && (
            <>
              <button type="button" aria-label="Предыдущий" onClick={(e) => { e.stopPropagation(); setActive((i) => (i - 1 + views.length) % views.length) }} className="absolute left-4 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-xl bg-white/10 text-white transition-colors hover:bg-white/20">
                <ChevronLeft size={22} />
              </button>
              <button type="button" aria-label="Следующий" onClick={(e) => { e.stopPropagation(); setActive((i) => (i + 1) % views.length) }} className="absolute right-4 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-xl bg-white/10 text-white transition-colors hover:bg-white/20">
                <ChevronRight size={22} />
              </button>
            </>
          )}
          <figure onClick={(e) => e.stopPropagation()} className="flex max-h-[92vh] max-w-[95vw] flex-col items-center gap-3">
            {view.type === 'img' && <img src={view.src} alt={`${title}: ${view.caption}`} className="max-h-[82vh] max-w-full rounded-xl border border-white/10 object-contain shadow-2xl" />}
            <figcaption className="text-center text-sm text-white/80">{view.caption}{views.length > 1 ? ` · ${clamped + 1} / ${views.length}` : ''}</figcaption>
          </figure>
        </div>
      )}
    </div>
  )
}
