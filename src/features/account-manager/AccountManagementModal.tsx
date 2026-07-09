import { useEffect, useState, useCallback } from 'react'
import {
  User, Globe, BarChart3, Calendar, Zap, HeartPulse, Hash, FolderClosed,
  Copy, Check, ShieldCheck, ShieldAlert, ShieldQuestion, Loader2, RefreshCw, Unlock, AlertCircle,
} from 'lucide-react'
import { Modal, Avatar } from '@/shared/ui'
import { cn } from '@/shared/lib/utils'
import { useApp } from '@/mocks/store'
import {
  fetchAccountStats, fetchAccountChannels, fetchAccountFolders, releaseAccountLock,
} from '@/api/accountsApi'
import type { TgAccount, AccountStats, AccountChannel, AccountFolder } from '@/shared/types'

type TabKey = 'profile' | 'proxy' | 'status' | 'dates' | 'actions' | 'health' | 'channels' | 'folders'

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: 'profile', label: 'Профиль', icon: <User size={15} /> },
  { key: 'proxy', label: 'Прокси', icon: <Globe size={15} /> },
  { key: 'status', label: 'Статус', icon: <BarChart3 size={15} /> },
  { key: 'dates', label: 'Даты', icon: <Calendar size={15} /> },
  { key: 'actions', label: 'Действия', icon: <Zap size={15} /> },
  { key: 'health', label: 'Здоровье', icon: <HeartPulse size={15} /> },
  { key: 'channels', label: 'Каналы', icon: <Hash size={15} /> },
  { key: 'folders', label: 'Папки', icon: <FolderClosed size={15} /> },
]

const FLAGS: Record<string, string> = { UA: '🇺🇦', RU: '🇷🇺', KZ: '🇰🇿', PL: '🇵🇱', DE: '🇩🇪' }

