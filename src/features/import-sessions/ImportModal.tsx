import { useEffect, useMemo, useState } from 'react'
import { UploadCloud, Folder, FolderOpen, ChevronRight, Loader2, Search, Check, AlertTriangle, HardDrive, Users, KeyRound } from 'lucide-react'
import { useRef } from 'react'
import { Modal, Select, Badge } from '@/shared/ui'
import { cn } from '@/shared/lib/utils'
import { browseDirs, scanFolder, runImport, proxyCapacity, pairPreview, uploadFolder, cleanupUpload, type ScannedAccount, type ProxyMode, type ImportResultRow, type PairPoolItem } from '@/api/accountImportApi'
import { fetchProxies, importProxies, toProxyUrl, type Proxy } from '@/api/proxiesApi'

type Step = 'pick' | 'found' | 'proxy' | 'result'

const PROXY_MODE_LABELS: Record<ProxyMode, string> = {
  pool: 'По одному из пула на аккаунт',
  single: 'Один прокси на всю пачку',
  sidecar: 'Из файла рядом с аккаунтом',
  manual: 'Разложить вручную (таблица)',
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
  // §2: облачные пароли, введённые руками — только для тех, у кого не нашли рядом.
  const [passwords, setPasswords] = useState<Record<string, string>>({})
  const [proxyMode, setProxyMode] = useState<ProxyMode>('pool')
  const [proxies, setProxies] = useState<Proxy[]>([])
  const [singleProxy, setSingleProxy] = useState('')
  const [freeProxies, setFreeProxies] = useState(0)
  // Шаг «Прокси»: список, вставленный оператором, и раскладка «аккаунт ↔ прокси».
  const [proxyText, setProxyText] = useState('')
  const [adding, setAdding] = useState(false)
  const [addReport, setAddReport] = useState('')
  const [pool, setPool] = useState<PairPoolItem[]>([])
  const [pairs, setPairs] = useState<(string | null)[]>([])
  const [validate, setValidate] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [results, setResults] = useState<ImportResultRow[]>([])
  // §2: путь «загрузкой» — для случая, когда бэкенд не на машине с аккаунтами.
  const [root, setRoot] = useState('')
  const [uploadToken, setUploadToken] = useState('')
  const [uploading, setUploading] = useState(false)
  const folderRef = useRef<HTMLInputElement>(null)

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
      setRoot(dir); setUploadToken(''); setPasswords({})
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

  /**
   * Аккаунты для раскладки — в том порядке, в каком их нашли в папке.
   * Страну не вычисляем здесь: она выводится из номера, и делает это сервер —
   * иначе тот же справочник кодов пришлось бы держать во второй копии.
   */
  const pairAccounts = useMemo(
    () => chosen.map((i) => ({ name: i.name, phone: i.phone || '' })),
    [chosen],
  )

  /** Перестроить раскладку сервером: по порядку либо с учётом страны. */
  const relayout = async (matchGeo: boolean) => {
    try {
      const r = await pairPreview({ accounts: pairAccounts, matchGeo, skipDead: true })
      setPool(r.pool); setPairs(r.pairs)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Не удалось разложить') }
  }

  /**
   * Добавить прокси списком. Внутри — обычный импорт прокси: разбор, отсев дублей,
   * ПРОВЕРКА живости и настоящей страны выхода. Проверенные сразу идут в раскладку
   * в том порядке, в каком их вставили, — это и есть «1 к 1 по строкам».
   */
  const addProxies = async () => {
    const text = proxyText.trim()
    if (!text) return
    setAdding(true); setErr(''); setAddReport('')
    try {
      const r = await importProxies({ text, probe: true })
      const urls = r.created.map(toProxyUrl)
      setAddReport(
        `Добавлено ${r.created.length}: живых ${r.alive}` +
        (r.bad ? `, с неверной схемой ${r.bad}` : '') +
        (r.dead ? `, мёртвых ${r.dead}` : '') +
        (r.skipped.length ? `, уже были ${r.skipped.length}` : '') +
        (r.errors.length ? `, не разобрано ${r.errors.length}` : ''),
      )
      setProxyText('')
      // Раскладываем на объединённый список: сначала то, что было свободно, потом новые.
      const merged = [...pool.map((p) => p.url), ...urls]
      const pr = await pairPreview({ accounts: pairAccounts, proxyUrls: merged, skipDead: true })
      setPool(pr.pool); setPairs(pr.pairs)
      void proxyCapacity().then((c) => setFreeProxies(c.free)).catch(() => {})
      void fetchProxies().then(setProxies).catch(() => {})
    } catch (e) { setErr(e instanceof Error ? e.message : 'Не удалось добавить прокси') }
    finally { setAdding(false) }
  }

  /** Сдвинуть всю колонку прокси на одну строку — когда списки разъехались на единицу. */
  const rotatePairs = () => setPairs((p) => (p.length ? [...p.slice(1), p[0]] : p))

  const withoutProxy = pairs.filter((p) => !p).length

  const run = async () => {
    setBusy(true); setErr('')
    try {
      const withPasswords = chosen.map((i) => {
        const typed = passwords[key(i)]?.trim()
        return typed && !i.twoFA ? { ...i, twoFA: typed } : i
      })
      const r = await runImport({
        items: withPasswords, proxyMode, singleProxy, validate, passcode: passcode || undefined, root,
        // В ручном режиме раскладка уже перед глазами оператора — шлём её как есть.
        manualProxies: proxyMode === 'manual' ? pairs : undefined,
      })
      setResults(r.results)
      setStep('result')
      if (uploadToken) { void cleanupUpload(uploadToken).catch(() => {}); setUploadToken('') }
      onImported?.()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Импорт не удался') }
    finally { setBusy(false) }
  }

  const close = () => {
    if (uploadToken) void cleanupUpload(uploadToken).catch(() => {})
    setStep('pick'); setItems([]); setResults([]); setUploadToken(''); setPasswords({}); onClose()
  }

  /** Залить выбранную папку целиком — путь для удалённого сервера. */
  const doUpload = async (files: FileList | null) => {
    if (!files?.length) return
    setUploading(true); setErr('')
    try {
      const r = await uploadFolder([...files], passcode || undefined)
      setRoot(r.root); setUploadToken(r.token)
      setItems(r.items)
      setPicked(new Set(r.items.filter((i) => !i.known).map(key)))
      setStep('found')
      if (!r.items.length) setErr('В загруженной папке не нашлось ни tdata, ни .session.')
    } catch (e) { setErr(e instanceof Error ? e.message : 'Загрузка не удалась') }
    finally { setUploading(false) }
  }

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
          {/* Главное, что человек должен понять до первого клика: разбирать пачку руками не нужно. */}
          <div className="rounded-xl border border-spark-500/25 bg-spark-500/5 p-3">
            <div className="text-sm font-semibold text-spark-200">Просто укажите папку — разберём сами</div>
            <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-white/55">
              <li>• Можно указать <b className="text-white/75">папку целиком</b>, со всеми лотами вперемешку — вложенность любая.</li>
              <li>• Сами находим <b className="text-white/75">tdata</b> и <b className="text-white/75">.session</b>, различаем форматы Telegram Desktop, Telethon и Pyrogram.</li>
              <li>• Из <b className="text-white/75">json рядом</b> подхватываем телефон, облачный пароль и прокси, если продавец их положил.</li>
              <li>• Каждому аккаунту выдаём <b className="text-white/75">свой прокси</b> и <b className="text-white/75">свой отпечаток устройства</b> — одинаковые склеили бы их в одну пачку для Telegram.</li>
              <li>• Каждый аккаунт <b className="text-white/75">проверяем заходом в Telegram</b>: в систему попадут только живые, мёртвые останутся в отчёте с причиной.</li>
            </ul>
          </div>
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

          {/* Запасной путь: если панель открыта не на той машине, где лежат аккаунты
              (удалённый сервер), папку можно залить через браузер. */}
          <div className="rounded-xl border border-line bg-elevated/40 p-3">
            <div className="text-xs text-white/45">
              Панель открыта не на том компьютере, где лежат аккаунты? Тогда папку нужно загрузить —
              это медленнее (tdata весит десятки мегабайт на аккаунт), но работает с любой машины.
            </div>
            <button onClick={() => folderRef.current?.click()} disabled={uploading} className="btn-ghost mt-2 h-9">
              {uploading ? <><Loader2 size={14} className="animate-spin" /> Загружаю…</> : <><UploadCloud size={14} /> Загрузить папку через браузер</>}
            </button>
            <input
              ref={folderRef}
              type="file"
              className="hidden"
              multiple
              // @ts-expect-error — нестандартные атрибуты выбора папки, есть во всех движках
              webkitdirectory=""
              directory=""
              onChange={(e) => void doUpload(e.target.files)}
            />
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
              <div key={key(i)} className="border-b border-line/60 last:border-0">
                <label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-elevated">
                  <input type="checkbox" checked={picked.has(key(i))} onChange={() => toggle(i)} className="h-4 w-4 accent-spark" />
                  {i.kind === 'tdata' ? <FolderOpen size={14} className="shrink-0 text-amber-300" /> : <Users size={14} className="shrink-0 text-iris-300" />}
                  <span className="truncate font-semibold text-white">{i.name}</span>
                  {i.phone && <span className="shrink-0 font-mono text-xs text-white/45">{i.phone}</span>}
                  {i.proxy && <Badge tone="iris">свой прокси</Badge>}
                  {i.twoFA && <Badge tone="spark"><KeyRound size={10} /> пароль есть</Badge>}
                  {i.known && <Badge tone="amber">уже есть</Badge>}
                </label>
                {/* Поле пароля показываем ТОЛЬКО там, где его не нашли рядом с аккаунтом:
                    у остальных спрашивать нечего. Пустое поле ничего не ломает — аккаунт
                    просто импортируется без облачного пароля. */}
                {picked.has(key(i)) && !i.twoFA && (
                  <div className="flex items-center gap-2 px-3 pb-2 pl-9">
                    <input
                      type="password"
                      className="input h-8 max-w-[220px] text-xs"
                      placeholder="Облачный пароль (если есть)"
                      value={passwords[key(i)] || ''}
                      onChange={(e) => setPasswords((p) => ({ ...p, [key(i)]: e.target.value }))}
                    />
                    <span className="text-xs text-white/30">не нашли рядом с аккаунтом</span>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <div className="mb-1 text-xs text-white/50">Прокси для пачки</div>
              <Select value={proxyMode} onChange={(v) => setProxyMode(v as ProxyMode)} options={(Object.keys(PROXY_MODE_LABELS) as ProxyMode[]).map((m) => ({ value: m, label: PROXY_MODE_LABELS[m] }))} />
              {proxyMode === 'pool' && (
                <div className={`mt-1 text-xs ${notEnoughProxies ? 'text-amber-300' : 'text-white/40'}`}>
                  Свободно прокси: {freeProxies}{notEnoughProxies ? ` — на ${chosen.length} аккаунтов не хватит, лишние будут пропущены` : ' · один прокси на один аккаунт'}
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
              <span className="text-sm font-semibold">Оставить только рабочие аккаунты</span>
              <span className="mt-0.5 block text-xs text-white/45">
                Заходим в Telegram каждой сессией — через её же прокси и с её же отпечатком устройства.
                Только так видно, что аккаунт живой; заодно подтягиваются настоящие имя, username и телефон.
                Пара секунд на аккаунт. Без проверки мёртвые сессии лягут в список наравне с рабочими,
                и вы узнаете об этом уже посреди запущенной кампании.
              </span>
            </span>
          </label>

          <div className="flex justify-end gap-2">
            <button onClick={() => setStep('pick')} className="btn-ghost h-10">Назад</button>
            {/* Раскладка «аккаунт ↔ прокси» — отдельный шаг: на нём видно обе колонки
                сразу, а не абстрактный режим в выпадающем списке. */}
            <button
              onClick={() => { setProxyMode('manual'); setStep('proxy'); void relayout(false) }}
              disabled={!chosen.length}
              className="btn-ghost h-10"
            >
              Прокси: разложить {chosen.length} <ChevronRight size={15} />
            </button>
            <button onClick={() => void run()} disabled={!chosen.length || busy} className="btn-primary h-10">
              {busy ? <><Loader2 size={15} className="animate-spin" /> Импортирую{validate ? ' и проверяю' : ''}…</> : <>Импортировать {chosen.length}</>}
            </button>
          </div>
        </div>
      )}

      {/* ── Шаг «Прокси»: сколько не хватает, добавить списком, разложить 1 к 1, поправить ── */}
      {step === 'proxy' && (
        <div className="space-y-3">
          {/* Прокси — дело добровольное, запрещать импорт мы не будем. Но риск обязан
              быть виден до нажатия кнопки, а не выясняться по спамблокам через сутки. */}
          <div className={cn(
            'rounded-xl border p-3 text-sm',
            withoutProxy > 0 ? 'border-rose-500/40 bg-rose-500/8' : 'border-line bg-elevated/40',
          )}>
            <b className="text-white">Найдено аккаунтов: {chosen.length}.</b>{' '}
            {withoutProxy > 0 ? (
              <span className="font-bold text-rose-300">
                <AlertTriangle size={13} className="mb-0.5 inline" /> Без прокси остаются: {withoutProxy} — высокий риск блокировки.
              </span>
            ) : (
              <span className="text-spark-400">Прокси хватает на всех — по одному на аккаунт.</span>
            )}
            {withoutProxy > 0 && (
              <div className="mt-1 text-xs leading-relaxed text-rose-200/70">
                Они пойдут через ваш IP — и для Telegram это одна группа: находит один
                аккаунт, изучает параметры, добивает остальных с того же адреса.
                Импортировать можно и так, но эти аккаунты живут заметно меньше.
              </div>
            )}
          </div>

          <div>
            <div className="mb-1 text-xs text-white/50">
              Вставьте прокси списком — по одному в строке. Проверим живость и настоящую страну выхода.
            </div>
            <textarea
              value={proxyText}
              onChange={(e) => setProxyText(e.target.value)}
              rows={3}
              placeholder={'socks5://user:pass@1.2.3.4:1080\n1.2.3.5:1080:user:pass'}
              className="input w-full resize-y py-2 font-mono text-xs"
            />
            <div className="mt-1.5 flex items-center gap-2">
              <button onClick={() => void addProxies()} disabled={adding || !proxyText.trim()} className="btn-primary h-9 px-3 text-sm disabled:opacity-40">
                {adding ? <><Loader2 size={14} className="animate-spin" /> Проверяю…</> : <>Проверить и добавить</>}
              </button>
              {addReport && <span className="text-xs text-white/50">{addReport}</span>}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-3">
            <span className="text-xs text-white/50">Разложить:</span>
            <button onClick={() => void relayout(false)} className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-white/70 hover:bg-elevated">
              По порядку, 1 к 1
            </button>
            <button
              onClick={() => void relayout(true)}
              title="Аккаунт из Украины через американский IP — заметная нестыковка. Если страна известна с обеих сторон, сперва свяжем по ней."
              className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-white/70 hover:bg-elevated"
            >
              По странам
            </button>
            <button onClick={rotatePairs} title="Списки разъехались на одну строку" className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-white/70 hover:bg-elevated">
              Сдвинуть на 1
            </button>
            <button onClick={() => setPairs(chosen.map(() => null))} className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-white/70 hover:bg-elevated">
              Снять все
            </button>
          </div>

          <div className="max-h-72 overflow-y-auto rounded-xl border border-line">
            {chosen.map((it, i) => {
              // Прокси, уже отданный другой строке, в этом списке не показываем:
              // «один прокси — один аккаунт» должно быть невозможно нарушить руками.
              const takenElsewhere = new Set(pairs.filter((p, j) => p && j !== i) as string[])
              const opts = pool.filter((p) => !takenElsewhere.has(p.url))
              return (
                <div key={key(it)} className="flex items-center gap-2 border-b border-line/60 px-3 py-2 text-sm last:border-0">
                  <span className="w-6 shrink-0 text-right text-xs tabular-nums text-white/30">{i + 1}</span>
                  <span className="w-40 shrink-0 truncate font-semibold text-white" title={it.name}>{it.name}</span>
                  {it.phone && <span className="w-32 shrink-0 font-mono text-xs text-white/40">{it.phone}</span>}
                  <Select
                    value={pairs[i] || ''}
                    onChange={(v) => setPairs((prev) => { const n = [...prev]; n[i] = v || null; return n })}
                    placeholder="Без прокси"
                    options={[
                      { value: '', label: 'Без прокси' },
                      ...opts.map((p) => ({
                        value: p.url,
                        label: `${p.url.replace(/^\w+:\/\/[^@]*@/, '')}${p.country ? ` · ${p.country.toUpperCase()}` : ''}${p.status === 'dead' ? ' · мёртвый' : ''}`,
                      })),
                    ]}
                  />
                </div>
              )
            })}
          </div>

          <div className="flex justify-end gap-2">
            <button onClick={() => setStep('found')} className="btn-ghost h-10">Назад</button>
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
            {results.some((r) => r.has2fa) && <Badge tone="iris"><KeyRound size={10} /> с паролем: {results.filter((r) => r.has2fa).length}</Badge>}
          </div>
          {results.some((r) => r.needsPassword) && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-relaxed text-amber-200">
              У {results.filter((r) => r.needsPassword).length} аккаунтов включён облачный пароль, но самого пароля у нас нет.
              Работать они будут, а вот восстановить их не выйдет, если сессия отвалится. Пароли можно дописать позже —
              положите их в <b>password.txt</b> рядом с аккаунтом и импортируйте повторно.
            </div>
          )}
          <div className="max-h-64 overflow-y-auto rounded-xl border border-line">
            {results.map((r, i) => (
              <div key={i} className="flex items-center gap-2 border-b border-line/60 px-3 py-2 text-sm last:border-0">
                {r.ok ? <Check size={13} className="shrink-0 text-spark-400" /> : <AlertTriangle size={13} className="shrink-0 text-rose-400" />}
                <span className="truncate font-semibold text-white">{r.name}</span>
                {r.phone && <span className="shrink-0 font-mono text-xs text-white/45">{r.phone}</span>}
                {r.has2fa && <KeyRound size={11} className="shrink-0 text-spark-400" aria-label="пароль сохранён" />}
                {r.needsPassword && <AlertTriangle size={11} className="shrink-0 text-amber-400" aria-label="2FA включена, пароля нет" />}
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
