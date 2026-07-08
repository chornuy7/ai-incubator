import { useEffect, useState } from 'react'

/** Имитация загрузки данных: true → false через delay мс. Пересчитывается при смене deps. */
export function useMockLoading(delay = 500, deps: unknown[] = []) {
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    setLoading(true)
    const t = setTimeout(() => setLoading(false), delay)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return loading
}

/** Медиа-запрос. */
export function useMediaQuery(query: string) {
  const [match, setMatch] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const m = window.matchMedia(query)
    const onChange = () => setMatch(m.matches)
    m.addEventListener('change', onChange)
    return () => m.removeEventListener('change', onChange)
  }, [query])
  return match
}