function fmtDate(ts: number | null | undefined) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function fmtTime(ts: string) {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  return d.toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function AccountManagementModal({ account, onClose }: { account: TgAccount | null; onClose: () => void }) {
  const pushToast = useApp((s) => s.pushToast)
  const loadAccountBusy = useApp((s) => s.loadAccountBusy)
  const [tab, setTab] = useState<TabKey>('profile')
  const [stats, setStats] = useState<AccountStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [spamChecking, setSpamChecking] = useState(false)
  const [releasing, setReleasing] = useState(false)

  const load = useCallback(async (opts?: { spam?: boolean }) => {
    if (!account) return
    setLoading(true)
    try {
      const s = await fetchAccountStats(account.id, opts)
      setStats(s)
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось получить данные аккаунта', desc: e instanceof Error ? e.message : undefined })
    } finally {
      setLoading(false)
    }
  }, [account, pushToast])

  useEffect(() => {
    if (!account) { setStats(null); setTab('profile'); return }
    void load()
  }, [account?.id])

  const runSpamCheck = async () => {
    setSpamChecking(true)
    try {
      await load({ spam: true })
      pushToast({ type: 'info', title: 'Спамблок проверен через @SpamBot' })
    } finally {
      setSpamChecking(false)
    }
  }

  const runRelease = async () => {
    if (!account) return
    setReleasing(true)
    try {
      const r = await releaseAccountLock(account.id)
      pushToast({ type: 'success', title: r.released ? 'Блокировка снята' : 'Блокировок не было' })
      await loadAccountBusy()
      await load()
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось снять блокировку', desc: e instanceof Error ? e.message : undefined })
    } finally {
      setReleasing(false)
    }
  }

  return (
    <Modal
      open={!!account}
      onClose={onClose}
      size="xl"
      icon={<div className="grid h-10 w-10 place-items-center rounded-xl bg-iris-500/15 text-iris-300"><User size={20} /></div>}
      title="Управление аккаунтом"
      subtitle={account ? `${account.name} · @${stats?.profile.username ?? account.username}` : ''}
      footer={<button onClick={onClose} className="btn-primary h-10">Закрыть</button>}
    >
      {account && (
        <div className="space-y-4">
          <HeroBanner account={account} stats={stats} />

          <div className="flex gap-1 overflow-x-auto border-b border-line no-scrollbar">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  'relative flex items-center gap-1.5 whitespace-nowrap px-3.5 py-2.5 text-sm font-semibold transition-colors',
                  tab === t.key ? 'text-fg' : 'text-muted hover:text-fg',
                )}
              >
                {t.icon}{t.label}
                {tab === t.key && <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-spark-gradient" />}
              </button>
            ))}
          </div>

          {loading && !stats ? (
            <div className="flex items-center justify-center gap-2 py-16 text-muted">
              <Loader2 size={18} className="animate-spin" /> Загрузка данных из Telegram…
            </div>
          ) : (
            <div className="animate-fade-in">
              {tab === 'profile' && <ProfileTab account={account} stats={stats} />}
              {tab === 'proxy' && <ProxyTab stats={stats} loading={loading} onRecheck={() => void load()} />}
              {tab === 'status' && <StatusTab stats={stats} spamChecking={spamChecking} onSpamCheck={() => void runSpamCheck()} />}
              {tab === 'dates' && <DatesTab stats={stats} />}
              {tab === 'actions' && (
                <ActionsTab
                  stats={stats}
                  loading={loading}
                  spamChecking={spamChecking}
                  releasing={releasing}
                  onRecheck={() => void load()}
                  onSpamCheck={() => void runSpamCheck()}
                  onRelease={() => void runRelease()}
                />
              )}
              {tab === 'health' && <HealthTab stats={stats} />}
              {tab === 'channels' && <ChannelsTab accountId={account.id} />}
              {tab === 'folders' && <FoldersTab accountId={account.id} />}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

/* ── Hero ── */
function HeroBanner({ account, stats }: { account: TgAccount; stats: AccountStats | null }) {
  const geo = stats?.profile.geo ?? account.country.toUpperCase()
  const valid = stats?.status.valid
  const spam = stats?.status.spamblock ?? 'unknown'
  const warmingDays = stats?.status.warmingDays
  const active = stats?.status.warmingActive
  return (
    <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-iris-600 to-iris-800 p-5 text-white">
      <div className="flex items-start gap-4">
        <Avatar name={account.name} color={account.avatarColor} size={54} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xl font-bold">{account.name}</div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-white/80">
            <span className="text-white/90">@{stats?.profile.username ?? account.username}</span>
            <span className="opacity-60">{stats?.profile.phone ?? account.phone}</span>
            <span className="rounded-md bg-white/15 px-1.5 py-0.5 text-xs font-bold">{FLAGS[geo] ?? ''} {geo}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Pill tone={valid == null ? 'neutral' : valid ? 'ok' : 'bad'}>
            {valid == null ? <ShieldQuestion size={12} /> : valid ? <ShieldCheck size={12} /> : <ShieldAlert size={12} />}
            {valid == null ? 'Проверка…' : valid ? 'Валидный' : 'Невалидный'}
          </Pill>
          <Pill tone={spam === 'clean' ? 'ok' : spam === 'blocked' ? 'bad' : 'neutral'}>
            {spam === 'clean' ? 'Без спамблока' : spam === 'blocked' ? 'Спамблок' : 'Спамблок: —'}
          </Pill>
          {active && (
            <Pill tone="ok">
              <Loader2 size={12} className="animate-spin" /> Активен{warmingDays != null ? ` (${warmingDays}д)` : ''}
            </Pill>
          )}
        </div>
      </div>
    </div>
  )
}

function Pill({ children, tone }: { children: React.ReactNode; tone: 'ok' | 'bad' | 'neutral' }) {
  const tones = {
    ok: 'bg-spark-500/25 text-spark-50 border-spark-300/40',
    bad: 'bg-rose-500/25 text-rose-50 border-rose-300/40',
    neutral: 'bg-white/15 text-white/90 border-white/25',
  }
  return <span className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-bold', tones[tone])}>{children}</span>
}

/* ── Reusable field ── */
function Field({ label, value, mono, copyable }: { label: string; value: React.ReactNode; mono?: boolean; copyable?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line/60 py-2.5 last:border-0">
      <span className="text-sm text-muted">{label}</span>
      <span className={cn('flex items-center gap-1.5 text-right text-sm font-semibold text-fg', mono && 'font-mono')}>
        {value}
        {copyable && (
          <button
            onClick={() => { void navigator.clipboard.writeText(copyable); setCopied(true); setTimeout(() => setCopied(false), 1200) }}
            className="text-muted hover:text-fg"
          >
            {copied ? <Check size={13} className="text-spark-400" /> : <Copy size={13} />}
          </button>
        )}
      </span>
    </div>
  )
}

function SectionCard({ title, icon, children, action }: { title: string; icon?: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-elevated/40 p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-bold text-fg">{icon}{title}</div>
        {action}
      </div>
      {children}
    </div>
  )
}

const dash = <span className="text-faint">—</span>

/* ── Tabs ── */
function ProfileTab({ account, stats }: { account: TgAccount; stats: AccountStats | null }) {
  const p = stats?.profile
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <SectionCard title="Telegram-профиль" icon={<User size={15} className="text-iris-300" />}>
        <Field label="Telegram ID" value={p?.id ?? dash} mono copyable={p?.id ?? undefined} />
        <Field label="Имя" value={p?.firstName ?? dash} />
        <Field label="Фамилия" value={p?.lastName ?? dash} />
        <Field label="Username" value={p?.username ? `@${p.username}` : dash} copyable={p?.username ?? undefined} />
        <Field label="Телефон" value={p?.phone ?? account.phone ?? dash} mono copyable={p?.phone ?? undefined} />
        <Field label="Premium" value={p?.premium == null ? dash : (p.premium ? 'Да' : 'Нет')} />
      </SectionCard>
      <SectionCard title="Системная информация" icon={<Globe size={15} className="text-iris-300" />}>
        <Field label="Гео" value={p?.geo ? `${FLAGS[p.geo] ?? ''} ${p.geo}` : dash} />
        <Field label="Сессия сохранена" value={p?.saved ? 'Да' : 'Нет'} />
        <Field label="Роль" value={stats?.role ?? account.role ?? dash} />
        <Field label="Проект" value={account.project ?? dash} />
      </SectionCard>
    </div>
  )
}

function ProxyTab({ stats, loading, onRecheck }: { stats: AccountStats | null; loading: boolean; onRecheck: () => void }) {
  const px = stats?.proxy
  if (!px) return <div className="py-8 text-center text-sm text-muted">Нет данных</div>
  if (!px.configured) {
    return (
      <SectionCard title="Прокси" icon={<Globe size={15} className="text-iris-300" />}>
        <div className="py-6 text-center text-sm text-muted">Прямое подключение (прокси не настроен)</div>
      </SectionCard>
    )
  }
  return (
    <SectionCard
      title="Прокси"
      icon={<Globe size={15} className="text-iris-300" />}
      action={
        <button onClick={onRecheck} disabled={loading} className="btn-soft h-8 text-xs disabled:opacity-50">
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Проверить
        </button>
      }
    >
      <div className="mb-3 rounded-xl border border-line bg-elevated px-3 py-2 font-mono text-xs text-iris-300 break-all">{px.raw}</div>
      <div className="mb-3">
        {px.working == null ? (
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-slate-500/15 px-2.5 py-1 text-xs font-bold text-slate-300"><ShieldQuestion size={13} /> Не проверено</span>
        ) : px.working ? (
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-spark-500/15 px-2.5 py-1 text-xs font-bold text-spark-300"><ShieldCheck size={13} /> Работает</span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-rose-500/15 px-2.5 py-1 text-xs font-bold text-rose-300"><ShieldAlert size={13} /> Не отвечает</span>
        )}
        <span className="ml-2 text-xs text-muted">Проверено: {fmtDate(px.checkedAt)}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MiniStat label="Протокол" value={px.protocol ?? '—'} />
        <MiniStat label="IP" value={px.ip ?? '—'} />
        <MiniStat label="Порт" value={px.port != null ? String(px.port) : '—'} />
        <MiniStat label="Логин" value={px.login ?? '—'} />
      </div>
    </SectionCard>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-elevated p-2.5">
      <div className="text-[10px] font-bold uppercase tracking-wide text-faint">{label}</div>
      <div className="mt-0.5 truncate font-mono text-sm font-semibold text-fg">{value}</div>
    </div>
  )
}

function StatusTab({ stats, spamChecking, onSpamCheck }: { stats: AccountStats | null; spamChecking: boolean; onSpamCheck: () => void }) {
  const st = stats?.status
  if (!st) return <div className="py-8 text-center text-sm text-muted">Нет данных</div>
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <StatusCard
        icon={st.valid ? <ShieldCheck size={22} /> : <ShieldAlert size={22} />}
        tone={st.valid ? 'ok' : 'bad'}
        title="Статус"
        value={st.valid ? 'Валидный' : 'Невалидный'}
        desc={st.sessionOk ? 'Сессия работает' : 'Сессия недоступна'}
      />
      <StatusCard
        icon={st.spamblock === 'clean' ? <ShieldCheck size={22} /> : st.spamblock === 'blocked' ? <ShieldAlert size={22} /> : <ShieldQuestion size={22} />}
        tone={st.spamblock === 'clean' ? 'ok' : st.spamblock === 'blocked' ? 'bad' : 'neutral'}
        title="Спамблок"
        value={st.spamblock === 'clean' ? 'Чисто' : st.spamblock === 'blocked' ? 'Ограничен' : 'Неизвестно'}
        desc={st.spamblock === 'unknown' ? 'Не проверялся' : (st.spamblockText || '')}
        footer={
          <button onClick={onSpamCheck} disabled={spamChecking} className="btn-soft mt-2 h-7 w-full text-xs disabled:opacity-50">
            {spamChecking ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Проверить @SpamBot
          </button>
        }
      />
      <StatusCard
        icon={<Zap size={22} />}
        tone={st.warmingActive ? 'ok' : 'neutral'}
        title="Прогрев"
        value={st.warmingActive ? 'Активен' : 'Неактивен'}
        desc={`${st.warmingDays} дн. в системе`}
        pulse={st.warmingActive}
      />
    </div>
  )
}

function StatusCard({ icon, tone, title, value, desc, footer, pulse }: {
  icon: React.ReactNode; tone: 'ok' | 'bad' | 'neutral'; title: string; value: string; desc?: string; footer?: React.ReactNode; pulse?: boolean
}) {
  const tones = {
    ok: 'text-spark-400 bg-spark-500/12',
    bad: 'text-rose-400 bg-rose-500/12',
    neutral: 'text-slate-300 bg-slate-500/12',
  }
  return (
    <div className="rounded-2xl border border-line bg-elevated/40 p-4 text-center">
      <div className={cn('mx-auto grid h-12 w-12 place-items-center rounded-2xl', tones[tone], pulse && 'animate-pulse-ring')}>{icon}</div>
      <div className="mt-2 text-[11px] font-bold uppercase tracking-wide text-muted">{title}</div>
      <div className="text-lg font-bold text-fg">{value}</div>
      {desc && <div className="mt-0.5 line-clamp-2 text-xs text-muted">{desc}</div>}
      {footer}
    </div>
  )
}

function DatesTab({ stats }: { stats: AccountStats | null }) {
  const d = stats?.dates
  return (
    <SectionCard title="Даты" icon={<Calendar size={15} className="text-iris-300" />}>
      <Field label="Добавлен в систему" value={fmtDate(d?.addedAt)} />
      <Field label="Последняя проверка" value={fmtDate(d?.lastCheckAt)} />
      <Field label="Проверка прокси" value={fmtDate(d?.proxyCheckAt)} />
    </SectionCard>
  )
}

function ActionsTab({ stats, loading, spamChecking, releasing, onRecheck, onSpamCheck, onRelease }: {
  stats: AccountStats | null; loading: boolean; spamChecking: boolean; releasing: boolean
  onRecheck: () => void; onSpamCheck: () => void; onRelease: () => void
}) {
  const busy = stats?.busyIn
  return (
    <div className="space-y-3">
      {busy && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-200">
          <Loader2 size={15} className="animate-spin" />
          Аккаунт занят в модуле «{busy.moduleLabel}». Сетевые проверки выполнятся после освобождения.
        </div>
      )}
      <SectionCard title="Проверки" icon={<Zap size={15} className="text-iris-300" />}>
        <div className="grid gap-2 sm:grid-cols-2">
          <ActionBtn onClick={onRecheck} loading={loading} icon={<RefreshCw size={15} />} label="Перепроверить сессию и прокси" />
          <ActionBtn onClick={onSpamCheck} loading={spamChecking} icon={<ShieldQuestion size={15} />} label="Проверить спамблок (@SpamBot)" />
        </div>
      </SectionCard>
      <SectionCard title="Блокировка" icon={<Unlock size={15} className="text-iris-300" />}>
        <p className="mb-2 text-xs text-muted">
          {busy ? 'Снимите блокировку, если задача зависла и аккаунт не освобождается.' : 'Активных блокировок нет.'}
        </p>
        <ActionBtn onClick={onRelease} loading={releasing} disabled={!busy} tone="danger" icon={<Unlock size={15} />} label="Снять блокировку аккаунта" />
      </SectionCard>
    </div>
  )
}

function ActionBtn({ onClick, loading, disabled, icon, label, tone }: {
  onClick: () => void; loading?: boolean; disabled?: boolean; icon: React.ReactNode; label: string; tone?: 'danger'
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading || disabled}
      className={cn(
        'flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-sm font-semibold transition-colors disabled:opacity-40',
        tone === 'danger' ? 'border-rose-500/30 text-rose-300 hover:bg-rose-500/10' : 'border-line text-fg hover:bg-elevated',
      )}
    >
      {loading ? <Loader2 size={15} className="animate-spin" /> : icon}
      {label}
    </button>
  )
}

