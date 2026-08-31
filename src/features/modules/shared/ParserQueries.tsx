import { useCallback, useEffect, useRef, useState } from 'react'
import { History, Pencil, Trash2, Check, X, Loader2, ChevronDown, EyeOff } from 'lucide-react'
import { fetchParserQueries, fetchParserQuery, renameParserQuery, deleteParserQuery, type ParserQuery } from '@/api/modulesApi'
import { useApp } from '@/mocks/store'
import { cn } from '@/shared/lib/utils'
import { confirmDialog } from '@/shared/lib/dialog'

/**
 * «Последние запросы» парсера — выпадающий список того, что уже искали.
 *
 * Форма выбрана владельцем 26.08 («удалим это и добавим просто дроп-даун, там дата и
 * время, при нажатии показывается список, при выборе „не показывать“ — не показываются»).
 * До этого рядом жили ДВА элемента про одно и то же: раскрытый список прошлых запросов
 * и плашка «в базе есть сохранённый результат» с той же датой и той же кнопкой. Теперь
 * один свёрнутый контрол: в закрытом виде — что показано сейчас, в открытом — список с
 * переименованием и удалением.
 *
 * Отдельного хранилища под это нет: каждый прогон и так ложится в кэш результатов вместе
 * с датой, счётчиком и подписью запроса. Поэтому и «как называть по умолчанию» не вопрос —
 * запрос описан тем, что в нём искали; первые слова, остальные в «+N».
 */
