import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchUserPrompts, saveUserPrompts } from '@/api/featuresApi'

/** Тексты системных промптов по умолчанию (индекс = promptIndex на бэкенде). */
export const DEFAULT_PROMPT_BODIES = [
  'Напиши короткий позитивный комментарий к посту. 1-2 предложения, без хештегов.',
  'Напиши тёплый, дружелюбный комментарий. 1-2 предложения, без панибратства.',
  'Напиши эмоциональный отклик на пост. 1-2 предложения.',
  'Задай один уместный вопрос автору по теме поста. Одно предложение.',
  'Напиши краткий отзыв на пост. Одно предложение.',
  'Напиши аналитический комментарий. 1-2 предложения, по делу.',
]

/** Заводской набор модуля: по одному тексту на карточку. */
export function defaultBodies(labels: string[]): string[] {
  return labels.map((_, i) => DEFAULT_PROMPT_BODIES[i] ?? DEFAULT_PROMPT_BODIES[0])
}

/**
 * MR-185: промпты живут в базе и принадлежат человеку, а не браузеру.
 *
 * Было: тексты лежали в `localStorage` по ключу `ai-incubator:prompts:<модуль>` — без
 * имени владельца. Отсюда два симптома сразу: правка одного человека доставалась всем,
 * кто заходит с этого компьютера, а со своего второго устройства он своих правок не
 * видел вовсе. Тот же корень был у MR-176: карточки промптов держали ВТОРУЮ копию
 * текстов из localStorage и перекрывали ею то, что выставил применённый шаблон.
 *
 * Теперь источник правды один — этот хук. Компоненты только показывают то, что он отдал.
 */
const LEGACY_KEY = (moduleKey: string) => `ai-incubator:prompts:${moduleKey}`

/** Тексты, оставшиеся в браузере от старой версии. Пусто — переносить нечего. */
function takeLegacyBodies(moduleKey: string, count: number): string[] | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY(moduleKey))
    if (!raw) return null
    const saved = JSON.parse(raw) as string[]
    return Array.isArray(saved) && saved.length === count ? saved : null
  } catch { return null }
}

const dropLegacy = (moduleKey: string) => { try { localStorage.removeItem(LEGACY_KEY(moduleKey)) } catch { /* ignore */ } }

export function usePromptStore(moduleKey: string, labels: string[]) {
  const defaults = defaultBodies(labels)
  const [bodies, setBodies] = useState<string[]>(defaults)
  // Пока набор не пришёл с сервера, сохранять нечего: иначе первый же рендер записал бы
  // человеку заводские тексты поверх его собственных.
  const [loaded, setLoaded] = useState(false)
  const defaultsRef = useRef(defaults)
  defaultsRef.current = defaults
  /**
   * Что РЕАЛЬНО лежит у этого человека (заводские плюс его правки), в отличие от того,
   * что сейчас на экране. После применения чужого шаблона это расходится: на экране
   * тексты шаблона, а личные промпты человека остаются его собственными.
   */
  const storedRef = useRef<string[]>(defaults)

  useEffect(() => {
    let alive = true
    setLoaded(false)
    const count = labels.length
    if (!count) { setLoaded(true); return }
    void (async () => {
      const base = defaultBodies(labels)
      try {
        const changed = await fetchUserPrompts(moduleKey)
        const next = base.map((d, i) => changed[i] ?? d)
        // Первый заход после обновления: то, что человек настроил в браузере, уезжает в
        // базу под него же, локальная копия стирается. Ничего не пропадает и никому
        // чужому не достаётся.
        const legacy = takeLegacyBodies(moduleKey, count)
        if (legacy && !Object.keys(changed).length) {
          await saveUserPrompts(moduleKey, legacy, base).catch(() => {})
          dropLegacy(moduleKey)
          if (alive) { storedRef.current = legacy; setBodies(legacy); setLoaded(true) }
          return
        }
        if (legacy) dropLegacy(moduleKey) // в базе уже есть свои — старая копия только мешает
        if (alive) { storedRef.current = next; setBodies(next); setLoaded(true) }
      } catch {
        // Сеть или ещё не накатанная миграция — показываем заводские, но НЕ считаем
        // набор загруженным: сохранять поверх чужих правок нельзя.
        if (alive) { storedRef.current = base; setBodies(base) }
      }
    })()
    return () => { alive = false }
  }, [moduleKey, labels.length]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Записать ОДНУ карточку — ту, которую человек только что отредактировал.
   *
   * Раньше сохранялся весь набор с экрана, и это тихо крало чужую работу: применил
   * шаблон администратора, поправил в нём одну карточку, нажал «сохранить» — и
   * остальные ПЯТЬ текстов администратора уезжали к тебе как твои собственные, поверх
   * твоих. Человек правил одну карточку и не догадывался, что потерял пять своих.
   *
   * Поэтому остальные карточки берём не с экрана, а из того, что реально сохранено за
   * человеком (`storedRef`): «сохранить» в карточке значит «сделать ЭТОТ текст моим»,
   * и ничего больше.
   */
  const saveCard = useCallback(async (index: number, text: string) => {
    const body = text.trim() || defaultsRef.current[index] || DEFAULT_PROMPT_BODIES[0]
    const payload = defaultsRef.current.map((d, i) => (i === index ? body : (storedRef.current[i] ?? d)))
    storedRef.current = payload
    // На экране меняем ТОЛЬКО эту карточку: остальные там могут быть из шаблона,
    // и подменять их сохранёнными значило бы молча отменить применённый шаблон.
    setBodies((prev) => prev.map((b, i) => (i === index ? body : b)))
    if (!loaded) return
    await saveUserPrompts(moduleKey, payload, defaultsRef.current).catch(() => {})
  }, [moduleKey, loaded])

  /**
   * Подставить набор из шаблона — без записи на сервер: шаблон применяют к ЗАПУСКУ, а не
   * к личным промптам человека. Нажал «сохранить» в карточке — тогда и уедет.
   */
  const replace = useCallback((next: string[]) => setBodies(next), [])

  return { bodies, saveCard, replace, loaded }
}
