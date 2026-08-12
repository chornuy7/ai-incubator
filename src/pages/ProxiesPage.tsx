import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Network, Plus, Trash2, Pencil, Link2, Check, Circle, Zap, Loader2, MapPin, Upload, Skull, RotateCcw } from 'lucide-react'
import { PageHeader, Card, EmptyState, Badge, Select, Modal } from '@/shared/ui'
import { HelpButton } from '@/features/neuro-commenting/moduleUi'
import {
  fetchProxies, createProxy, updateProxy, deleteProxy, toProxyUrl, checkProxy, checkAllProxies,
  PROXY_KIND_LABELS, type Proxy, type ProxyKind, type ProxyGeo,
} from '@/api/proxiesApi'
import { fetchAccounts, patchAccount } from '@/api/accountsApi'
import type { TgAccount } from '@/shared/types'
import { FLAGS } from '@/shared/config/geo'
import { confirmDialog } from '@/shared/lib/dialog'
import { cn } from '@/shared/lib/utils'
import { ImportProxiesModal } from '@/features/import-proxies/ImportProxiesModal'

const STATUS_META: Record<Proxy['status'], { label: string; tone: 'spark' | 'rose' | 'amber' | 'muted'; hint?: string }> = {
  ok: { label: 'Рабочий', tone: 'spark', hint: 'Через прокси удалось выйти в интернет' },
  bad: { label: 'Не тот протокол', tone: 'amber', hint: 'Порт открыт, но выйти наружу не удалось — обычно помогает сменить схему http ↔ socks5' },
  dead: { label: 'Мёртвый', tone: 'rose', hint: 'Хост не отвечает' },
  unknown: { label: 'Не проверен', tone: 'muted' },
}

const emptyForm = (): Partial<Proxy> => ({ label: '', kind: 'static', scheme: 'socks5', host: '', port: 1080, username: '', password: '', country: '', note: '', status: 'unknown' })