function HealthTab({ stats }: { stats: AccountStats | null }) {
  if (!stats) return <div className="py-8 text-center text-sm text-muted">Нет данных</div>
  const { health, longevity, activity } = stats
  const riskLabel = longevity.risk === 'low' ? 'Низкий риск' : longevity.risk === 'medium' ? 'Средний риск' : 'Высокий риск'
  const riskTone = longevity.risk === 'low' ? 'text-spark-300 bg-spark-500/15' : longevity.risk === 'medium' ? 'text-amber-300 bg-amber-500/15' : 'text-rose-300 bg-rose-500/15'
  const healthColor = health.score >= 80 ? '#0ec464' : health.score >= 55 ? '#f59e0b' : '#ef4444'
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <SectionCard title="Здоровье аккаунта" icon={<HeartPulse size={15} className="text-rose-300" />}>
          <div className="flex items-center gap-4 py-2">
            <Gauge value={health.score} color={healthColor} />
            <div>
              <div className="text-lg font-bold text-fg">{health.label}</div>
              <div className="text-xs text-muted">по реальным сигналам</div>
            </div>
          </div>
        </SectionCard>
        <SectionCard title="Оценка долголетия" icon={<BarChart3 size={15} className="text-iris-300" />}>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-3xl font-bold text-fg">{longevity.score}</span>
            <span className="text-sm text-muted">/100</span>
            <span className={cn('ml-1 rounded-md px-2 py-0.5 text-xs font-bold', riskTone)}>{riskLabel}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {longevity.factors.map((f) => (
              <span key={f.key} className={cn('rounded-md px-2 py-0.5 text-[11px] font-semibold', f.positive ? 'bg-spark-500/12 text-spark-300' : 'bg-rose-500/12 text-rose-300')}>
                {f.label}
              </span>
            ))}
          </div>
        </SectionCard>
      </div>

      <SectionCard title="События здоровья" icon={<AlertCircle size={15} className="text-amber-300" />}>
        {health.events.length === 0 ? (
          <div className="py-4 text-center text-sm text-muted">Нет событий</div>
        ) : (
          <div className="space-y-1.5">
            {health.events.map((e, i) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', e.level === 'error' ? 'bg-rose-400' : 'bg-amber-400')} />
                <span className="flex-1 text-fg">{e.label}</span>
                <span className="shrink-0 text-xs text-faint">{fmtTime(e.ts)}</span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Журнал активности" icon={<Zap size={15} className="text-iris-300" />}>
        {activity.length === 0 ? (
          <div className="py-4 text-center text-sm text-muted">Активности пока нет</div>
        ) : (
          <div className="max-h-64 space-y-1.5 overflow-y-auto">
            {activity.map((a, i) => (
              <div key={i} className="flex items-start gap-2 rounded-lg px-1 py-1 text-sm">
                <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                  a.level === 'error' ? 'bg-rose-400' : a.level === 'warning' ? 'bg-amber-400' : a.level === 'success' ? 'bg-spark-400' : 'bg-sky-400')} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-fg">{a.label}{a.target ? <span className="text-iris-300"> · {a.target}</span> : null}</div>
                  <div className="text-[11px] text-faint">{a.module}</div>
                </div>
                <span className="shrink-0 text-xs text-faint">{fmtTime(a.ts)}</span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  )
}

function Gauge({ value, color }: { value: number; color: string }) {
  const r = 34
  const c = 2 * Math.PI * r
  const off = c - (value / 100) * c
  return (
    <div className="relative h-24 w-24 shrink-0">
      <svg viewBox="0 0 80 80" className="h-24 w-24 -rotate-90">
        <circle cx="40" cy="40" r={r} fill="none" stroke="rgb(var(--line))" strokeWidth="7" />
        <circle cx="40" cy="40" r={r} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={off} />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-xl font-bold text-fg">{value}</div>
    </div>
  )
}

function ChannelsTab({ accountId }: { accountId: string }) {
  const [state, setState] = useState<{ loading: boolean; busy: boolean; busyLabel?: string; error?: string; items: AccountChannel[] }>({ loading: true, busy: false, items: [] })
  useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, loading: true }))
    void fetchAccountChannels(accountId).then((r) => {
      if (!alive) return
      setState({ loading: false, busy: r.busy, busyLabel: r.busyIn?.moduleLabel, error: r.error, items: r.channels })
    }).catch((e) => alive && setState({ loading: false, busy: false, error: e instanceof Error ? e.message : 'error', items: [] }))
    return () => { alive = false }
  }, [accountId])

  if (state.loading) return <LiveLoading label="Загрузка каналов из Telegram…" />
  if (state.busy) return <BusyNotice label={state.busyLabel} />
  if (state.error) return <ErrorNotice error={state.error} />
  if (!state.items.length) return <div className="py-10 text-center text-sm text-muted">Каналов и групп не найдено</div>
  return (
    <div className="max-h-96 space-y-1.5 overflow-y-auto">
      {state.items.map((c) => (
        <div key={c.id} className="flex items-center gap-3 rounded-xl border border-line bg-elevated/40 px-3 py-2.5">
          <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg text-xs font-bold', c.kind === 'channel' ? 'bg-iris-500/15 text-iris-300' : 'bg-spark-500/15 text-spark-300')}>
            {c.kind === 'channel' ? <Hash size={15} /> : <User size={15} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-fg">{c.title}</div>
            <div className="truncate text-xs text-muted">{c.username ? `@${c.username}` : c.kind === 'channel' ? 'Канал' : 'Группа'}{c.members ? ` · ${c.members.toLocaleString('ru-RU')} уч.` : ''}</div>
          </div>
          {c.unread > 0 && <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[11px] font-bold text-rose-300">{c.unread}</span>}
        </div>
      ))}
    </div>
  )
}

function FoldersTab({ accountId }: { accountId: string }) {
  const [state, setState] = useState<{ loading: boolean; busy: boolean; busyLabel?: string; error?: string; items: AccountFolder[] }>({ loading: true, busy: false, items: [] })
  useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, loading: true }))
    void fetchAccountFolders(accountId).then((r) => {
      if (!alive) return
      setState({ loading: false, busy: r.busy, busyLabel: r.busyIn?.moduleLabel, error: r.error, items: r.folders })
    }).catch((e) => alive && setState({ loading: false, busy: false, error: e instanceof Error ? e.message : 'error', items: [] }))
    return () => { alive = false }
  }, [accountId])

  if (state.loading) return <LiveLoading label="Загрузка папок из Telegram…" />
  if (state.busy) return <BusyNotice label={state.busyLabel} />
  if (state.error) return <ErrorNotice error={state.error} />
  if (!state.items.length) return <div className="py-10 text-center text-sm text-muted">Папок нет</div>
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {state.items.map((f, i) => (
        <div key={f.id ?? i} className="flex items-center gap-3 rounded-xl border border-line bg-elevated/40 px-3 py-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-iris-500/15 text-iris-300"><FolderClosed size={15} /></span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-fg">{f.title}</div>
            <div className="text-xs text-muted">{f.included} чатов{f.pinned ? ` · ${f.pinned} закреп.` : ''}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

function LiveLoading({ label }: { label: string }) {
  return <div className="flex items-center justify-center gap-2 py-14 text-muted"><Loader2 size={18} className="animate-spin" /> {label}</div>
}
function BusyNotice({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      <Loader2 size={22} className="animate-spin text-amber-300" />
      <div className="text-sm font-semibold text-fg">Аккаунт занят{label ? ` в «${label}»` : ''}</div>
      <div className="text-xs text-muted">Данные из Telegram доступны, когда аккаунт свободен.</div>
    </div>
  )
}
function ErrorNotice({ error }: { error: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      <AlertCircle size={22} className="text-rose-300" />
      <div className="text-sm font-semibold text-fg">Не удалось загрузить</div>
      <div className="text-xs text-muted">{error === 'no_session' ? 'Нет сессии — требуется реавторизация' : error}</div>
    </div>
  )
}
