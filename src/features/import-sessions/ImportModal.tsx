import { useEffect, useMemo, useState } from 'react'
import { UploadCloud, Folder, FolderOpen, ChevronRight, Loader2, Search, Check, AlertTriangle, HardDrive, Users, KeyRound } from 'lucide-react'
import { Modal, Select, Badge } from '@/shared/ui'
import { browseDirs, scanFolder, runImport, proxyCapacity, type ScannedAccount, type ProxyMode, type ImportResultRow } from '@/api/accountImportApi'
import { fetchProxies, toProxyUrl, type Proxy } from '@/api/proxiesApi'

type Step = 'pick' | 'found' | 'result'

const PROXY_MODE_LABELS: Record<ProxyMode, string> = {
  pool: 'По одному из пула на аккаунт',
  single: 'Один прокси на всю пачку',
  sidecar: 'Из файла рядом с аккаунтом',
  none: 'Без прокси',
}

/**
 * §2: массовый импорт аккаунтов. Папку выбираем проводником НА СЕРВЕРЕ — так tdata
 * (десятки мегабайт на аккаунт) не гоняется по HTTP, читается прямо с диска.
 */
export function ImportModal({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported?: () => void }) {
  const [step, setStep] = useState<Step>('pick')
  const [dir, setDir] = useState('')
  const [parent, setParent] = useState<string | null>(null)
  const [dirs, setDirs] = useState<{ name: string; path: string }[]>([])
  const [browsing, setBrowsing] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [items, setItems] = useState<ScannedAccount[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [passcode, setPasscode] = useState('')
  const [proxyMode, setProxyMode] = useState<ProxyMode>('pool')
  const [proxies, setProxies] = useState<Proxy[]>([])
  const [singleProxy, setSingleProxy] = useState('')
  const [freeProxies, setFreeProxies] = useState(0)
  const [validate, setValidate] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [results, setResults] = useState<ImportResultRow[]>([])

  const key = (i: ScannedAccount) => `${i.path}#${i.accountIdx ?? 0}`

  const go = async (target: string) => {
    setBrowsing(true); setErr('')
    try {
      const r = await browseDirs(target)
      setDir(r.path); setParent(r.parent); setDirs(r.dirs)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Не удалось открыть папку') }
    finally { setBrowsing(false) }
  }

  useEffect(() => {
    if (!open) return
    setStep('pick'); setItems([]); setResults([]); setErr('')
    void go('')
    void fetchProxies().then(setProxies).catch(() => {})
    void proxyCapacity().then((c) => setFreeProxies(c.free)).catch(() => {})
  }, [open])

  const scan = async () => {
    if (!dir) return
    setScanning(true); setErr('')
    try {
      const r = await scanFolder(dir, passcode || undefined)
      setItems(r.items)
      // Уже заведённые по умолчанию не отмечаем — чтобы повторный скан не плодил дубли.
      setPicked(new Set(r.items.filter((i) => !i.known).map(key)))
      setStep('found')
      if (!r.items.length) setErr(`В папке ничего не найдено (просмотрено каталогов: ${r.scannedDirs}). Проверьте, что внутри лежат папки tdata или файлы .session.`)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Сканирование не удалось') }
    finally { setScanning(false) }
  }

  const chosen = useMemo(() => items.filter((i) => picked.has(key(i))), [items, picked])
  const toggle = (i: ScannedAccount) => setPicked((prev) => {
    const n = new Set(prev); const k = key(i); n.has(k) ? n.delete(k) : n.add(k); return n
  })

  const notEnoughProxies = proxyMode === 'pool' && chosen.length > freeProxies

  const run = async () => {
    setBusy(true); setErr('')
    try {
      const r = await runImport({ items: chosen, proxyMode, singleProxy, validate, passcode: passcode || undefined })
      setResults(r.results)
      setStep('result')
      onImported?.()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Импорт не удался') }
    finally { setBusy(false) }
  }

  const close = () => { setStep('pick'); setItems([]); setResults([]); onClose() }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Импортировать аккаунты"
      subtitle={step === 'pick' ? 'Выберите папку с аккаунтами — внутри ищем tdata и .session' : step === 'found' ? `Найдено аккаунтов: ${items.length}` : 'Отчёт по импорту'}
      icon={<UploadCloud size={22} />}
      size="lg"
    >
      {err && <div className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200">{err}</div>}

      {step === 'pick' && (
        <div className="space-y-3">
          <div className="flex gap-2">
            <input
              className="input flex-1 font-mono text-xs"
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void go(dir) }}
              placeholder="E:\accounts — можно вставить путь и нажать Enter"
            />
            <button onClick={() => void go(dir)} disabled={browsing} className="btn-ghost h-10 shrink-0">Открыть</button>
          </div>

          <div className="max-h-64 overflow-y-auto rounded-xl border border-line">
            {parent !== null && (
              <button onClick={() => void go(parent || '')} className="flex w-full items-center gap-2 border-b border-line/60 px-3 py-2 text-left text-sm hover:bg-elevated">
                <ChevronRight size={14} className="rotate-180 text-white/40" /> <span className="text-white/60">Наверх</span>
              </button>
            )}
            {browsing ? (
              <div className="p-4 text-sm text-white/50"><Loader2 size={14} className="mr-2 inline animate-spin" /> Открываю…</div>
            ) : dirs.length === 0 ? (
              <div className="p-4 text-sm text-white/40">Вложенных папок нет</div>
            ) : dirs.map((d) => (
              <button key={d.path} onClick={() => void go(d.path)} className="flex w-full items-center gap-2 border-b border-line/60 px-3 py-2 text-left text-sm last:border-0 hover:bg-elevated">
                {d.path.length <= 3 ? <HardDrive size={14} className="text-iris-300" /> : <Folder size={14} className="text-amber-300" />}
                <span className="truncate">{d.name}</span>
              </button>
            ))}
          </div>

          <div>
            <div className="mb-1 flex items-center gap-1.5 text-xs text-white/50"><KeyRound size={12} /> Локальный пароль tdata <span className="text-white/30">(если Telegram Desktop был под паролем)</span></div>
            <input className="input" type="password" value={passcode} onChange={(e) => setPasscode(e.target.value)} placeholder="обычно пусто" />
          </div>

          <div className="flex justify-end gap-2">
            <button onClick={close} className="btn-ghost h-10">Отмена</button>
            <button onClick={() => void scan()} disabled={!dir || scanning} className="btn-primary h-10">
              {scanning ? <><Loader2 size={15} className="animate-spin" /> Сканирую…</> : <><Search size={15} /> Найти аккаунты</>}
            </button>
          </div>
        </div>
      )}

      {step === 'found' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge tone="spark">Отмечено: {chosen.length}</Badge>
            <Badge tone="iris">tdata: {items.filter((i) => i.kind === 'tdata').length}</Badge>
            <Badge tone="iris">.session: {items.filter((i) => i.kind === 'session-file').length}</Badge>
            {items.some((i) => i.known) && <Badge tone="amber">Уже в системе: {items.filter((i) => i.known).length}</Badge>}
            <button onClick={() => setPicked(new Set(items.map(key)))} className="ml-auto text-white/50 hover:text-white">Все</button>
            <button onClick={() => setPicked(new Set())} className="text-white/50 hover:text-white">Никого</button>
          </div>

          <div className="max-h-56 overflow-y-auto rounded-xl border border-line">
            {items.map((i) => (
              <label key={key(i)} className="flex cursor-pointer items-center gap-2 border-b border-line/60 px-3 py-2 text-sm last:border-0 hover:bg-elevated">
                <input type="checkbox" checked={picked.has(key(i))} onChange={() => toggle(i)} className="h-4 w-4 accent-spark" />
                {i.kind === 'tdata' ? <FolderOpen size={14} className="shrink-0 text-amber-300" /> : <Users size={14} className="shrink-0 text-iris-300" />}
                <span className="truncate font-semibold text-white">{i.name}</span>
                {i.phone && <span className="shrink-0 font-mono text-xs text-white/45">{i.phone}</span>}
                {i.proxy && <Badge tone="iris">свой прокси</Badge>}
                {i.known && <Badge tone="amber">уже есть</Badge>}
              </label>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <div className="mb-1 text-xs text-white/50">Прокси для пачки</div>
              <Select value={proxyMode} onChange={(v) => setProxyMode(v as ProxyMode)} options={(Object.keys(PROXY_MODE_LABELS) as ProxyMode[]).map((m) => ({ value: m, label: PROXY_MODE_LABELS[m] }))} />
              {proxyMode === 'pool' && (
                <div className={`mt-1 text-xs ${notEnoughProxies ? 'text-amber-300' : 'text-white/40'}`}>
                  Свободно прокси: {freeProxies}{notEnoughProxies ? ` — на ${chosen.length} аккаунтов не хватит, лишние будут пропущены` : ' · один прокси на один аккаунт (§6)'}
                </div>
              )}
            </div>
            {proxyMode === 'single' && (
              <div>
                <div className="mb-1 text-xs text-white/50">Какой прокси</div>
                <Select
                  value={singleProxy}
                  onChange={setSingleProxy}
                  placeholder="Выберите прокси"
                  options={proxies.map((p) => ({ value: toProxyUrl(p), label: `${p.label || p.host}:${p.port}` }))}
                />
              </div>
            )}
          </div>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-line bg-elevated/40 p-3">
            <input type="checkbox" checked={validate} onChange={(e) => setValidate(e.target.checked)} className="mt-0.5 h-4 w-4 accent-spark" />
            <span>
              <span className="text-sm font-semibold">Проверить каждый аккаунт при импорте</span>
              <span className="mt-0.5 block text-xs text-white/45">
                Заходим в Telegram сессией через назначенный прокси — только так видно, что аккаунт живой,
                и сразу подтягиваются имя, username и телефон. Несколько секунд на аккаунт; без проверки
                мёртвые сессии попадут в список наравне с рабочими.
              </span>
            </span>
          </label>

          <div className="flex justify-end gap-2">
            <button onClick={() => setStep('pick')} className="btn-ghost h-10">Назад</button>
            <button onClick={() => void run()} disabled={!chosen.length || busy} className="btn-primary h-10">
              {busy ? <><Loader2 size={15} className="animate-spin" /> Импортирую{validate ? ' и проверяю' : ''}…</> : <>Импортировать {chosen.length}</>}
            </button>
          </div>
        </div>
      )}

      {step === 'result' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="spark"><Check size={12} /> Добавлено: {results.filter((r) => r.ok).length}</Badge>
            {results.some((r) => !r.ok) && <Badge tone="rose">Не вышло: {results.filter((r) => !r.ok).length}</Badge>}
          </div>
          <div className="max-h-64 overflow-y-auto rounded-xl border border-line">
            {results.map((r, i) => (
              <div key={i} className="flex items-center gap-2 border-b border-line/60 px-3 py-2 text-sm last:border-0">
                {r.ok ? <Check size={13} className="shrink-0 text-spark-400" /> : <AlertTriangle size={13} className="shrink-0 text-rose-400" />}
                <span className="truncate font-semibold text-white">{r.name}</span>
                {r.phone && <span className="shrink-0 font-mono text-xs text-white/45">{r.phone}</span>}
                <span className="ml-auto shrink-0 text-xs text-white/40">{r.ok ? (r.proxy ? 'с прокси' : 'без прокси') : r.reason}</span>
              </div>
            ))}
          </div>
          <div className="flex justify-end"><button onClick={close} className="btn-primary h-10">Готово</button></div>
        </div>
      )}
    </Modal>
  )
}
