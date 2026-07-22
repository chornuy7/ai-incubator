import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'

/**
 * Панель, которая висит над страницей и ходит за человеком.
 *
 * Настройки модулей длинные, и до кнопки «Начать» приходилось прокручивать вниз.
 * Раньше стояло `sticky`, но оно держится только внутри своей карточки: стоило
 * проскроллить дальше — кнопка пропадала.
 *
 * `fixed` считает координаты от окна, поэтому панель заехала бы на боковое меню
 * (которое к тому же сворачивается). Чтобы этого не было, ширину и левый край берём
 * с невидимой заглушки, стоящей в обычном потоке. Она же держит высоту — иначе
 * нижний блок страницы прятался бы под панелью.
 */
export function FloatingBar({ children, className }: { children: ReactNode; className?: string }) {
  const holderRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ left: number; width: number } | null>(null)
  const [barH, setBarH] = useState(0)

  useLayoutEffect(() => {
    const measure = () => {
      const h = holderRef.current
      if (!h) return
      const r = h.getBoundingClientRect()
      setBox({ left: Math.round(r.left), width: Math.round(r.width) })
      if (barRef.current) setBarH(barRef.current.offsetHeight)
    }
    measure()
    window.addEventListener('resize', measure)
    // Меню сворачивается анимацией — следим за шириной родителя, а не только окна.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    if (ro && holderRef.current?.parentElement) ro.observe(holderRef.current.parentElement)
    return () => { window.removeEventListener('resize', measure); ro?.disconnect() }
  }, [])

  // Высота меняется от содержимого (появилось предупреждение, вторая кнопка) —
  // держим заглушку такой же.
  useEffect(() => {
    if (barRef.current) setBarH(barRef.current.offsetHeight)
  })

  return (
    <>
      <div ref={holderRef} style={{ height: barH ? barH + 8 : undefined }} />
      <div
        ref={barRef}
        style={box ? { left: box.left, width: box.width } : undefined}
        className={cn(
          'fixed bottom-4 z-30 flex flex-col items-center gap-3 rounded-2xl border border-line',
          'bg-elevated/95 p-4 shadow-lg shadow-black/40 backdrop-blur sm:flex-row',
          className,
        )}
      >
        {children}
      </div>
    </>
  )
}