export function ProxiesPage() {
  const [proxies, setProxies] = useState<Proxy[]>([])
  const [accounts, setAccounts] = useState<TgAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState<Proxy | null>(null)
  const [form, setForm] = useState<Partial<Proxy>>(emptyForm())
  const [saving, setSaving] = useState(false)
  const [assignFor, setAssignFor] = useState<Proxy | null>(null)
  const [detailProxy, setDetailProxy] = useState<Proxy | null>(null)
  const [geoMap, setGeoMap] = useState<Record<string, ProxyGeo | null>>({})
  const [geoSrcMap, setGeoSrcMap] = useState<Record<string, 'exit' | 'gateway' | null>>({})
  const [testing, setTesting] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)

  const doTest = async (p: Proxy) => {
    setTesting(p.id)
    try {
      const { proxy, geo, geoSource } = await checkProxy(p.id)
      setProxies((list) => list.map((x) => (x.id === p.id ? proxy : x)))
      setGeoMap((m) => ({ ...m, [p.id]: geo }))
      setGeoSrcMap((m) => ({ ...m, [p.id]: geoSource ?? null }))
    } catch { setGeoMap((m) => ({ ...m, [p.id]: null })) }
    finally { setTesting(null) }
  }

  // silent — фоновое обновление: список не гасим «Загрузкой», иначе экран моргал бы
  // заглушкой каждые полминуты.
  async function load(opts?: { silent?: boolean }) {
    if (!opts?.silent) setLoading(true)
    try {
      const [px, accs] = await Promise.all([fetchProxies(), fetchAccounts().catch(() => [])])
      setProxies(px); setAccounts(accs)
    } catch (e) { if (!opts?.silent) setErr(e instanceof Error ? e.message : 'Ошибка загрузки') }
    finally { if (!opts?.silent) setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  // Автообновление: статусы меняет и фоновый чекер сервера (раз в 30 мин), и ручные
  // тесты, и живая работа аккаунтов — страница обязана показывать свежее сама.
  const [autoRefresh, setAutoRefresh] = useState(true)
  useEffect(() => {
    if (!autoRefresh) return
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void load({ silent: true })
    }, 30000)
    return () => clearInterval(id)
  }, [autoRefresh])

  /** Проверить весь каталог разом — «нерабочие» обновятся без ручного тыка по каждому. */
  const [checkingAll, setCheckingAll] = useState(false)
  async function testAll() {
    setCheckingAll(true)
    try { await checkAllProxies(); await load({ silent: true }) }
    catch (e) { setErr(e instanceof Error ? e.message : 'Ошибка проверки') }
    finally { setCheckingAll(false) }
  }

  // Рабочие / нерабочие / не проверены. «Нерабочие» — это и мёртвые, и те, что не
  // говорят своим протоколом: и то и другое аккаунту одинаково бесполезно.
  const [statusFilter, setStatusFilter] = useState<'all' | 'ok' | 'broken' | 'unknown'>('all')
  const counts = useMemo(() => ({
    all: proxies.length,
    ok: proxies.filter((p) => p.status === 'ok').length,
    broken: proxies.filter((p) => p.status === 'dead' || p.status === 'bad').length,
    unknown: proxies.filter((p) => p.status === 'unknown').length,
  }), [proxies])
  const visible = useMemo(() => proxies.filter((p) => (
    statusFilter === 'all' ? true
      : statusFilter === 'ok' ? p.status === 'ok'
        : statusFilter === 'broken' ? (p.status === 'dead' || p.status === 'bad')
          : p.status === 'unknown'
  )), [proxies, statusFilter])

  const usedBy = useMemo(() => {
    const m: Record<string, number> = {}
    for (const p of proxies) m[p.id] = accounts.filter((a) => a.proxy && a.proxy === toProxyUrl(p)).length
    return m
  }, [proxies, accounts])

  function openNew() { setEditing(null); setForm(emptyForm()); setEditOpen(true); setErr('') }
  function openEdit(p: Proxy) { setEditing(p); setForm({ ...p }); setEditOpen(true); setErr('') }

  async function save() {
    setSaving(true); setErr('')
    try {
      let saved: Proxy
      if (editing) { saved = await updateProxy(editing.id, form); setProxies((prev) => prev.map((x) => (x.id === saved.id ? saved : x))) }
      else { saved = await createProxy(form); setProxies((prev) => [saved, ...prev]) }
      setEditOpen(false)
      void doTest(saved) // авто-определение статуса и страны (выбирать вручную не нужно)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Ошибка') }
    finally { setSaving(false) }
  }

  // MR-133: пометить/«убить» прокси вручную (dead) — сразу перестаёт предлагаться аккаунтам,
  // не дожидаясь автотеста. Повторный клик снимает пометку (возврат в «Не проверен»).
  async function toggleDead(p: Proxy) {
    const next: Proxy['status'] = p.status === 'dead' ? 'unknown' : 'dead'
    try {
      const saved = await updateProxy(p.id, { status: next })
      setProxies((prev) => prev.map((x) => (x.id === saved.id ? saved : x)))
    } catch (e) { setErr(e instanceof Error ? e.message : 'Ошибка') }
  }

  async function remove(p: Proxy) {
    if (!(await confirmDialog({ title: 'Удалить прокси?', message: `${p.host}:${p.port} будет удалён. Аккаунты, использующие его, останутся с этой строкой подключения.`, confirmLabel: 'Удалить', tone: 'danger' }))) return
    try { await deleteProxy(p.id); setProxies((prev) => prev.filter((x) => x.id !== p.id)) }
    catch (e) { setErr(e instanceof Error ? e.message : 'Ошибка') }
  }

  const set = (k: keyof Proxy, v: unknown) => setForm((f) => ({ ...f, [k]: v }))

  return (
    <div>
      <PageHeader
        title="Прокси"
        subtitle="Каталог прокси (статические / мобильные / своя ферма) и привязка к аккаунтам."
        icon={<Network size={22} />}
        badge={proxies.length ? `${proxies.length}` : undefined}
        actions={(
          <div className="flex items-center gap-2">
            <HelpButton topic="proxy-policy" className="h-10 w-10" />
            <button onClick={() => void testAll()} disabled={checkingAll || proxies.length === 0} className="btn-ghost h-10 disabled:opacity-50" title="Проверить весь каталог: нерабочие пометятся сразу">
              {checkingAll ? <Loader2 size={16} className="animate-spin" /> : <Zap size={16} />} Проверить все
            </button>
            <button onClick={() => setImportOpen(true)} className="btn-ghost h-10"><Upload size={16} /> Импорт списком</button>
            <button onClick={openNew} className="btn-primary h-10"><Plus size={16} /> Новый прокси</button>
          </div>
        )}
      />

      {err && !editOpen && <Card className="mb-3 border-rose-500/30 p-3 text-sm text-rose-300">{err}</Card>}

      {/* Фильтр «рабочие / нерабочие» + автообновление: статус прокси живёт своей жизнью
          (фоновый чекер, работа аккаунтов), и страница обязана показывать свежее. */}
      {proxies.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {([
            { key: 'all', label: 'Все', n: counts.all },
            { key: 'ok', label: 'Рабочие', n: counts.ok },
            { key: 'broken', label: 'Нерабочие', n: counts.broken },
            { key: 'unknown', label: 'Не проверены', n: counts.unknown },
          ] as const).map((f) => (
            <button
              key={f.key}
              onClick={() => setStatusFilter(f.key)}
              className={cn(
                'inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition-colors',
                statusFilter === f.key ? 'border-spark-500/40 bg-spark-500/12 text-spark-300' : 'border-line text-muted hover:text-fg',
                f.key === 'broken' && f.n > 0 && statusFilter !== f.key && 'text-rose-300',
              )}
            >
              {f.label}
              <span className={cn('rounded px-1.5 py-0.5 text-[10px]', f.key === 'broken' && f.n > 0 ? 'bg-rose-500/20 text-rose-200' : 'bg-elevated text-muted')}>{f.n}</span>
            </button>
          ))}
          <label className="ml-auto flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted" title="Обновлять список каждые 30 секунд">
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} className="accent-spark-500" />
            Автообновление
          </label>
        </div>
      )}

      {loading ? (
        <Card className="p-6 text-sm text-white/50">Загрузка…</Card>
      ) : proxies.length === 0 ? (
        <EmptyState icon={<Network size={26} />} title="Прокси пока нет" desc="Добавьте прокси и назначайте их аккаунтам в менеджере." />
      ) : visible.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted">
          {statusFilter === 'broken' ? 'Нерабочих прокси нет — все живые.' : 'В этой выборке пусто.'}
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((p) => {
            const sm = STATUS_META[p.status]
            return (
              <Card key={p.id} className="flex flex-wrap items-center gap-3 p-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-iris-500/12 text-iris-300"><Network size={18} /></span>
                <div role="button" tabIndex={0} onClick={() => setDetailProxy(p)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetailProxy(p) } }} className="group min-w-0 flex-1 cursor-pointer text-left" title="Открыть детали прокси">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-semibold text-fg group-hover:text-spark-300">{p.label || `${p.host}:${p.port}`}</span>
                    <Badge tone="iris">{PROXY_KIND_LABELS[p.kind]}</Badge>
                    {p.country && (
                      // Гео по шлюзу — это страна дата-центра, а не выхода: у мобильных
                      // прокси они разные, и раздавать такой прокси «по стране» опасно.
                      <span className="text-sm" title={p.geoSource === 'gateway' ? 'Страна определена по адресу сервера — приблизительно' : p.geoSource === 'exit' ? 'Страна реального выходного IP' : ''}>
                        {FLAGS[p.country] || p.country.toUpperCase()}
                        {p.geoSource === 'gateway' && <span className="ml-0.5 text-[10px] text-amber-300">≈</span>}
                      </span>
                    )}
                    <Badge tone={sm.tone}>{sm.label}</Badge>
                    {/* Дубли разрешены: сколько аккаунтов сидит на этом прокси. */}
                    {(p.usedBy ?? 0) > 0 && <span title="На скольких аккаунтах висит этот прокси"><Badge tone="iris">занят {p.usedBy}</Badge></span>}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-xs text-white/50">{p.scheme}://{p.username ? `${p.username}@` : ''}{p.host}:{p.port}</div>
                  {geoMap[p.id] && (
                    <div className="mt-0.5 flex items-center gap-1 truncate text-xs text-spark-300">
                      <MapPin size={11} className="shrink-0" /> {FLAGS[geoMap[p.id]!.country] || ''} {geoMap[p.id]!.countryName}{geoMap[p.id]!.city ? `, ${geoMap[p.id]!.city}` : ''}{geoMap[p.id]!.isp ? ` · ${geoMap[p.id]!.isp}` : ''}
                      {/* §10: «выход» было непонятно — пишем словами, что именно за гео показано. */}
                      {geoSrcMap[p.id] === 'exit'
                        ? <span className="shrink-0 rounded bg-spark-500/15 px-1 text-[10px] font-semibold text-spark-300" title="Это гео РЕАЛЬНОГО IP, с которого Telegram видит аккаунт: мы сходили в интернет через сам прокси и определили его выходной адрес. Именно оно важно для антифрода.">гео реального IP</span>
                        : geoSrcMap[p.id] === 'gateway'
                          ? <span className="shrink-0 rounded bg-amber-500/15 px-1 text-[10px] font-semibold text-amber-300" title="Выходной IP определить не удалось — показано гео адреса самого прокси-сервера (шлюза). Оно может отличаться от того, что видит Telegram.">гео сервера (примерно)</span>
                          : null}
                    </div>
                  )}
                  {geoMap[p.id] === null && testing !== p.id && <div className="mt-0.5 text-xs text-amber-300">Гео не определено (прокси мёртв или IP не резолвится)</div>}
                </div>
                <span className="text-xs text-white/50">аккаунтов: <b className="text-white/80">{usedBy[p.id] ?? 0}</b></span>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => void doTest(p)} disabled={testing === p.id} className="btn-ghost h-9 text-xs disabled:opacity-50">{testing === p.id ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />} Тест</button>
                  <button onClick={() => setAssignFor(p)} className="btn-ghost h-9 text-xs"><Link2 size={14} /> Назначить</button>
                  {/* MR-133: ручная пометка «мёртвый» — сразу выводит прокси из выдачи аккаунтам. */}
                  <button onClick={() => void toggleDead(p)} className={cn('btn-icon h-9 w-9', p.status === 'dead' ? 'text-spark-400' : 'text-rose-300')} title={p.status === 'dead' ? 'Снять пометку «мёртвый»' : 'Пометить мёртвым (не предлагать аккаунтам)'}>{p.status === 'dead' ? <RotateCcw size={14} /> : <Skull size={14} />}</button>
                  <button onClick={() => openEdit(p)} className="btn-icon h-9 w-9" aria-label="Изменить"><Pencil size={14} /></button>
                  <button onClick={() => void remove(p)} className="btn-icon-danger h-9 w-9" aria-label="Удалить прокси" title="Удалить прокси"><Trash2 size={14} /></button>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {/* Создание / редактирование */}
      <Modal open={editOpen} onClose={() => setEditOpen(false)} title={editing ? 'Изменить прокси' : 'Новый прокси'} icon={<Network size={20} />}>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2"><label className="label">Название</label><input value={form.label ?? ''} onChange={(e) => set('label', e.target.value)} className="input" placeholder="Напр. Ферма UA #1" /></div>
          <div><label className="label">Тип</label><Select value={form.kind ?? 'static'} onChange={(v) => set('kind', v as ProxyKind)} options={(Object.keys(PROXY_KIND_LABELS) as ProxyKind[]).map((k) => ({ value: k, label: PROXY_KIND_LABELS[k] }))} /></div>
          <div><label className="label">Протокол</label><Select value={form.scheme ?? 'socks5'} onChange={(v) => set('scheme', v)} options={[{ value: 'socks5', label: 'SOCKS5' }, { value: 'http', label: 'HTTP' }]} /></div>
          <div><label className="label">Host / IP</label><input value={form.host ?? ''} onChange={(e) => set('host', e.target.value)} className="input" placeholder="1.2.3.4" /></div>
          <div><label className="label">Port</label><input type="number" value={form.port ?? 0} onChange={(e) => set('port', Number(e.target.value))} className="input" placeholder="1080" /></div>
          <div><label className="label">Логин</label><input value={form.username ?? ''} onChange={(e) => set('username', e.target.value)} className="input" placeholder="(опц.)" /></div>
          <div><label className="label">Пароль</label><input value={form.password ?? ''} onChange={(e) => set('password', e.target.value)} className="input" placeholder="(опц.)" /></div>
          <div className="col-span-2"><label className="label">Заметка</label><input value={form.note ?? ''} onChange={(e) => set('note', e.target.value)} className="input" placeholder="(опц.)" /></div>
        </div>
        <p className="mt-2 text-xs text-white/40">Статус и страна определяются автоматически при проверке — выбирать вручную не нужно.</p>
        {err && editOpen && <div className="mt-2 text-sm text-rose-300">{err}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={() => setEditOpen(false)} className="btn-ghost h-10">Отмена</button>
          <button onClick={() => void save()} disabled={saving || !form.host || !form.port} className="btn-primary h-10 disabled:opacity-40">{saving ? 'Сохранение…' : editing ? 'Сохранить' : 'Создать'}</button>
        </div>
      </Modal>

      {assignFor && <AssignModal proxy={assignFor} accounts={accounts} onClose={() => setAssignFor(null)} onDone={() => { setAssignFor(null); void load() }} />}

      <ImportProxiesModal open={importOpen} onClose={() => setImportOpen(false)} onDone={() => void load()} />

      {detailProxy && (
        <ProxyDetailModal
          proxy={detailProxy}
          accountsCount={usedBy[detailProxy.id] ?? 0}
          onClose={() => setDetailProxy(null)}
          onUpdated={(up) => { setProxies((prev) => prev.map((x) => (x.id === up.id ? up : x))); setDetailProxy(up) }}
        />
      )}
    </div>
  )
}

