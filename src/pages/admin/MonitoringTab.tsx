import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Activity, Cpu, MemoryStick, Database, Timer, Users } from 'lucide-react'
import { Card, EmptyState } from '@/shared/ui'
import { cn } from '@/shared/lib/utils'
import type { AccountsHealth, ActiveNow, DailySpend, SystemMetrics } from '@/api/adminApi'
import { fetchSystemMetrics, fetchCron, saveCron, type CronField } from '@/api/adminApi'
import { fetchParserWatches, type ParserWatch } from '@/api/modulesApi'
import { fetchAccounts, patchAccount } from '@/api/accountsApi'
import type { TgAccount } from '@/shared/types'
import { fmt, MetricTile } from './adminShared'

/**
 * §10.9 (кол 29.07): живая нагрузка сервера — RPS и загрузка CPU/памяти, опрос раз в 3 с.
 * Отдельный компонент со своим таймером, чтобы пульс шёл независимо от остального экрана.
 */
function SystemLoad() {
  const [sys, setSys] = useState<SystemMetrics | null>(null)
  const [err, setErr] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    const tick = async () => {
      try { const s = await fetchSystemMetrics(); if (alive.current) { setSys(s); setErr(false) } }
      catch { if (alive.current) setErr(true) }
    }
    void tick()
    const id = setInterval(() => void tick(), 3000)
    return () => { alive.current = false; clearInterval(id) }
  }, [])

  if (err && !sys) return null // метрика недоступна — не мешаем остальному мониторингу
  const cpuTone = !sys ? undefined : sys.cpu.procPct >= 85 ? 'text-red-300' : sys.cpu.procPct >= 60 ? 'text-amber-300' : 'text-spark-300'
  const memTone = !sys ? undefined : sys.mem.rssMb >= 3000 ? 'text-red-300' : sys.mem.rssMb >= 2400 ? 'text-amber-300' : undefined
  const upt = (s: number) => (s >= 86400 ? `${Math.floor(s / 86400)} д ${Math.floor((s % 86400) / 3600)} ч` : s >= 3600 ? `${Math.floor(s / 3600)} ч ${Math.floor((s % 3600) / 60)} мин` : `${Math.floor(s / 60)} мин`)

  return (
    <div>
      <div className="mb-1 mt-1 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted">
        <Activity size={13} /> Нагрузка сервера
        <span className={cn('h-1.5 w-1.5 rounded-full', sys ? 'bg-spark-400 animate-pulse' : 'bg-faint')} />
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <MetricTile label="Запросов/сек" value={sys ? fmt(sys.rps1s) : '…'} tone="text-spark-300"
          sub={sys ? `среднее за минуту ${sys.rps1m}/с` : 'API-трафик'} />
        <MetricTile label={<span className="inline-flex items-center gap-1"><Cpu size={12} /> CPU процесса</span>} value={sys ? `${sys.cpu.procPct}%` : '…'} tone={cpuTone}
          sub={sys ? `${sys.cpu.cores} ядер${sys.cpu.load1 ? ` · load ${sys.cpu.load1}` : ''}` : 'загрузка'} />
        <MetricTile label={<span className="inline-flex items-center gap-1"><MemoryStick size={12} /> Память процесса</span>} value={sys ? `${fmt(sys.mem.rssMb)} МБ` : '…'} tone={memTone}
          sub={sys ? `heap ${fmt(sys.mem.heapUsedMb)} МБ · лимит 3 ГБ` : 'RSS'} />
        <MetricTile label="Память системы" value={sys ? `${sys.mem.systemUsedPct}%` : '…'}
          sub={sys ? `из ${fmt(sys.mem.systemTotalMb)} МБ · аптайм ${upt(sys.uptimeSec)}` : 'всего'} />
      </div>
    </div>
  )
}

export const STATUS_LABEL_RU: Record<string, string> = {
  active: 'Активны', warming: 'Прогрев', pause: 'На паузе', floodwait: 'FloodWait',
  quarantine: 'Карантин', spamblock: 'Спам-блок', reauth: 'Нужен вход', invalid: 'Невалидны',
}