export function ParserQueries({ moduleKey, unit = 'каналов', onOpen, onHide, extra }: {
  moduleKey: string
  /** «каналов» / «групп» / «пользователей» — чтобы счётчик читался по-русски. */
  unit?: string
  /** Показать сохранённый результат в витрине. */
  onOpen: (results: Record<string, unknown>[], q: ParserQuery) => void
  /** «Не показывать» — вернуться к результатам текущего запуска. */
  onHide: () => void
  /** Довесок в шапку — например галочка «обновлять раз в сутки» для текущего запроса. */
  extra?: React.ReactNode
}) {
  const pushToast = useApp((s) => s.pushToast)
  const [items, setItems] = useState<ParserQuery[]>([])
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState<ParserQuery | null>(null)
  const [busy, setBusy] = useState('')
  const [editing, setEditing] = useState('')
  const [draft, setDraft] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try { setItems(await fetchParserQueries(moduleKey)) }
    catch { /* список прошлых запросов не должен мешать работе витрины */ }
  }, [moduleKey])

  useEffect(() => { void load() }, [load])

  // Клик мимо закрывает список: иначе он перекрывает результаты и мешает читать их.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const fmt = (ts: number) => new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

  const openQuery = async (q: ParserQuery) => {
    setBusy(q.sig)
    try {
      const full = await fetchParserQuery(q.sig)
      onOpen(full.results || [], q)
      setShown(q)
      setOpen(false)
    } catch (e) {
      pushToast?.({ type: 'error', title: e instanceof Error ? e.message : 'Не удалось открыть запрос' })
    } finally { setBusy('') }
  }

  const hide = () => { setShown(null); setOpen(false); onHide() }

  const save = async (q: ParserQuery) => {
    const name = draft.trim()
    setEditing('')
    // Пустое имя — не ошибка, а «вернуть автоподпись»: отдельной кнопки сброса не нужно.
    if (name === (q.renamed ? q.name : '')) return
    try { await renameParserQuery(q.sig, name); await load() }
    catch (e) { pushToast?.({ type: 'error', title: e instanceof Error ? e.message : 'Не удалось переименовать' }) }
  }

  const remove = async (q: ParserQuery) => {
    // Удаление стирает и результаты: следующий такой же запрос соберётся заново и будет
    // стоить монет. Об этом честно пишем в вопросе, а не после.
    const ok = await confirmDialog({
      title: `Удалить запрос «${q.name}»?`,
      message: `Сохранённые ${q.count} строк пропадут, и такой же запрос придётся собирать заново — он снова будет стоить монет.`,
      confirmLabel: 'Удалить',
      tone: 'danger',
    })
    if (!ok) return
    setBusy(q.sig)
    try {
      await deleteParserQuery(q.sig)
      if (shown?.sig === q.sig) hide()
      await load()
    } catch (e) { pushToast?.({ type: 'error', title: e instanceof Error ? e.message : 'Не удалось удалить' }) }
    finally { setBusy('') }
  }

  if (!items.length) return null

  return (
    <div ref={boxRef} className="relative mb-4 flex flex-wrap items-center gap-3">
      <button type="button" onClick={() => setOpen((v) => !v)}
        className={cn('flex h-9 min-w-[260px] items-center gap-2 rounded-xl border px-3 text-sm transition-colors',
          shown ? 'border-iris-500/40 bg-iris-500/10 text-fg' : 'border-line bg-elevated text-muted hover:border-spark-500/30')}>
        <History size={14} className={shown ? 'text-iris-300' : 'text-spark-400'} />
        <span className="min-w-0 flex-1 truncate text-left">
          {shown
            ? <>Из базы · {fmt(shown.updatedAt)} · {shown.count} {unit}</>
            : <>Последние запросы ({items.length}) — не показывать</>}
        </span>
        <ChevronDown size={14} className={cn('shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {extra}

      {open && (
        <div className="absolute left-0 top-11 z-20 max-h-80 w-full max-w-xl overflow-y-auto rounded-2xl border border-line bg-elevated p-2 shadow-lg shadow-black/40">
          <button type="button" onClick={hide}
            className={cn('flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-white/5',
              shown ? 'text-muted' : 'font-semibold text-fg')}>
            <EyeOff size={13} /> Не показывать
          </button>
          {items.map((q) => (
            <div key={q.sig} className={cn('flex items-center gap-2 rounded-lg px-2 py-1.5',
              shown?.sig === q.sig ? 'bg-iris-500/10' : 'hover:bg-white/5')}>
              {editing === q.sig ? (
                <div className="flex flex-1 items-center gap-1.5">
                  <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void save(q); if (e.key === 'Escape') setEditing('') }}
                    className="input h-7 text-sm" placeholder="Название запроса" />
                  <button type="button" onClick={() => void save(q)} className="btn-icon h-7 w-7 text-spark-300" title="Сохранить"><Check size={13} /></button>
                  <button type="button" onClick={() => setEditing('')} className="btn-icon h-7 w-7 text-muted" title="Отмена"><X size={13} /></button>
                </div>
              ) : (
                <>
                  <button type="button" onClick={() => void openQuery(q)} disabled={busy === q.sig} className="min-w-0 flex-1 text-left">
                    <div className="truncate text-sm font-semibold text-fg">
                      {busy === q.sig && <Loader2 size={12} className="mr-1 inline animate-spin" />}
                      {q.name}
                    </div>
                    <div className="truncate text-[11px] text-white/40">
                      {fmt(q.updatedAt)} · {q.count} {unit}
                      {/* Автоподпись под своим именем: иначе непонятно, что внутри «Крипта осень». */}
                      {q.renamed && q.query ? ` · ${q.query.slice(0, 50)}` : ''}
                      {q.watch ? ' · следим' : ''}
                    </div>
                  </button>
                  <button type="button" onClick={() => { setEditing(q.sig); setDraft(q.renamed ? q.name : '') }}
                    className="btn-icon h-7 w-7 shrink-0 text-muted hover:text-fg" title="Переименовать"><Pencil size={13} /></button>
                  <button type="button" onClick={() => void remove(q)} disabled={busy === q.sig}
                    className="btn-icon h-7 w-7 shrink-0 text-muted hover:text-rose-300" title="Удалить"><Trash2 size={13} /></button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
