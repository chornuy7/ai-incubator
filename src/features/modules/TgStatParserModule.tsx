import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  UploadCloud, ShieldCheck, KeyRound, RefreshCw, Plus, Search, Download, Trash2,
  ExternalLink, StopCircle, CheckCircle2, XCircle, Clock, Loader2, Database, Cookie, AlertTriangle,
} from 'lucide-react'
import { useApp } from '@/mocks/store'
import { Select, Segmented, Badge, EmptyState } from '@/shared/ui'
import { cn } from '@/shared/lib/utils'
import { TgStatSearchPanel } from './TgStatSearchPanel'
import {
  fetchTgstatOptions, fetchTgstatSession, uploadTgstatSession, verifyTgstatSession, clearTgstatSession,
  fetchTgstatImports, createTgstatImport, fetchTgstatChats, cancelTgstatImport, deleteTgstatImport, tgstatExportUrl,
  type TgstatOptions, type TgstatSession, type TgstatImport, type TgstatChat, type TgstatImportStatus,
} from '@/api/tgstatApi'

const COOKIE_EDITOR_URL = 'https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm'
const DEFAULT_REGION = 'ukraine'

const STATUS_META: Record<TgstatImportStatus, { tone: 'muted' | 'amber' | 'spark' | 'rose' | 'iris'; label: string; icon: React.ReactNode }> = {
  queued: { tone: 'muted', label: 'В очереди', icon: <Clock size={13} /> },
  running: { tone: 'iris', label: 'Парсинг…', icon: <Loader2 size={13} className="animate-spin" /> },
  completed: { tone: 'spark', label: 'Готово', icon: <CheckCircle2 size={13} /> },
  failed: { tone: 'rose', label: 'Ошибка', icon: <XCircle size={13} /> },
  cancelled: { tone: 'amber', label: 'Отменено', icon: <StopCircle size={13} /> },
}

const fmtNum = (n: number) => new Intl.NumberFormat('ru-RU').format(n || 0)
function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** Cookie-Editor export / Playwright storage_state / {cookies:[...]} → {cookies:[...]}. */
function parseSessionJson(text: string): { cookies: unknown[] } {
  const cleaned = text.replace(/^﻿/, '').trim()
  if (!cleaned) throw new Error('Файл пустой.')
  let raw: unknown
  try { raw = JSON.parse(cleaned) } catch { throw new Error('Не JSON. Cookie-Editor → Export → JSON.') }
  if (Array.isArray(raw)) return { cookies: raw }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    if (o.storage_state && typeof o.storage_state === 'object' && Array.isArray((o.storage_state as Record<string, unknown>).cookies)) return o.storage_state as { cookies: unknown[] }
    if (o.data && typeof o.data === 'object' && Array.isArray((o.data as Record<string, unknown>).cookies)) return { cookies: (o.data as Record<string, unknown>).cookies as unknown[] }
    if (Array.isArray(o.cookies)) return { cookies: o.cookies }
  }
  throw new Error('В файле нет cookies. Экспортируйте их Cookie-Editor на uk.tgstat.com.')
}