/** Детали прокси: при открытии запускает проверку и показывает всё, что смогли вытащить
 *  (статус, пинг, страна/город/провайдер выхода, выходной IP, последняя проверка). */
function ProxyDetailModal({ proxy, accountsCount, onClose, onUpdated }: {
  proxy: Proxy; accountsCount: number; onClose: () => void; onUpdated?: (p: Proxy) => void
}) {
  const [p, setP] = useState<Proxy>(proxy)
  const [geo, setGeo] = useState<ProxyGeo | null>(null)
  const [geoSource, setGeoSource] = useState<'exit' | 'gateway' | null>(null)
  const [ms, setMs] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  const run = async () => {
    setLoading(true)
    try {
      const r = await checkProxy(proxy.id)
      setP(r.proxy); setGeo(r.geo); setGeoSource(r.geoSource ?? null); setMs(r.ms ?? null)
      onUpdated?.(r.proxy)
    } catch { setGeo(null) }
    finally { setLoading(false) }
  }
  useEffect(() => { void run() /* авто-проверка при открытии */ }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const sm = STATUS_META[p.status]
  const fmtDate = (t: number | null | undefined) => (t ? new Date(t).toLocaleString('ru-RU') : '—')

  return (
    <Modal open onClose={onClose} title={p.label || `${p.host}:${p.port}`} subtitle="Детали прокси" icon={<Network size={20} />} size="md">
      <div className="mb-3 flex items-center gap-2 rounded-xl border border-line bg-elevated/40 px-3 py-2">
        <span className="font-mono text-xs text-white/70">{p.scheme}://{p.username ? `${p.username}@` : ''}{p.host}:{p.port}</span>
        <button onClick={() => void run()} disabled={loading} className="btn-ghost ml-auto h-8 text-xs disabled:opacity-50">
          {loading ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />} Проверить
        </button>
      </div>

      {loading && !geo ? (
        <div className="flex items-center gap-2 py-6 text-sm text-white/50"><Loader2 size={16} className="animate-spin" /> Проверяем прокси и тянем гео выхода…</div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <ProxyInfo label="Статус"><Badge tone={sm.tone}>{sm.label}</Badge></ProxyInfo>
          <ProxyInfo label="Тип">{PROXY_KIND_LABELS[p.kind]}</ProxyInfo>
          <ProxyInfo label="Пинг">{ms != null ? `${ms} мс` : '—'}</ProxyInfo>
          <ProxyInfo label="Назначено аккаунтов">{accountsCount}</ProxyInfo>
          <ProxyInfo label="Страна, которую видит Telegram">
            {geo ? <span>{FLAGS[geo.country] || ''} {geo.countryName || geo.country?.toUpperCase() || '—'}
              {geoSource === 'exit'
                ? <span className="ml-1 rounded bg-spark-500/15 px-1 text-[10px] font-semibold text-spark-300" title="Определено по реальному выходному IP — сходили в интернет через сам прокси">гео реального IP</span>
                : geoSource === 'gateway'
                  ? <span className="ml-1 rounded bg-amber-500/15 px-1 text-[10px] font-semibold text-amber-300" title="Выходной IP определить не удалось — показано гео самого прокси-сервера, оно может отличаться">гео сервера (примерно)</span>
                  : null}</span> : '—'}
          </ProxyInfo>
          <ProxyInfo label="Город">{geo?.city || '—'}</ProxyInfo>
          <ProxyInfo label="Провайдер (ISP)">{geo?.isp || '—'}</ProxyInfo>
          <ProxyInfo label="Выходной IP (его видит Telegram)">{geo?.ip || '—'}</ProxyInfo>
          <ProxyInfo label="Последняя проверка">{fmtDate(p.lastCheckAt)}</ProxyInfo>
          <ProxyInfo label="Добавлен">{fmtDate(p.createdAt)}</ProxyInfo>
          {p.note && <div className="col-span-2"><ProxyInfo label="Заметка">{p.note}</ProxyInfo></div>}
        </div>
      )}
      {!loading && p.status === 'dead' && (
        <p className="mt-3 text-xs text-amber-300">Прокси не отвечает — гео выхода недоступно, пока он мёртв.</p>
      )}
      {!loading && p.status === 'bad' && (
        <p className="mt-3 text-xs text-amber-300">
          Порт открыт, но выйти в интернет через прокси не удалось. Чаще всего дело в схеме:
          попробуйте сменить {p.scheme === 'socks5' ? 'SOCKS5 на HTTP' : 'HTTP на SOCKS5'} и проверить снова.
          У многих продавцов соседние порты — это одна пара, где один HTTP, второй SOCKS5.
        </p>
      )}
    </Modal>
  )
}

function ProxyInfo({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-elevated/40 px-3 py-2">
      <div className="text-[10px] font-bold uppercase tracking-wide text-white/40">{label}</div>
      <div className="mt-0.5 truncate text-sm font-semibold text-fg">{children}</div>
    </div>
  )
}

/** Назначение прокси на аккаунты: чекбоксы, save → patchAccount(proxy=url). */
function AssignModal({ proxy, accounts, onClose, onDone }: { proxy: Proxy; accounts: TgAccount[]; onClose: () => void; onDone: () => void }) {
  const url = toProxyUrl(proxy)
  const [picked, setPicked] = useState<Set<string>>(() => new Set(accounts.filter((a) => a.proxy === url).map((a) => a.id)))
  const [saving, setSaving] = useState(false)
  const active = accounts.filter((a) => !a.inTrash)

  const toggle = (id: string) => setPicked((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  async function save() {
    setSaving(true)
    try {
      // назначить выбранным, снять с тех, кто был на этом прокси, но снят из выбора
      const wasOn = new Set(accounts.filter((a) => a.proxy === url).map((a) => a.id))
      const ops: Promise<unknown>[] = []
      for (const a of active) {
        const shouldHave = picked.has(a.id)
        const hasNow = wasOn.has(a.id)
        if (shouldHave && !hasNow) ops.push(patchAccount(a.id, { proxy: url, initiator: 'operator' }))
        else if (!shouldHave && hasNow) ops.push(patchAccount(a.id, { proxy: '—', initiator: 'operator' }))
      }
      await Promise.all(ops)
      onDone()
    } finally { setSaving(false) }
  }

  return (
    <Modal open onClose={onClose} title="Назначить прокси" subtitle={`${proxy.label || proxy.host}:${proxy.port} → аккаунты`} icon={<Link2 size={20} />} size="md">
      <div className="max-h-80 overflow-y-auto rounded-xl border border-line">
        {active.length === 0 ? (
          <div className="p-4 text-sm text-white/50">Нет аккаунтов.</div>
        ) : active.map((a) => {
          const on = picked.has(a.id)
          const other = a.proxy && a.proxy !== url && a.proxy !== '—'
          return (
            <button key={a.id} onClick={() => toggle(a.id)} className="flex w-full items-center gap-3 border-b border-line/60 px-3 py-2 text-left last:border-0 hover:bg-elevated">
              <span className={on ? 'text-spark-400' : 'text-white/30'}>{on ? <Check size={16} /> : <Circle size={16} />}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-fg">{a.name}</span>
                <span className="truncate text-xs text-white/40">{FLAGS[a.country] || ''} {other ? 'уже на другом прокси' : a.proxy === url ? 'на этом прокси' : 'без прокси'}</span>
              </span>
            </button>
          )
        })}
      </div>
      <div className="mt-4 flex items-center justify-between">
        <span className="text-xs text-white/40">Выбрано: {picked.size}</span>
        <div className="flex gap-2">
          <button onClick={onClose} className="btn-ghost h-10">Отмена</button>
          <button onClick={() => void save()} disabled={saving} className="btn-primary h-10 disabled:opacity-40">{saving ? 'Применение…' : 'Применить'}</button>
        </div>
      </div>
    </Modal>
  )
}
