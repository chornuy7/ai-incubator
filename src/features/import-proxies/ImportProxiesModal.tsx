import { useEffect, useMemo, useRef, useState } from 'react'
import { Upload, Loader2, Check, AlertTriangle, FileText } from 'lucide-react'
import { Modal, Select, Badge } from '@/shared/ui'
import { previewProxyImport, importProxies, type ParsedProxyLine, type ImportIssue, type Proxy, type ProxyKind, type ProxyScheme, PROXY_KIND_LABELS } from '@/api/proxiesApi'
import { FLAGS } from '@/shared/config/geo'

interface Props {
  open: boolean
  onClose: () => void
  onDone: (created: Proxy[]) => void
}

const PLACEHOLDER = `Вставьте список — по одному прокси на строку. Понимаются форматы:

1.2.3.4:1080
1.2.3.4:1080:логин:пароль
логин:пароль@1.2.3.4:1080
socks5://логин:пароль@1.2.3.4:1080`

/**
 * §3.2: массовый импорт прокси. Страну и живость определяем сами — по РЕАЛЬНОМУ
 * выходному IP, поэтому имена вида «USA SPAM 1» получаются без ручного ввода.
 */
export function ImportProxiesModal({ open, onClose, onDone }: Props) {
  const [text, setText] = useState('')
  const [tag, setTag] = useState('SPAM')
  const [kind, setKind] = useState<ProxyKind>('static')
  const [scheme, setScheme] = useState<ProxyScheme>('socks5')
  const [probe, setProbe] = useState(true)
  const [items, setItems] = useState<ParsedProxyLine[]>([])
  const [errors, setErrors] = useState<ImportIssue[]>([])
  const [duplicates, setDuplicates] = useState(0)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ created: Proxy[]; skipped: ImportIssue[]; errors: ImportIssue[] } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Разбор идёт на сервере на каждый ввод — он дешёвый (без сети), зато человек сразу
  // видит, сколько строк понято и какие именно не поехали.
  useEffect(() => {
    if (!open) return
    const id = setTimeout(() => {
      if (!text.trim()) { setItems([]); setErrors([]); setDuplicates(0); return }
      void previewProxyImport(text, scheme)
        .then((r) => { setItems(r.items); setErrors(r.errors); setDuplicates(r.duplicates) })
        .catch(() => { /* превью не критично */ })
    }, 300)
    return () => clearTimeout(id)
  }, [text, scheme, open])

  useEffect(() => { if (open) { setResult(null) } }, [open])

  const example = useMemo(() => {
    if (!items.length) return ''
    const country = probe ? '{страна}' : 'XX'
    return [1, 2, 3].slice(0, Math.min(3, items.length)).map((n) => `${country} ${tag} ${n}`.replace(/\s+/g, ' ').trim()).join(', ')
  }, [items.length, tag, probe])

  const pickFile = async (f: File | null) => {
    if (!f) return
    setText(await f.text())
  }

  const run = async () => {
    setBusy(true)
    try {
      const r = await importProxies({ text, scheme, kind, tag: tag.trim(), probe })
      setResult(r)
      onDone(r.created)
    } catch (e) {
      setErrors([{ raw: '', reason: e instanceof Error ? e.message : 'Импорт не удался' }])
    } finally { setBusy(false) }
  }

  const close = () => { setText(''); setItems([]); setErrors([]); setResult(null); onClose() }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Массовый импорт прокси"
      subtitle="Страна и живость определяются автоматически по реальному выходному IP"
      icon={<Upload size={18} />}
      size="lg"
    >
      {result ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="spark"><Check size={12} /> Добавлено: {result.created.length}</Badge>
            {!!result.skipped.length && <Badge tone="amber">Пропущено: {result.skipped.length}</Badge>}
            {!!result.errors.length && <Badge tone="rose">Ошибок: {result.errors.length}</Badge>}
          </div>
          <div className="max-h-64 overflow-y-auto rounded-xl border border-line">
            {result.created.map((p) => (
              <div key={p.id} className="flex items-center gap-2 border-b border-line/60 px-3 py-2 text-sm last:border-0">
                <span className="w-6 text-center">{p.country ? FLAGS[p.country] || '🏳️' : '❔'}</span>
                <span className="font-semibold text-white">{p.label}</span>
                <span className="text-xs text-white/45">{p.host}:{p.port}</span>
                <span className="ml-auto">
                  <Badge tone={p.status === 'ok' ? 'spark' : p.status === 'dead' ? 'rose' : 'muted'}>
                    {p.status === 'ok' ? 'Рабочий' : p.status === 'dead' ? 'Мёртвый' : 'Не проверен'}
                  </Badge>
                </span>
              </div>
            ))}
            {[...result.skipped, ...result.errors].map((e, i) => (
              <div key={`e${i}`} className="flex items-center gap-2 border-b border-line/60 px-3 py-2 text-sm last:border-0">
                <AlertTriangle size={13} className="text-amber-300" />
                <span className="truncate text-white/60">{e.raw || '—'}</span>
                <span className="ml-auto text-xs text-white/40">{e.reason}</span>
              </div>
            ))}
          </div>
          <div className="flex justify-end"><button onClick={close} className="btn-primary h-10">Готово</button></div>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <div className="mb-1 flex items-center justify-between text-xs text-white/50">
              <span>Список прокси</span>
              <button onClick={() => fileRef.current?.click()} className="btn-ghost h-7 px-2 text-xs"><FileText size={12} /> Загрузить из файла</button>
              <input ref={fileRef} type="file" accept=".txt,.csv,text/plain" className="hidden" onChange={(e) => void pickFile(e.target.files?.[0] || null)} />
            </div>
            <textarea
              className="input min-h-[160px] resize-y font-mono text-xs"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={PLACEHOLDER}
            />
          </div>

          {(items.length > 0 || errors.length > 0 || duplicates > 0) && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge tone="spark">Понято строк: {items.length}</Badge>
              {duplicates > 0 && <Badge tone="amber">Уже в базе: {duplicates}</Badge>}
              {errors.length > 0 && <Badge tone="rose">Не разобрано: {errors.length}</Badge>}
              {errors.length > 0 && (
                <span className="text-white/40">строка {errors.slice(0, 3).map((e) => e.line).filter(Boolean).join(', ')}{errors.length > 3 ? '…' : ''}</span>
              )}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <div className="mb-1 text-xs text-white/50">Метка в имени</div>
              <input className="input" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="SPAM" />
            </div>
            <div>
              <div className="mb-1 text-xs text-white/50">Протокол по умолчанию</div>
              <Select value={scheme} onChange={(v) => setScheme(v as ProxyScheme)} options={[{ value: 'socks5', label: 'SOCKS5' }, { value: 'http', label: 'HTTP' }]} />
            </div>
            <div>
              <div className="mb-1 text-xs text-white/50">Тип</div>
              <Select value={kind} onChange={(v) => setKind(v as ProxyKind)} options={(Object.keys(PROXY_KIND_LABELS) as ProxyKind[]).map((k) => ({ value: k, label: PROXY_KIND_LABELS[k] }))} />
            </div>
          </div>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-line bg-elevated/40 p-3">
            <input type="checkbox" checked={probe} onChange={(e) => setProbe(e.target.checked)} className="mt-0.5 h-4 w-4 accent-spark" />
            <span>
              <span className="text-sm font-semibold">Определить страну и живость при импорте</span>
              <span className="mt-0.5 block text-xs text-white/45">
                Каждый прокси проверяется на живость, и через него запрашивается настоящий выходной IP — у мобильных
                и резидентных шлюз показывает не ту страну. Занимает несколько секунд на прокси; без проверки
                страна останется неизвестной, а имена — «XX {tag || '…'} 1».
              </span>
            </span>
          </label>

          {items.length > 0 && (
            <div className="text-xs text-white/40">Имена получатся: {example}{items.length > 3 ? ' …' : ''} — нумерация продолжится от уже существующих.</div>
          )}

          <div className="flex justify-end gap-2">
            <button onClick={close} className="btn-ghost h-10">Отмена</button>
            <button onClick={() => void run()} disabled={!items.length || busy} className="btn-primary h-10">
              {busy ? <><Loader2 size={15} className="animate-spin" /> Импорт{probe ? ' и проверка' : ''}…</> : <>Импортировать {items.length || ''}</>}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
