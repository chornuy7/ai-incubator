import { useCallback, useEffect, useState } from 'react'
import { History, Pencil, Trash2, Check, X, Loader2, Eye } from 'lucide-react'
import { fetchParserQueries, fetchParserQuery, renameParserQuery, deleteParserQuery, type ParserQuery } from '@/api/modulesApi'
import { useApp } from '@/mocks/store'

/**
 * «Последние запросы» парсера (просьба владельца 26.08: «везде в парсинге нужно
 * сделать последние запросы, и там список всех найденных тгшек, назвать можно,
 * переименовать и удалить»).
 *
 * Отдельного хранилища под это не заводили: каждый прогон и так ложится в кэш
 * результатов вместе с датой, счётчиком и подписью запроса. Отсюда и ответ на
 * вопрос «как называть по умолчанию» — запрос уже описан тем, что в нём искали:
 * показываем первые слова (или источники), остальные сворачиваем в «+N». Имя от
 * человека, если он его дал, становится главным, а автоподпись остаётся рядом
 * мелким шрифтом — чтобы «Крипта осень» не потеряла связь с тем, что внутри.
 */
export function ParserQueries({ moduleKey, onOpen }: {
  moduleKey: string
  /** Открыть сохранённый результат в витрине: список каналов + дата сбора. */
  onOpen: (results: Record<string, unknown>[], q: ParserQuery) => void
}) {
  const pushToast = useApp((s) => s.pushToast)
  const [items, setItems] = useState<ParserQuery[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [editing, setEditing] = useState('')
  const [draft, setDraft] = useState('')

  const load = useCallback(async () => {
    try { setItems(await fetchParserQueries(moduleKey)) }
    catch { /* список запросов не должен мешать работе витрины */ }
    finally { setLoading(false) }
  }, [moduleKey])

  useEffect(() => { void load() }, [load])

  const open = async (q: ParserQuery) => {
    setBusy(q.sig)
    try {
      const full = await fetchParserQuery(q.sig)
      onOpen(full.results || [], q)
    } catch (e) {
      pushToast?.({ type: 'error', title: e instanceof Error ? e.message : 'Не удалось открыть запрос' })
    } finally { setBusy('') }
  }

  const save = async (q: ParserQuery) => {
    const name = draft.trim()
    setEditing('')
    // Пустое имя — не ошибка, а «вернуть автоподпись»: отдельной кнопки сброса не нужно.
    if (name === (q.renamed ? q.name : '')) return
    try { await renameParserQuery(q.sig, name); await load() }
    catch (e) { pushToast?.({ type: 'error', title: e instanceof Error ? e.message : 'Не удалось переименовать' }) }
  }

  const remove = async (q: ParserQuery) => {
    // Удаление стирает и результаты: следующий такой же запрос соберётся заново
    // и будет стоить монет. Об этом честно пишем в вопросе, а не после.
    if (!window.confirm(`Удалить «${q.name}»? Сохранённые ${q.count} строк пропадут, и такой же запрос придётся собирать заново.`)) return
    setBusy(q.sig)
    try { await deleteParserQuery(q.sig); await load() }
    catch (e) { pushToast?.({ type: 'error', title: e instanceof Error ? e.message : 'Не удалось удалить' }) }
    finally { setBusy('') }
  }

  if (loading) return null
  if (!items.length) {
    return (
      <div className="rounded-2xl border border-line bg-elevated/40 p-3 text-xs text-muted">
        <span className="flex items-center gap-1.5 font-semibold text-fg"><History size={14} className="text-spark-400" /> Последние запросы</span>
        <span className="mt-1 block text-white/40">Пока пусто. Каждый запуск парсинга сохраняется сюда вместе с найденными каналами — можно открыть, переименовать или удалить.</span>
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-line bg-elevated/40 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-fg">
        <History size={14} className="text-spark-400" /> Последние запросы
        <span className="rounded bg-elevated px-1.5 text-[11px] font-bold text-muted">{items.length}</span>
      </div>
      <div className="space-y-1.5">
        {items.map((q) => (
          <div key={q.sig} className="flex items-center gap-2 rounded-xl border border-line bg-elevated px-3 py-2">
            <div className="min-w-0 flex-1">
              {editing === q.sig ? (
                <div className="flex items-center gap-1.5">
                  <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void save(q); if (e.key === 'Escape') setEditing('') }}
                    className="input h-7 text-sm" placeholder="Название запроса" />
                  <button type="button" onClick={() => void save(q)} className="btn-icon h-7 w-7 text-spark-300" title="Сохранить"><Check size={13} /></button>
                  <button type="button" onClick={() => setEditing('')} className="btn-icon h-7 w-7 text-muted" title="Отмена"><X size={13} /></button>
                </div>
              ) : (
                <>
                  <div className="truncate text-sm font-semibold text-fg">{q.name}</div>
                  <div className="truncate text-[11px] text-white/40">
                    {q.count} найдено · {new Date(q.updatedAt).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    {/* Автоподпись под своим именем: иначе непонятно, что внутри «Крипта осень». */}
                    {q.renamed && q.query ? ` · ${q.query.slice(0, 60)}` : ''}
                    {q.watch ? ' · следим' : ''}
                  </div>
                </>
              )}
            </div>
            {editing !== q.sig && (
              <div className="flex shrink-0 items-center gap-1">
                <button type="button" onClick={() => void open(q)} disabled={busy === q.sig}
                  className="btn-soft h-7 px-2 text-[11px]" title="Показать найденное">
                  {busy === q.sig ? <Loader2 size={12} className="animate-spin" /> : <Eye size={12} />} Открыть
                </button>
                <button type="button" onClick={() => { setEditing(q.sig); setDraft(q.renamed ? q.name : '') }}
                  className="btn-icon h-7 w-7 text-muted hover:text-fg" title="Переименовать"><Pencil size={13} /></button>
                <button type="button" onClick={() => void remove(q)} disabled={busy === q.sig}
                  className="btn-icon h-7 w-7 text-muted hover:text-rose-300" title="Удалить"><Trash2 size={13} /></button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
