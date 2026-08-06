import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'

/**
 * Нижняя панель запуска: всегда видна, прижата ко дну рабочей области.
 *
 * Настройки модулей длинные, и до кнопки «Начать» приходилось прокручивать вниз.
 * `sticky` тут не годится: он держится только в пределах своего родителя, а блок
 * запуска заканчивается сразу под панелью — стоит проскроллить дальше, и она уезжает.
 * Поэтому `fixed`, но координаты считаем от ГЛАВНОЙ КОЛОНКИ (сестра сайдбара): левый
 * край = правый край меню, ширина = вся оставшаяся ширина экрана. Так панель идёт
 * «край в край» и не наезжает на боковое меню, которое к тому же сворачивается.
 */
export function FloatingBar({ children, className }: { children: ReactNode; className?: string }) {
  const barRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ left: number; width: number } | null>(null)
  const [barH, setBarH] = useState(0)

  useLayoutEffect(() => {
    // Главная колонка — родитель <main> (сайдбар ей сестра, поэтому её левый край
    // ровно там, где кончается меню).
    const col = () => document.querySelector('main')?.parentElement ?? null
    const measure = () => {
      const c = col()
      if (c) {
        const r = c.getBoundingClientRect()
        setBox({ left: Math.round(r.left), width: Math.round(r.width) })
      }
      if (barRef.current) setBarH(barRef.current.offsetHeight)
    }
    measure()
    window.addEventListener('resize', measure)
    // Меню сворачивается анимацией — следим за шириной колонки, а не только окна.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    const c = col()
    if (ro && c) ro.observe(c)
    return () => { window.removeEventListener('resize', measure); ro?.disconnect() }
  }, [])

  // Высота меняется от содержимого (появились шаги, вторая кнопка) — держим заглушку
  // такой же, иначе нижний блок страницы прячется под панелью.
  useEffect(() => {
    if (barRef.current) setBarH(barRef.current.offsetHeight)
  })

  return (
    <>
      <div style={{ height: barH || undefined }} />
      <div
        ref={barRef}
        style={box ? { left: box.left, width: box.width } : undefined}
        className={cn(
          // Сплошная панель у самого низа: без отступа и скругления, только верхняя
          // граница — «край в край» рабочей области (правка заказчика).
          'fixed bottom-0 z-30 flex flex-col items-center gap-2 border-t border-line',
          // §11 (MR-56): справа резервируем место под плавающие виджеты (поддержка/Help
          // в правом нижнем углу), чтобы кнопки панели не уходили под них.
          'bg-elevated/95 px-4 py-3 shadow-lg shadow-black/40 backdrop-blur',
          className,
        )}
      >
        {children}
      </div>
    </>
  )
}