/** Амбер-карточка (визуально отделяет блок TGStat). */
function AmberCard({ icon, title, badge, right, children }: {
  icon: React.ReactNode; title: string; badge?: string; right?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <div className="rounded-2xl border border-amber-500/30 bg-surface shadow-card">
      <div className="flex flex-wrap items-center gap-3 border-b border-amber-500/20 px-4 py-3.5">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-amber-500/12 text-amber-300">{icon}</span>
        <span className="font-display text-base font-bold text-fg">{title}</span>
        {badge && <span className="rounded-md bg-amber-500/12 px-2 py-0.5 text-xs font-bold text-amber-300">{badge}</span>}
        {right && <div className="ml-auto">{right}</div>}
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

export function TgStatParserModule() {
  const pushToast = useApp((s) => s.pushToast)
  const [tgMode, setTgMode] = useState(0) // 0 — каталог по категориям, 1 — расширенный поиск
  const [options, setOptions] = useState<TgstatOptions | null>(null)
  const [session, setSession] = useState<TgstatSession | null>(null)
  const [imports, setImports] = useState<TgstatImport[]>([])
  const [uploading, setUploading] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [creating, setCreating] = useState(false)

  const [category, setCategory] = useState('')
  const [region, setRegion] = useState(DEFAULT_REGION)
  const [maxPages, setMaxPages] = useState<number | ''>(3)
  const [minSubs, setMinSubs] = useState<number | ''>(0)
  const mp = typeof maxPages === 'number' && maxPages > 0 ? maxPages : 1
  const ms = typeof minSubs === 'number' ? minSubs : 0

  const [openImport, setOpenImport] = useState<TgstatImport | null>(null)
  const [chats, setChats] = useState<TgstatChat[]>([])
  const [chatsLoading, setChatsLoading] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')

  const fileRef = useRef<HTMLInputElement>(null)

  const loadSession = useCallback(() => { void fetchTgstatSession().then(setSession).catch(() => {}) }, [])
  const loadImports = useCallback(() => { void fetchTgstatImports().then(setImports).catch(() => {}) }, [])

  useEffect(() => {
    void fetchTgstatOptions().then((o) => { setOptions(o); if (o.categories[0] && !category) setCategory(o.categories[0].slug) }).catch(() => {})
    loadSession()
    loadImports()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // polling пока есть незавершённые импорты
  const hasRunning = imports.some((i) => i.status === 'queued' || i.status === 'running')
  useEffect(() => {
    if (!hasRunning) return
    const id = setInterval(loadImports, 4000)
    return () => clearInterval(id)
  }, [hasRunning, loadImports])

  const sessionReady = session?.has_session === true && session.status === 'active' && Boolean(session.last_verified_at)
  const itemsPerStep = options?.catalog_items_per_step ?? 100

  const catLabel = useMemo(() => new Map((options?.categories ?? []).map((c) => [c.slug, c.label])), [options])
  const regLabel = useMemo(() => new Map((options?.regions ?? []).map((r) => [r.slug, r.label])), [options])

  const submitCookiesJson = async (text: string) => {
    setUploading(true)
    try {
      const parsed = parseSessionJson(text)
      const s = await uploadTgstatSession(parsed)
      setSession(s)
      pushToast({ type: 'success', title: 'Cookies сохранены', desc: `${parsed.cookies.length} шт. Проверяем…` })
      const res = await verifyTgstatSession(region)
      pushToast({ type: res.ok ? 'success' : 'error', title: res.ok ? 'Сессия работает' : 'Проверка не пройдена', desc: res.message })
      loadSession()
      return true
    } catch (e) {
      pushToast({ type: 'error', title: 'Ошибка загрузки', desc: e instanceof Error ? e.message : '' })
      return false
    } finally { setUploading(false) }
  }

  const handleFile = async (file: File) => { await submitCookiesJson(await file.text()) }

  const handlePasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (!text.trim()) return pushToast({ type: 'error', title: 'Буфер пуст', desc: 'Скопируйте cookies (Cookie-Editor → Export).' })
      await submitCookiesJson(text)
    } catch {
      // clipboard API недоступен (нет фокуса/прав) — открываем ручную вставку
      setPasteOpen(true)
      pushToast({ type: 'info', title: 'Вставьте JSON вручную', desc: 'Браузер не дал доступ к буферу — вставьте в поле ниже.' })
    }
  }

  const handlePasteText = async () => {
    if (!pasteText.trim()) return pushToast({ type: 'error', title: 'Пустое поле' })
    if (await submitCookiesJson(pasteText)) { setPasteText(''); setPasteOpen(false) }
  }

  const handleVerify = async () => {
    setVerifying(true)
    try {
      const res = await verifyTgstatSession(region)
      pushToast({ type: res.ok ? 'success' : 'error', title: res.ok ? 'Сессия работает' : 'Не пройдена', desc: res.message })
      loadSession()
    } catch (e) { pushToast({ type: 'error', title: 'Ошибка', desc: e instanceof Error ? e.message : '' }) } finally { setVerifying(false) }
  }

  const handleClear = async () => {
    try { setSession(await clearTgstatSession()); pushToast({ type: 'info', title: 'Сессия TGStat удалена' }) }
    catch { pushToast({ type: 'error', title: 'Не удалось удалить' }) }
  }

  const handleCreate = async () => {
    if (!category) return pushToast({ type: 'error', title: 'Выберите категорию' })
    if (mp > 1 && !session?.telegram_logged_in) {
      pushToast({ type: 'error', title: `Для >${itemsPerStep} каналов нужен вход в TGStat через Telegram (cookies с tgstat_sirk)` })
      return
    }
    setCreating(true)
    try {
      const imp = await createTgstatImport({ category, region: region || null, max_pages: mp, min_subscribers: ms })
      setImports((p) => [imp, ...p])
      pushToast({ type: 'success', title: `Импорт #${imp.id} запущен`, desc: 'Парсинг на сервере' })
    } catch (e) { pushToast({ type: 'error', title: 'Ошибка запуска', desc: e instanceof Error ? e.message : '' }) } finally { setCreating(false) }
  }

  const openChats = async (imp: TgstatImport) => {
    setOpenImport(imp); setChatsLoading(true)
    try { setChats(await fetchTgstatChats(imp.id)) } catch { pushToast({ type: 'error', title: 'Не удалось загрузить результаты' }) } finally { setChatsLoading(false) }
  }
  const handleCancel = async (id: number) => { try { const u = await cancelTgstatImport(id); setImports((p) => p.map((i) => (i.id === id ? u : i))); pushToast({ type: 'info', title: 'Импорт отменён' }) } catch { pushToast({ type: 'error', title: 'Не удалось отменить' }) } }
  const handleDelete = async (id: number) => { try { await deleteTgstatImport(id); setImports((p) => p.filter((i) => i.id !== id)); if (openImport?.id === id) setOpenImport(null); pushToast({ type: 'success', title: 'Импорт удалён' }) } catch { pushToast({ type: 'error', title: 'Не удалось удалить' }) } }

  return (
    <div className="space-y-4">
      {/* Баннер режима */}
      <div className="flex items-center gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/8 p-4">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-amber-500/15 text-amber-300"><Cookie size={20} /></span>
        <div>
          <div className="font-display font-bold text-fg">Парсер каналов TGStat</div>
          <div className="text-xs text-muted">Массовый парсинг каталога TGStat по категориям и регионам через cookies-сессию. Не требует Telegram-аккаунтов панели.</div>
        </div>
        <div className="ml-auto">
          {sessionReady ? <Badge tone="spark"><CheckCircle2 size={12} /> Подключён</Badge> : <Badge tone="amber"><AlertTriangle size={12} /> Не подключён</Badge>}
        </div>
      </div>

      <input ref={fileRef} type="file" accept=".json,.txt,application/json,text/plain" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = '' }} />

      <Segmented options={['Каталог по категориям', 'Расширенный поиск (фильтры)']} value={tgMode} onChange={setTgMode} />

      {/* Инструкция + загрузка cookies */}
      <AmberCard icon={<Cookie size={18} />} title="Этап 1 — подключить TGStat" badge={sessionReady ? 'готово' : 'обязательно'}>
        <ol className="mb-4 list-decimal space-y-1.5 pl-5 text-sm text-muted">
          <li>В Chrome откройте <a href="https://uk.tgstat.com/login" target="_blank" rel="noreferrer" className="text-amber-300 hover:underline">uk.tgstat.com</a> и войдите через Telegram (@tg_analytics_bot → START).</li>
          <li>Установите расширение <a href={COOKIE_EDITOR_URL} target="_blank" rel="noreferrer" className="text-amber-300 hover:underline">Cookie-Editor</a>.</li>
          <li>На странице TGStat: Cookie-Editor → <b className="text-fg">Export</b> → формат <b className="text-fg">JSON</b> → сохраните файл.</li>
          <li>Загрузите этот JSON кнопкой ниже.</li>
        </ol>
        <div className="grid gap-2 sm:grid-cols-2">
          <button type="button" onClick={handlePasteFromClipboard} disabled={uploading}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 py-3 font-bold text-[#1a1200] transition-opacity hover:opacity-90 disabled:opacity-50">
            {uploading ? <Loader2 size={17} className="animate-spin" /> : <Cookie size={17} />}
            Вставить JSON из буфера
          </button>
          <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/12 py-3 font-bold text-amber-200 transition-colors hover:bg-amber-500/20 disabled:opacity-50">
            <UploadCloud size={17} /> {session?.has_session ? 'Заменить файлом' : 'Загрузить файл (JSON)'}
          </button>
        </div>
        <button type="button" onClick={() => setPasteOpen((v) => !v)} className="mt-2 text-xs font-semibold text-amber-300 hover:underline">
          {pasteOpen ? 'Скрыть ручную вставку' : 'или вставить JSON вручную →'}
        </button>
        {pasteOpen && (
          <div className="mt-2 space-y-2">
            <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} rows={4}
              className="input resize-none font-mono text-xs" placeholder='[{"name":"tgstat_sirk","value":"…","domain":".tgstat.ru"}, …]' />
            <button type="button" onClick={handlePasteText} disabled={uploading || !pasteText.trim()}
              className="btn-primary h-9 text-sm disabled:opacity-40">{uploading ? <Loader2 size={15} className="animate-spin" /> : <UploadCloud size={15} />} Загрузить вставленный JSON</button>
          </div>
        )}
        <p className="mt-2 text-center text-xs text-muted">Cookie-Editor → Export (в буфер) → сюда. Или файл .json/.txt. Cookies хранятся локально.</p>
      </AmberCard>

      {/* Статус сессии */}
      <AmberCard icon={<ShieldCheck size={18} />} title="Статус подключения TGStat"
        right={<button onClick={loadSession} className="btn-icon h-8 w-8"><RefreshCw size={14} /></button>}>
        {session ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={session.status === 'active' ? 'spark' : session.status === 'error' ? 'rose' : 'muted'}>
                {session.status === 'active' ? 'Активна' : session.status === 'error' ? 'Ошибка' : session.status === 'expired' ? 'Истекла' : 'Не настроена'}
              </Badge>
              {session.has_session && (
                <Badge tone={session.telegram_logged_in ? 'spark' : 'amber'}>
                  {session.telegram_logged_in ? 'Telegram на TGStat ✓' : 'Нет входа — лимит ~100'}
                </Badge>
              )}
              {session.cookie_count > 0 && <Badge tone="muted">{session.cookie_count} cookies</Badge>}
              {sessionReady && <Badge tone="spark">Можно парсить</Badge>}
            </div>
            {session.error_msg && (
              <div className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/8 p-3 text-sm text-rose-300">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {session.error_msg}
              </div>
            )}
            {session.has_session && !sessionReady && !session.error_msg && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 p-3 text-sm text-amber-200">Cookies загружены — нажмите «Проверить сессию» (регион должен совпадать с зеркалом входа).</div>
            )}
            <div className="flex flex-wrap gap-2">
              <button onClick={() => fileRef.current?.click()} className="btn-ghost h-9 text-sm"><UploadCloud size={15} /> {sessionReady ? 'Заменить' : 'Загрузить'} cookies</button>
              <button onClick={handleVerify} disabled={!session.has_session || verifying} className="btn-soft h-9 text-sm disabled:opacity-40">{verifying ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />} Проверить сессию</button>
              <button onClick={handleClear} disabled={!session.has_session} className="btn-ghost h-9 text-sm text-rose-300 disabled:opacity-40"><KeyRound size={15} /> Сбросить</button>
            </div>
          </div>
        ) : <div className="flex justify-center py-6"><Loader2 className="animate-spin text-muted" /></div>}
      </AmberCard>

      {tgMode === 1 && <TgStatSearchPanel />}

      {tgMode === 0 && (<>
      {/* Новый импорт */}
      <AmberCard icon={<Plus size={18} />} title="Этап 2 — новый импорт">
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <label className="label">Категория *</label>
            <Select value={category} onChange={setCategory} placeholder="Выберите категорию"
              options={(options?.categories ?? []).map((c) => ({ value: c.slug, label: c.label }))} />
          </div>
          <div>
            <label className="label">Регион</label>
            <Select value={region} onChange={setRegion}
              options={(options?.regions ?? []).map((r) => ({ value: r.slug, label: r.label }))} />
          </div>
          <div>
            <label className="label">Сколько страниц парсить (≈{itemsPerStep}/шаг)</label>
            <input type="number" min={1} max={100} value={maxPages} onChange={(e) => setMaxPages(e.target.value === "" ? "" : Math.max(1, Math.min(100, Number(e.target.value))))} className="input h-10" />
            {mp > 1 && !session?.telegram_logged_in && (
              <p className="mt-1 text-xs text-amber-300">Для &gt;1 страницы нужен вход в TGStat через Telegram (cookies с tgstat_sirk).</p>
            )}
          </div>
          <div>
            <label className="label">Минимум подписчиков</label>
            <input type="number" min={0} step={100} value={minSubs} onChange={(e) => setMinSubs(e.target.value === "" ? "" : Math.max(0, Number(e.target.value)))} className="input h-10" />
          </div>
        </div>
        {(() => {
          const disabled = creating || !sessionReady || !category
          return (
            <button onClick={handleCreate} disabled={disabled}
              className={cn(
                'mt-4 flex w-full items-center justify-center gap-2 rounded-xl py-3 font-bold transition-opacity',
                disabled ? 'cursor-not-allowed border border-line bg-elevated text-muted' : 'text-[#1a1200] hover:opacity-90',
              )}
              style={disabled ? undefined : { background: 'linear-gradient(90deg, #f59e0b, #fbbf24)' }}>
              {creating ? <Loader2 size={17} className="animate-spin" /> : <Plus size={17} />} Запустить импорт
            </button>
          )
        })()}
        {!sessionReady && <p className="mt-2 text-center text-xs text-amber-300">Сначала подключите и проверьте сессию TGStat (этап 1) — кнопка станет активной.</p>}
        {sessionReady && <p className="mt-2 text-center text-xs text-muted">После запуска результаты появятся ниже в блоке «История импортов» (🔍 — открыть, ⭳ — экспорт CSV).</p>}
      </AmberCard>

      {/* История импортов */}
      <AmberCard icon={<Database size={18} />} title={`История импортов (${imports.length})`}
        right={<button onClick={loadImports} className="btn-icon h-8 w-8"><RefreshCw size={14} /></button>}>
        {imports.length === 0 ? (
          <EmptyState icon={<Database size={22} />} title="Импортов пока нет" desc="Подключите TGStat и запустите импорт по категории." />
        ) : (
          <div className="space-y-2">
            {imports.map((imp) => {
              const m = STATUS_META[imp.status]
              const pct = imp.status === 'running' && imp.max_pages > 0 ? Math.min(100, Math.round((imp.pages_processed / imp.max_pages) * 100)) : imp.status === 'completed' ? 100 : 0
              return (
                <div key={imp.id} className="rounded-2xl border border-line bg-elevated/40 p-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-fg">{catLabel.get(imp.category) ?? imp.category}</span>
                        <Badge tone={m.tone}>{m.icon} {m.label}</Badge>
                      </div>
                      <div className="text-xs text-muted">
                        {regLabel.get(imp.region ?? '') ?? imp.region ?? 'Все регионы'} · {imp.pages_processed}/{imp.max_pages} стр.
                        {imp.min_subscribers > 0 && ` · ≥ ${fmtNum(imp.min_subscribers)} подп.`} · {fmtDate(imp.created_at)}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className={cn('font-display text-lg font-bold', imp.total_found === 0 && imp.status !== 'running' && imp.status !== 'queued' ? 'text-rose-300' : 'text-fg')}>{fmtNum(imp.total_found)}</div>
                      <div className="text-[10px] uppercase text-muted">найдено</div>
                    </div>
                    <div className="flex items-center gap-1">
                      {(imp.status === 'completed' || imp.status === 'cancelled' || imp.status === 'failed') && imp.total_found > 0 && (
                        <button onClick={() => openChats(imp)} className="btn-icon h-9 w-9" title="Результаты"><Search size={15} /></button>
                      )}
                      {imp.status === 'completed' && imp.total_found > 0 && (
                        <a href={tgstatExportUrl(imp.id)} className="btn-icon h-9 w-9" title="Скачать CSV"><Download size={15} /></a>
                      )}
                      {(imp.status === 'queued' || imp.status === 'running') && (
                        <button onClick={() => handleCancel(imp.id)} className="btn-icon h-9 w-9" title="Отменить"><StopCircle size={15} /></button>
                      )}
                      {imp.status !== 'running' && imp.status !== 'queued' && (
                        <button onClick={() => handleDelete(imp.id)} className="btn-icon h-9 w-9 text-rose-300" title="Удалить"><Trash2 size={15} /></button>
                      )}
                    </div>
                  </div>
                  {(imp.status === 'running' || imp.status === 'completed') && (
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-line"><div className={cn('h-full rounded-full transition-all', imp.status === 'running' ? 'bg-amber-400' : 'bg-spark-gradient')} style={{ width: `${pct}%` }} /></div>
                  )}
                  {imp.error_msg && <div className={cn('mt-2 text-xs', imp.error_msg.startsWith('Частично') ? 'text-amber-300' : 'text-rose-300')}>{imp.error_msg}</div>}
                </div>
              )
            })}
          </div>
        )}
      </AmberCard>

      {/* Результаты выбранного импорта */}
      {openImport && (
        <AmberCard icon={<Search size={18} />} title={`Результаты · ${catLabel.get(openImport.category) ?? openImport.category}`} badge={`${chats.length}`}
          right={<button onClick={() => setOpenImport(null)} className="btn-icon h-8 w-8"><XCircle size={15} /></button>}>
          {chatsLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="animate-spin text-muted" /></div>
          ) : chats.length === 0 ? (
            <EmptyState icon={<Search size={22} />} title="Пусто" desc="В этом импорте нет каналов." />
          ) : (
            <>
              <div className="mb-3 flex justify-end">
                <a href={tgstatExportUrl(openImport.id)} className="btn-primary h-9 text-sm"><Download size={15} /> Экспорт CSV</a>
              </div>
              <div className="max-h-[28rem] space-y-2 overflow-y-auto">
                {chats.map((c) => (
                  <div key={c.id} className="flex items-center gap-3 rounded-xl border border-line bg-elevated/40 p-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-amber-500/12 text-amber-300"><Database size={16} /></span>
                    <div className="min-w-0 flex-1">
                      <a href={c.chat_link} target="_blank" rel="noreferrer" className="truncate font-semibold text-fg hover:text-amber-300">{c.chat_name}</a>
                      <div className="text-xs text-muted">{c.chat_username && <span className="text-iris-300/80">@{c.chat_username}</span>} {c.category && `· ${c.category}`} {c.region && `· ${c.region}`}</div>
                    </div>
                    <div className="text-right text-sm"><div className="font-bold text-fg">{fmtNum(c.subscribers)}</div><div className="text-[10px] uppercase text-muted">подп.</div></div>
                    <a href={c.chat_link} target="_blank" rel="noreferrer" className="btn-icon h-9 w-9 shrink-0" title="Открыть в Telegram"><ExternalLink size={15} /></a>
                  </div>
                ))}
              </div>
            </>
          )}
        </AmberCard>
      )}
      </>)}
    </div>
  )
}
