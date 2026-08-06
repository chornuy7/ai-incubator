import { useEffect, useState } from 'react'

/**
 * Числовое поле, которое зажимает значение по границам ТОЛЬКО при потере фокуса.
 *
 * Зачем отдельный компонент: по приложению ~22 числовых поля нормализуют ввод прямо
 * в onChange (`Math.max(min, Number(e.target.value) || min)`). Пока минимум 0 или 1,
 * это незаметно, но как только минимум задан другим полем — набрать число нельзя
 * физически. Пример из прогона 21–22.07 (тест 10.1-b): «Задержка от» = 10, в поле
 * «до» нужно 15 — но чтобы набрать «15», надо пройти через «1», а 1 < 10, и клемп
 * мгновенно возвращает 10; следующая цифра дописывается к десятке и выходит 105.
 * Любое число начинается с цифры меньше минимума, поэтому поле не набиралось вообще.
 *
 * Здесь во время набора живёт сырая строка (в т.ч. пустая), а клемп применяется на
 * blur и по Enter — тогда промежуточные значения не мешают.
 */
export function NumberField({
  value,
  onChange,
  min = 0,
  max,
  className = 'input mt-1 h-9',
  id,
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  className?: string
  id?: string
}) {
  const [draft, setDraft] = useState(String(value))

  // Значение сменилось снаружи (сброс формы, загрузка правила) — подхватываем.
  useEffect(() => { setDraft(String(value)) }, [value])

  const commit = () => {
    const n = Number(draft)
    if (draft.trim() === '' || Number.isNaN(n)) return setDraft(String(value)) // мусор — откат
    let next = Math.max(min, n)
    if (max !== undefined) next = Math.min(max, next)
    setDraft(String(next))
    if (next !== value) onChange(next)
  }

  return (
    <input
      id={id}
      type="number"
      min={min}
      max={max}
      value={draft}
      // Клик выделяет значение: иначе ввод дописывается к нулю — «012» вместо «12».
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
      className={className}
    />
  )
}