const statusTone: Record<string, string> = {
  floodwait: 'text-amber-300', quarantine: 'text-amber-300',
  spamblock: 'text-red-300', invalid: 'text-red-300', reauth: 'text-iris-300',
}
const untilText = (until: number) => {
  if (!until) return ''
  const left = until - Date.now()
  if (left <= 0) return 'срок истёк'
  const min = Math.round(left / 60000)
  return min >= 60 ? `ещё ~${Math.round(min / 60)} ч` : `ещё ~${min} мин`
}

/**
 * Блоки «По статусам» + «Падающие аккаунты — почему». Вынесены сюда, чтобы жить на
 * вкладке «Задачи и ошибки» (перенос по просьбе заказчика), а не в мониторинге.
 */
export function AccountsHealthBlocks({ health }: { health: AccountsHealth | null }) {
  if (!health) return null
  return (
    <>
      <Card className="p-4">
        <div className="mb-2 text-sm font-semibold text-fg">По статусам</div>
        <div className="flex flex-wrap gap-2">
          {Object.entries(health.byStatus).sort((a, b) => b[1] - a[1]).map(([st, n]) => (
            <span key={st} className={cn('rounded-lg border border-line px-2 py-1 text-xs', statusTone[st] || 'text-muted')}>
              {STATUS_LABEL_RU[st] || st}: <b className="text-fg">{n}</b>
            </span>
          ))}
          {!!health.resting && <span className="rounded-lg border border-line px-2 py-1 text-xs text-muted">отдыхают: <b className="text-fg">{health.resting}</b></span>}
          {!!health.tired && <span className="rounded-lg border border-line px-2 py-1 text-xs text-amber-300">устали (≥70%): <b className="text-fg">{health.tired}</b></span>}
        </div>
      </Card>

      {health.problems.length ? (
        <Card className="p-4">
          <div className="mb-2 text-sm font-semibold text-fg">Падающие аккаунты — почему ({health.problems.length})</div>
          <div className="space-y-1.5">
            {health.problems.map((a) => (
              <div key={a.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-line/40 pb-1.5 text-sm last:border-0">
                <span className="font-medium text-fg">{a.name}</span>
                {!!a.phone && <span className="text-xs text-muted">{a.phone}</span>}
                <span className={cn('rounded-md px-1.5 py-0.5 text-[11px] font-bold', statusTone[a.status] || 'text-muted', 'bg-white/8')}>{a.statusLabel}</span>
                {!!a.reason && <span className="w-full text-xs text-muted sm:w-auto sm:flex-1 sm:truncate">{a.reason}</span>}
                {!!a.until && <span className="shrink-0 text-[11px] text-faint">{untilText(a.until)}</span>}
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <Card className="p-4 text-sm text-muted">Падающих аккаунтов нет — весь парк в работе или на паузе.</Card>
      )}
    </>
  )
}

/**
 * §10.9: мониторинг здоровья аккаунтов — работают / на паузе / падают, с причиной
 * по каждому проблемному. Всегда виден (в отличие от «Проблем», которые прячутся,
 * когда тихо): владелец должен видеть парк аккаунтов и почему кто-то выпал.
 */
/**
 * Сломанные перепроверки парсинга (просьба владельца 24.08: «выводились ошибки в
 * админке на случай чего»).
 *
 * Слежение за запросом раз в сутки перезапускает парс. Если оно падает — владелец
 * платформы должен узнать об этом здесь, а не от клиента, у которого «почему-то ничего
 * не обновляется». Три неудачи подряд снимают слежение, но причина остаётся видна.
 *
 * Свои хуки и свой запрос: в MonitoringTab есть ранние return'ы, и хуки после них
 * ломают порядок вызовов (тот самый чёрный экран админки).
 */
function ParserWatchErrors() {
  const [rows, setRows] = useState<ParserWatch[]>([])
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let alive = true
    void fetchParserWatches(true)
      .then((w) => { if (alive) { setRows(w); setLoaded(true) } })
      .catch(() => { if (alive) setLoaded(true) })
    return () => { alive = false }
  }, [])

  // Ошибок нет — блок не показываем вовсе: пустая карточка «всё хорошо» только шумит.
  if (!loaded || !rows.length) return null

  const when = (ts: number) => (ts ? new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—')
  return (
    <div>
      <div className="mb-1 mt-1 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-amber-300">
        <Database size={13} /> Перепроверка парсинга — ошибки ({rows.length})
      </div>
      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="bg-elevated/60 text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2">Запрос</th>
                <th className="px-4 py-2">Модуль</th>
                <th className="px-4 py-2">Когда</th>
                <th className="px-4 py-2">Что случилось</th>
                <th className="px-4 py-2">Слежение</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.sig} className="border-t border-line/60">
                  <td className="px-4 py-2 font-medium text-fg">{w.label || '—'}</td>
                  <td className="px-4 py-2 text-muted">{w.kind}</td>
                  <td className="px-4 py-2 text-muted">{when(w.lastRunAt)}</td>
                  <td className="px-4 py-2 text-amber-300">{w.lastError}</td>
                  <td className="px-4 py-2 text-muted">{w.watch ? `ещё пробуем (${w.failCount ?? 0})` : 'снято'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

/**
 * Настройки фоновых задач (просьба владельца 26.08: «в админку вынести все настройки по
 * кроне»).
 *
 * До этого интервалы были константами в шести файлах: чтобы изменить, как часто идёт
 * ревизия базы или проверка парка, приходилось править код и выкатываться. И, что важнее,
 * посмотреть, ЧТО вообще крутится в фоне, было негде.
 *
 * Поля рисуются по описанию с сервера — там же, где применяются границы. Дублировать
 * «от 1 до 720» в вёрстке значит завести второй источник правды, который однажды разойдётся.
 *
 * Свои хуки и свой запрос: в MonitoringTab есть ранние return'ы, и хуки после них ломают
 * порядок вызовов.
 */
/**
 * Аккаунты для ревизии базы (просьба владельца 27.08: «там есть возможность добавить
 * аккаунты, с которых будет проводиться ревизия?»).
 *
 * Возможности не было. Крон ревизии берёт ТОЛЬКО аккаунты с меткой `service`
 * (parserRefresh.pickAccounts), но проставить её было негде ни в одном интерфейсе — пул
 * всегда оставался пустым, и каждые 12 часов в лог падало «нет свободных сервисных
 * аккаунтов для ревизии базы». Поле в данных было, работать им было нельзя.
 *
 * Отдельный пул нужен затем, чтобы ревизия не занимала боевые профили: она ходит по тем
 * же поисковым запросам, что и клиентские задачи, и без своих аккаунтов отбирала бы их
 * у работы, ради которой платят.
 */
export function ServiceAccounts() {
  const [accounts, setAccounts] = useState<TgAccount[]>([])
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')

  const load = useCallback(async () => {
    try { setAccounts(await fetchAccounts() as unknown as TgAccount[]) }
    catch (e) { setErr(e instanceof Error ? e.message : 'не загрузилось') }
  }, [])
  useEffect(() => { void load() }, [load])

  const toggle = async (a: TgAccount) => {
    setBusy(a.id)
    try {
      await patchAccount(a.id, { service: !a.service })
      setAccounts((prev) => prev.map((x) => (x.id === a.id ? { ...x, service: !a.service } : x)))
    } catch (e) { setErr(e instanceof Error ? e.message : 'не сохранилось') }
    finally { setBusy('') }
  }

  /*
   * Только аккаунты ПЛАТФОРМЫ (правка 27.08: «не должно быть из общей базы чужих телеграм
   * аккаунтов, только наши, которые мы законектим именно для админ-панели»). Раньше здесь
   * лежал весь парк, и дежурным по ревизии можно было назначить рабочий профиль клиента —
   * а фоновое обновление общей базы идёт по нашей инициативе и нашими руками.
   */
  const live = accounts.filter((a) => !a.inTrash && a.platform)
  const chosen = live.filter((a) => a.service)
  const needle = q.trim().toLowerCase()
  // Выбранные всегда сверху: их единицы среди сотни, иначе искать их в списке невозможно.
  const shown = [...live]
    .filter((a) => !needle || `${a.name || ''} ${a.username || ''} ${a.phone || ''} ${a.id}`.toLowerCase().includes(needle))
    .sort((x, y) => Number(!!y.service) - Number(!!x.service))
    .slice(0, 60)

  return (
    <div className="mt-4">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted">
        <Users size={13} /> Аккаунты для ревизии базы
      </div>
      <Card className="p-4">
        <p className="mb-3 text-xs leading-relaxed text-muted">
          Ревизия раз в N часов перезапускает сохранённые запросы парсинга и ищет, что появилось или пропало.
          В списке — <b className="text-fg">только аккаунты платформы</b>: клиентские профили сюда не попадают
          вовсе, обновление общей базы идёт по нашей инициативе и должно идти нашими руками. Отметка выбирает,
          кто из них дежурит.
        </p>
        {!live.length && (
          <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs leading-relaxed text-amber-200/90">
            Аккаунтов платформы пока нет — ревизия каждый раз пишет в лог, что работать некем.
            Подключите их: <b>Менеджер аккаунтов → Импортировать</b>, галочка
            «Аккаунты платформы (для админ-панели)». Они не попадут ни в чьё клиентское пространство.
          </div>
        )}
        {err && <div className="mb-2 text-xs text-amber-300">{err}</div>}
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Поиск по имени, username, телефону…"
            className="h-8 flex-1 rounded-lg border border-line bg-elevated/60 px-2.5 text-sm text-fg"
          />
          <span className="text-[11px] text-muted">Дежурят: <b className="text-fg">{chosen.length}</b> из {live.length} наших</span>
        </div>
        <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
          {shown.map((a) => (
            <div key={a.id} className={cn('flex items-center justify-between gap-3 rounded-lg px-2.5 py-1.5',
              a.service ? 'bg-spark-500/8' : 'bg-elevated')}>
              <span className="min-w-0 truncate text-sm text-fg">
                {a.name || a.id}
                <span className="ml-2 text-[11px] text-white/40">{a.username ? `@${a.username}` : a.phone || ''} · {a.status}</span>
              </span>
              <button
                type="button"
                onClick={() => void toggle(a)}
                disabled={busy === a.id}
                className={cn('h-7 shrink-0 rounded-lg px-2.5 text-[11px] font-semibold disabled:opacity-40',
                  a.service ? 'bg-spark-500/20 text-spark-300' : 'border border-line text-muted hover:text-fg')}
              >
                {a.service ? 'В ревизии' : 'Добавить'}
              </button>
            </div>
          ))}
          {!shown.length && <div className="py-4 text-center text-xs text-muted">Ничего не нашлось</div>}
        </div>
      </Card>
    </div>
  )
}

function CronSettings() {
  const [fields, setFields] = useState<CronField[]>([])
  const [values, setValues] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    void fetchCron()
      .then((r) => { if (alive) { setFields(r.fields); setValues(r.values) } })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : 'не загрузилось') })
    return () => { alive = false }
  }, [])

  if (err) return <Card className="p-4 text-sm text-amber-300">Настройки фоновых задач недоступны: {err}</Card>
  if (!fields.length) return null

  const save = async () => {
    setBusy(true); setNote('')
    try {
      const r = await saveCron(values)
      setValues(r.values)
      setNote(r.note || 'Сохранено')
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Не сохранилось')
    } finally { setBusy(false) }
  }

  return (
    <div>
      <div className="mb-1 mt-1 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted">
        <Timer size={13} /> Фоновые задачи
      </div>
      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {fields.map((f) => (
            <label key={f.key} className="block" title={f.hint || ''}>
              <span className="mb-1 block text-[11px] leading-snug text-muted">{f.label}</span>
              <span className="flex items-center gap-2">
                <input
                  type="number"
                  min={f.min}
                  max={f.max}
                  value={values[f.key] ?? f.def}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: Number(e.target.value) }))}
                  className="h-8 w-24 rounded-lg border border-line bg-elevated/60 px-2 text-sm text-fg"
                />
                <span className="text-[11px] text-faint">{f.unit}</span>
              </span>
              {f.hint && <span className="mt-1 block text-[10px] leading-snug text-white/35">{f.hint}</span>}
            </label>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button type="button" onClick={() => void save()} disabled={busy} className="btn-soft h-8 text-xs disabled:opacity-40">
            {busy ? 'Сохраняю…' : 'Сохранить'}
          </button>
          {note && <span className="text-[11px] text-muted">{note}</span>}
        </div>
      </Card>
      <ServiceAccounts />
    </div>
  )
}

