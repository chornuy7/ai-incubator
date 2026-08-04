import { useState, useEffect } from 'react'
import { X, ChevronLeft, ChevronRight, ZoomIn } from 'lucide-react'
import { MODULE_FEATURES } from './catalog'

/**
 * §11.6: «картинка модуля» на его странице — теперь ГАЛЕРЕЯ из нескольких экранов.
 *
 * Со звонка 29.07: «у каждого модуля должна быть картинка — никому не упало читать
 * энциклопедию, все хотят смотреть глазками. Берёшь скриншот, к каждому даёшь подпись».
 *
 * Один скриншот на модуль мал и не объясняет — поэтому здесь можно дать НЕСКОЛЬКО
 * экранов, у каждого своя подпись «что это». Пути кладём в `MODULE_SHOTS[key]` списком
 * (`<key>-1.png`, `<key>-2.png`…), подписи — в `SHOT_CAPTIONS[key]` по порядку; если
 * подписи нет, берём возможность модуля (они уже написаны языком выгоды). Пока реальных
 * скриншотов нет — показываем аккуратный макет окна с пронумерованными выносками.
 */
export const MODULE_SHOTS: Record<string, string[]> = {
  // Реальные экраны модулей. Чтобы показать НЕСКОЛЬКО — добавьте файлы `<key>-2.png` и т.д.
  'neuro-commenting': ['/shots/neuro-commenting.png'],
  'neuro-chatting': ['/shots/neuro-chatting.png'],
  'neuro-dialogs': ['/shots/neuro-dialogs.png'],
  'mass-react': ['/shots/mass-react.png'],
  'mass-looking': ['/shots/mass-looking.png'],
  warming: ['/shots/warming.png'],
  parsing: ['/shots/parsing.png'],
  autoposting: ['/shots/autoposting.png'],
  ggr: ['/shots/ggr.png'],
}

/** Подписи к скриншотам по порядку (что показывает экран). Нет — возьмём из возможностей. */
const SHOT_CAPTIONS: Record<string, string[]> = {
  'neuro-commenting': ['Настройка агента и целей комментинга'],
  'neuro-chatting': ['Диалог в группе: контекст и ответ по цели'],
  'neuro-dialogs': ['ЛС-автоответчик: ведёт заявку к цели'],
  'mass-react': ['Реакции на посты в каналах и группах'],
  'mass-looking': ['Массовый просмотр Stories и постов'],
  warming: ['Прогрев: имитация живого поведения'],
  parsing: ['Парсер каналов/групп/пользователей'],
  autoposting: ['Планировщик автопостинга по расписанию'],
  ggr: ['AIR — ИИ-оценка живости аккаунтов'],
}

/** Подписи-выноски: берём возможности модуля — они уже написаны языком выгоды. */
function callouts(moduleKey: string): string[] {
  return (MODULE_FEATURES[moduleKey] || []).slice(0, 4)
}

/** Подпись к i-му скриншоту: явная → иначе i-я возможность → иначе общий текст. */
function captionFor(moduleKey: string, i: number, title: string): string {
  return SHOT_CAPTIONS[moduleKey]?.[i]
    || (MODULE_FEATURES[moduleKey] || [])[i]
    || `Рабочий экран модуля «${title}»`
}

