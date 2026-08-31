import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * Вкладка, которая переживает обновление страницы.
 *
 * Раньше активная вкладка жила в `useState`, и F5 выбрасывал человека на первую:
 * тестируешь «Пользователей», обновил — оказался на «Панели». Теперь состояние
 * лежит в адресе (`?tab=…`), поэтому переживает перезагрузку, работает «назад»
 * и ссылку можно переслать коллеге прямо на нужную вкладку.
 *
 * Пишем через `replace`, чтобы переключение вкладок не засоряло историю браузера.
 * `key` — на случай нескольких независимых переключателей на одной странице.
 */
/** Общий буфер записей в адрес — см. пояснение внутри `set`. */
let буфер: URLSearchParams | null = null

export function useTabParam<T extends string | number>(defaultValue: T, key = 'tab'): [T, (v: T) => void] {
  const [sp, setSp] = useSearchParams()
  const raw = sp.get(key)

  let value = defaultValue
  if (raw !== null) {
    if (typeof defaultValue === 'number') {
      const n = Number(raw)
      // Мусор в адресе не должен ломать экран — молча падаем на значение по умолчанию.
      if (Number.isFinite(n)) value = n as T
    } else {
      value = raw as T
    }
  }

  const set = useCallback((v: T) => {
    setSp((prev) => {
      /*
       * Несколько вызовов в одном обработчике должны СЛОЖИТЬСЯ, а не затереть друг друга.
       *
       * Обработчик плитки статуса делает три записи подряд: статус, риск, вкладка. React
       * Router разрешает `prev` из текущего адреса, поэтому все три стартуют с одной базы
       * и выживает последняя — фильтр молча терялся, а плитка не подсвечивалась.
       *
       * Копим изменения в общем буфере и сбрасываем его микрозадачей: в пределах одного
       * обработчика записи складываются, следующий начинает с чистого адреса.
       */
      const база = буфер ?? new URLSearchParams(prev)
      база.set(key, String(v))
      if (!буфер) { буфер = база; queueMicrotask(() => { буфер = null }) }
      return new URLSearchParams(база)
    }, { replace: true })
  }, [key, setSp])

  return [value, set]
}