export function MonitoringTab({ health, active, daily }: { health: AccountsHealth | null; active: ActiveNow | null; daily: DailySpend | null }) {
  if (!health) return <Card className="p-6 text-sm text-muted">Загрузка…</Card>
  if (!health.total) return <EmptyState icon={<AlertTriangle size={22} />} title="Аккаунтов нет" desc="Добавьте аккаунты в менеджере профилей." />

  // §10.9: нагрузка системы «сейчас» — сколько задач крутится, сколько аккаунтов
  // занято, сегодняшний поток действий, сколько встало из-за баланса.
  const running = active?.running ?? []
  const paused = active?.paused ?? []
  const accountsInWork = running.reduce((s, t) => s + (t.accounts || 0), 0)
  const pausedByCoins = paused.filter((t) => t.pausedByCoins).length
  const lastDay = daily?.rows?.[(daily.rows.length || 0) - 1]
  const todayActions = lastDay?.actions ?? 0

  return (
    <div className="space-y-3">
      {/* §10.9: живой пульс сервера — RPS и CPU/память. */}
      <SystemLoad />
      <ParserWatchErrors />
      <CronSettings />

      {/* §10.9: нагрузка «сейчас» — задачи в работе, занятые аккаунты, поток действий. */}
      <div className="grid gap-3 sm:grid-cols-4">
        <MetricTile label="Задач в работе" value={fmt(running.length)} tone="text-spark-300" sub={`на паузе ${fmt(paused.length)}${pausedByCoins ? ` · из-за баланса ${fmt(pausedByCoins)}` : ''}`} />
        <MetricTile label="Аккаунтов занято" value={fmt(accountsInWork)} sub="в активных задачах" />
        <MetricTile label="Действий сегодня" value={fmt(todayActions)} sub="поток за день" />
        <MetricTile label="Аккаунтов всего" value={fmt(health.total)} sub={`работают ${fmt(health.healthy)} · падают ${fmt(health.problem)}`} />
      </div>

      <div className="mb-1 mt-4 text-xs font-bold uppercase tracking-wide text-muted">Здоровье аккаунтов</div>
      <div className="grid gap-3 sm:grid-cols-4">
        <MetricTile label="Всего аккаунтов" value={fmt(health.total)} />
        <MetricTile label="Работают" value={fmt(health.healthy)} tone="text-spark-300" sub="активны + прогрев" />
        <MetricTile label="На паузе" value={fmt(health.idle)} sub="остановлены командой" />
        <MetricTile label="Падают" value={fmt(health.problem)} tone={health.problem ? 'text-red-300' : undefined} sub="flood / бан / невалид" />
      </div>
      {/* «По статусам» и «Падающие аккаунты — почему» перенесены на вкладку «Задачи и ошибки»
          (AccountsHealthBlocks) — по просьбе заказчика. */}
    </div>
  )
}