export function ModuleShowcase({ moduleKey, title }: { moduleKey: string; title: string }) {
  const points = callouts(moduleKey)
  const shots = MODULE_SHOTS[moduleKey] || []
  const hasShots = shots.length > 0

  const [active, setActive] = useState(0) // выбранный экран в галерее
  const [zoom, setZoom] = useState(false) // лайтбокс
  const clampedActive = Math.min(active, Math.max(0, shots.length - 1))

  // Стрелки/Escape в лайтбоксе: листать и закрывать.
  useEffect(() => {
    if (!zoom) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoom(false)
      if (e.key === 'ArrowRight') setActive((i) => (i + 1) % shots.length)
      if (e.key === 'ArrowLeft') setActive((i) => (i - 1 + shots.length) % shots.length)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [zoom, shots.length])

  if (!points.length && !hasShots) return null

  const caption = hasShots ? captionFor(moduleKey, clampedActive, title) : ''

  return (
    <div className="mt-4 rounded-2xl border border-line bg-card p-5">
      <div className="mb-1 flex items-center justify-between">
        <div className="text-sm font-semibold text-fg">Как это выглядит внутри</div>
        {shots.length > 1 && (
          <div className="text-[11px] font-medium text-muted">{clampedActive + 1} / {shots.length}</div>
        )}
      </div>
      <p className="mb-4 text-xs text-muted">
        {hasShots
          ? 'Реальные экраны модуля. Нажмите на картинку, чтобы увеличить.'
          : `Экран модуля «${title}». Цифры на макете — блоки, которыми вы управляете.`}
      </p>

      <div className="grid gap-5 md:grid-cols-[1.15fr_1fr]">
        {/* Окно модуля: галерея реальных скриншотов ИЛИ макет с блоками. */}
        <div>
          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
              <span className="h-2 w-2 rounded-full bg-red-400/70" />
              <span className="h-2 w-2 rounded-full bg-amber-400/70" />
              <span className="h-2 w-2 rounded-full bg-spark-400/70" />
              <span className="ml-2 truncate text-[11px] text-muted">{title}{caption ? ` — ${caption}` : ''}</span>
            </div>

            {hasShots ? (
              <div className="relative">
                <button type="button" onClick={() => setZoom(true)} className="group relative block w-full cursor-zoom-in" title="Нажмите, чтобы увеличить">
                  <img src={shots[clampedActive]} alt={`${title}: ${caption}`} className="w-full" loading="lazy" />
                  <span className="pointer-events-none absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-md bg-black/60 px-2 py-1 text-[10px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
                    <ZoomIn size={11} /> Увеличить
                  </span>
                </button>
                {/* Стрелки листания — только если экранов больше одного. */}
                {shots.length > 1 && (
                  <>
                    <button type="button" aria-label="Предыдущий экран"
                      onClick={() => setActive((i) => (i - 1 + shots.length) % shots.length)}
                      className="absolute left-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/70">
                      <ChevronLeft size={17} />
                    </button>
                    <button type="button" aria-label="Следующий экран"
                      onClick={() => setActive((i) => (i + 1) % shots.length)}
                      className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/70">
                      <ChevronRight size={17} />
                    </button>
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-2 p-3">
                {points.map((_, i) => (
                  <div key={i} className="flex items-center gap-2.5 rounded-lg border border-line bg-card px-3 py-2.5">
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-spark-500/15 text-[11px] font-bold text-spark-300">
                      {i + 1}
                    </span>
                    {/* Полоски — намеренно нейтральный «скелет»: не врёт про цифры, роль блока объясняет подпись справа. */}
                    <span className="h-2 flex-1 rounded-full bg-white/8" />
                    <span className="h-2 w-10 shrink-0 rounded-full bg-spark-500/25" />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Лента миниатюр — быстрый переход между экранами. */}
          {shots.length > 1 && (
            <div className="mt-2.5 flex gap-2 overflow-x-auto pb-1">
              {shots.map((s, i) => (
                <button key={s} type="button" onClick={() => setActive(i)}
                  className={`h-14 w-20 shrink-0 overflow-hidden rounded-lg border transition-colors ${i === clampedActive ? 'border-spark-400 ring-1 ring-spark-400/40' : 'border-line opacity-70 hover:opacity-100'}`}
                  title={captionFor(moduleKey, i, title)}>
                  <img src={s} alt="" className="h-full w-full object-cover" loading="lazy" />
                </button>
              ))}
            </div>
          )}
          {/* Подпись активного экрана — «что это». */}
          {caption && <p className="mt-2 text-xs leading-snug text-muted">{caption}</p>}
        </div>

        {/* Выноски: номер ↔ возможность модуля. */}
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

      {/* Лайтбокс: экран на весь экран, со стрелками и счётчиком. */}
      {zoom && hasShots && (
        <div
          onClick={() => setZoom(false)}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
        >
          <button type="button" onClick={() => setZoom(false)}
            className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-xl bg-white/10 text-white transition-colors hover:bg-white/20"
            aria-label="Закрыть">
            <X size={18} />
          </button>

          {shots.length > 1 && (
            <>
              <button type="button" aria-label="Предыдущий"
                onClick={(e) => { e.stopPropagation(); setActive((i) => (i - 1 + shots.length) % shots.length) }}
                className="absolute left-4 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-xl bg-white/10 text-white transition-colors hover:bg-white/20">
                <ChevronLeft size={22} />
              </button>
              <button type="button" aria-label="Следующий"
                onClick={(e) => { e.stopPropagation(); setActive((i) => (i + 1) % shots.length) }}
                className="absolute right-4 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-xl bg-white/10 text-white transition-colors hover:bg-white/20">
                <ChevronRight size={22} />
              </button>
            </>
          )}

          <figure onClick={(e) => e.stopPropagation()} className="flex max-h-[92vh] max-w-[95vw] flex-col items-center gap-3">
            <img src={shots[clampedActive]} alt={`${title}: ${caption}`}
              className="max-h-[82vh] max-w-full cursor-default rounded-xl border border-white/10 object-contain shadow-2xl" />
            <figcaption className="text-center text-sm text-white/80">
              {caption}{shots.length > 1 ? ` · ${clampedActive + 1} / ${shots.length}` : ''}
            </figcaption>
          </figure>
        </div>
      )}
    </div>
  )
}
