import { useEffect, useState, useCallback } from 'react'
import { WorkTab } from './WorkTab'
import {
  User, Globe, BarChart3, Calendar, Zap, HeartPulse, Hash,
  Copy, Check, ShieldCheck, ShieldAlert, ShieldQuestion, Loader2, RefreshCw, Unlock, AlertCircle, Server, LogOut, ExternalLink,
} from 'lucide-react'
import { Modal, Avatar, Segmented } from '@/shared/ui'
import { cn } from '@/shared/lib/utils'
import { useApp } from '@/mocks/store'
import { confirmDialog } from '@/shared/lib/dialog'
import { ChangeProxyModal } from './ChangeProxyModal'
import {
  fetchAccountStats, fetchAccountChannels, leaveAccountChannel, releaseAccountLock,
  fetchAccountDaily, type AccountDaily,
} from '@/api/accountsApi'
import type { TgAccount, AccountStats, AccountChannel } from '@/shared/types'
import { FLAGS as GEO_FLAGS, COUNTRY_NAME } from '@/shared/config/geo'

// MR-129 (10.08): табы переставлены по значимости и сокращены. «Статус» и «Действия»
// переехали в шапку (статус уже там, кнопки-проверки — рядом с ним), «Даты» — в Профиль.
// «Здоровье» поднято вперёд (сверхважный критерий). MR-129: вкладку «Группы» (Telegram-папки)
// убрали — она всегда была пустой и дублировала «Каналы» (там и каналы, и группы).
export type TabKey = 'profile' | 'health' | 'proxy' | 'work' | 'channels'

export const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: 'profile', label: 'Профиль', icon: <User size={15} /> },
  { key: 'health', label: 'Здоровье', icon: <HeartPulse size={15} /> },
  { key: 'proxy', label: 'Прокси', icon: <Globe size={15} /> },
  { key: 'work', label: 'Работа', icon: <Zap size={15} /> },
  { key: 'channels', label: 'Каналы', icon: <Hash size={15} /> },
]

// Флаг/название страны по коду (регистр не важен) — полный набор из geo.ts (14 стран).
const flagOf = (code?: string | null) => (code ? GEO_FLAGS[code.toLowerCase()] ?? '' : '')
const nameOf = (code?: string | null) => (code ? COUNTRY_NAME[code.toLowerCase()] ?? code.toUpperCase() : '')

function fmtDate(ts: number | null | undefined) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function fmtTime(ts: string) {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  return d.toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/**
 * Тело карточки аккаунта: баннер, вкладки и их содержимое.
 *
 * Вынесено из модалки, чтобы одну и ту же карточку можно было показать двумя способами:
 * боковой панелью (user-панель) и раскрытой строкой прямо под аккаунтом (админка).
 * Логика загрузки и действий живёт здесь — оба способа получают её одинаковой.
 */
export function AccountCardBody({ account }: { account: TgAccount }) {
  const pushToast = useApp((s) => s.pushToast)
  const loadAccountBusy = useApp((s) => s.loadAccountBusy)
  const [tab, setTab] = useState<TabKey>('profile')
  const [stats, setStats] = useState<AccountStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [spamChecking, setSpamChecking] = useState(false)
  const [releasing, setReleasing] = useState(false)

  const load = useCallback(async (opts?: { spam?: boolean }) => {
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
    setStats(null)
    setTab('profile')
    void load()
  }, [account.id])

  const runSpamCheck = async () => {
    setSpamChecking(true)
    try {
      await load({ spam: true })
      pushToast({ type: 'success', title: 'Спамблок проверен через @SpamBot' })
    } finally {
      setSpamChecking(false)
    }
  }

  const runRelease = async () => {
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
        <div className="space-y-4">
          <HeroBanner
            account={account}
            stats={stats}
            actions={{
              loading, spamChecking, releasing,
              onRecheck: () => void load(),
              onSpamCheck: () => void runSpamCheck(),
              onRelease: () => void runRelease(),
            }}
          />

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
              {tab === 'work' && <WorkTab accountId={account.id} />}
              {tab === 'proxy' && <ProxyTab account={account} stats={stats} loading={loading} onRecheck={() => void load()} />}
              {tab === 'health' && <HealthTab stats={stats} accountId={account.id} />}
              {tab === 'channels' && <ChannelsTab accountId={account.id} />}
            </div>
          )}
        </div>
  )
}

/**
 * Та же карточка боковой панелью — как её открывает user-панель.
 * В админке карточка разворачивается прямо под строкой аккаунта, там вызывается
 * AccountCardBody напрямую.
 */
export function AccountManagementModal({ account, onClose }: { account: TgAccount | null; onClose: () => void }) {
  return (
    <Modal
      open={!!account}
      onClose={onClose}
      size="xl"
      // Боковая панель, а не попап посреди экрана: не закрывает список
      // и читается как «деталь выбранной строки».
      side
      icon={<div className="grid h-10 w-10 place-items-center rounded-xl bg-iris-500/15 text-iris-300"><User size={20} /></div>}
      title="Управление аккаунтом"
      subtitle={account ? `${account.name} · @${account.username}` : ''}
      footer={<button onClick={onClose} className="btn-primary h-10">Закрыть</button>}
    >
      {account && <AccountCardBody account={account} />}
    </Modal>
  )
}

/* ── Hero ── */
export function HeroBanner({ account, stats, actions }: {
  account: TgAccount; stats: AccountStats | null
  // MR-129: действия и здоровье вынесены В шапку — раньше огромная шапка была
  // нефункциональной (имя + гео), а проверки/статус/здоровье прятались по табам.
  actions?: {
    loading: boolean; spamChecking: boolean; releasing: boolean
    onRecheck: () => void; onSpamCheck: () => void; onRelease: () => void
  }
}) {
  const geo = stats?.profile.geo ?? account.country.toUpperCase()
  const valid = stats?.status.valid
  /** Проверку сорвал прокси — причина показывается вместо «Невалидный». */
  const blockedBy = stats?.status.checkBlocked ?? null
  const spam = stats?.status.spamblock ?? 'unknown'
  const warmingDays = stats?.status.warmingDays
  const active = stats?.status.warmingActive
  const busy = stats?.busyIn
  const health = stats?.health
  const trust = stats?.trust
  return (
    <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-iris-600 to-iris-800 p-5 text-white">
      <div className="flex items-start gap-4">
        <Avatar name={account.name} color={account.avatarColor} size={54} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xl font-bold">{account.name}</div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-white/80">
            <span className="text-white/90">@{stats?.profile.username ?? account.username}</span>
            <span className="opacity-60">{stats?.profile.phone ?? account.phone}</span>
            <span className="rounded-md bg-white/15 px-1.5 py-0.5 text-xs font-bold">{flagOf(geo)} {nameOf(geo) || geo}</span>
          </div>
          {/* Здоровье и trust — сверхважные критерии, теперь видны сразу в шапке. */}
          {(health || trust) && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              {health && <span className="inline-flex items-center gap-1 rounded-lg bg-white/12 px-2 py-1 font-semibold"><HeartPulse size={12} /> Здоровье {health.score}/100 · {health.label}</span>}
              {trust && <span className="inline-flex items-center gap-1 rounded-lg bg-white/12 px-2 py-1 font-semibold"><BarChart3 size={12} /> Доверие {trust.score}/100</span>}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {/* Проверку мог сорвать ПРОКСИ (не назначен / не отвечает) — тогда про сессию
              ничего не известно, и писать «Невалидный» нельзя: это оговор аккаунта.
              Показываем настоящую причину. */}
          {blockedBy ? (
            <Pill tone="warn">
              <ShieldAlert size={12} />
              {blockedBy === 'no_proxy' ? 'Нет прокси' : 'Прокси не отвечает'}
            </Pill>
          ) : (
            <Pill tone={valid == null ? 'neutral' : valid ? 'ok' : 'bad'}>
              {valid == null ? <ShieldQuestion size={12} /> : valid ? <ShieldCheck size={12} /> : <ShieldAlert size={12} />}
              {valid == null ? 'Проверка…' : valid ? 'Валидный' : 'Невалидный'}
            </Pill>
          )}
          <Pill tone={spam === 'clean' ? 'ok' : spam === 'blocked' ? 'bad' : 'neutral'}>
            {spam === 'clean' ? 'Без спамблока' : spam === 'blocked' ? 'Спамблок' : 'Спамблок: —'}
          </Pill>
          {active && (
            <Pill tone="ok">
              {/* MR-129: это статус, а не загрузка — был вечно крутящийся спиннер. Ставим статичную точку. */}
              <span className="h-1.5 w-1.5 rounded-full bg-current" /> Активен{warmingDays != null ? ` (${warmingDays}д)` : ''}
            </Pill>
          )}
        </div>
      </div>

      {/* MR-131: «зона риска» с конкретикой прямо в шапке — последствие + срок,
          отдельно про прокси и отдельно про статус/здоровье. */}
      {account.risk && account.risk.level !== 'none' && account.risk.factors.length > 0 && (
        <div className={cn(
          'mt-4 space-y-1 rounded-xl border px-3 py-2.5 text-xs leading-relaxed',
          account.risk.level === 'high' ? 'border-rose-300/40 bg-rose-500/20 text-rose-50' : 'border-amber-300/40 bg-amber-500/20 text-amber-50',
        )}>
          <div className="flex items-center gap-1.5 font-bold">
            <ShieldAlert size={13} /> {account.risk.level === 'high' ? 'Зона риска' : 'Повышенный риск'}
          </div>
          {account.risk.factors.map((f, i) => <div key={i} className="opacity-90">• {f.text}</div>)}
        </div>
      )}

      {/* MR-129: статус-кнопки (Обновить / Проверить спамблок / Снять блокировку) — в шапке. */}
      {actions && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-white/15 pt-3">
          <HeroBtn onClick={actions.onRecheck} loading={actions.loading} icon={<RefreshCw size={14} />} label="Обновить" />
          <HeroBtn onClick={actions.onSpamCheck} loading={actions.spamChecking} icon={<ShieldQuestion size={14} />} label="Проверить спамблок" />
          {busy && <HeroBtn onClick={actions.onRelease} loading={actions.releasing} icon={<Unlock size={14} />} label="Снять блокировку" tone="danger" />}
        </div>
      )}
    </div>
  )
}

function HeroBtn({ onClick, loading, icon, label, tone }: {
  onClick: () => void; loading?: boolean; icon: React.ReactNode; label: string; tone?: 'danger'
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-bold transition-colors disabled:opacity-50',
        tone === 'danger' ? 'border-rose-200/50 bg-rose-500/20 text-rose-50 hover:bg-rose-500/30' : 'border-white/25 bg-white/12 text-white hover:bg-white/20',
      )}
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : icon}
      {label}
    </button>
  )
}

function Pill({ children, tone }: { children: React.ReactNode; tone: 'ok' | 'bad' | 'neutral' | 'warn' }) {
  const tones = {
    ok: 'bg-spark-500/25 text-spark-50 border-spark-300/40',
    bad: 'bg-rose-500/25 text-rose-50 border-rose-300/40',
    // Проблема НЕ в аккаунте (прокси) — янтарный, чтобы не путать с «невалидным».
    warn: 'bg-amber-500/30 text-amber-50 border-amber-300/50',
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
export function ProfileTab({ account, stats }: { account: TgAccount; stats: AccountStats | null }) {
  const p = stats?.profile
  const d = stats?.dates
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
        <Field label="Гео" value={p?.geo ? `${flagOf(p.geo)} ${nameOf(p.geo)}` : dash} />
        <Field label="Сессия сохранена" value={p?.saved ? 'Да' : 'Нет'} />
        <Field label="Роль" value={stats?.role ?? account.role ?? dash} />
        <Field label="Проект" value={account.project ?? dash} />
      </SectionCard>
      {/* MR-129: «Даты» больше не отдельный таб — переехали в Профиль (там им и место). */}
      <SectionCard title="Даты" icon={<Calendar size={15} className="text-iris-300" />}>
        <Field label="Добавлен в систему" value={fmtDate(d?.addedAt)} />
        <Field label="Последняя проверка" value={fmtDate(d?.lastCheckAt)} />
        <Field label="Проверка спамблока" value={fmtDate(d?.spamblockAt)} />
        <Field label="Проверка прокси" value={fmtDate(d?.proxyCheckAt)} />
      </SectionCard>
    </div>
  )
}

export function ProxyTab({ account, stats, loading, onRecheck }: { account: TgAccount; stats: AccountStats | null; loading: boolean; onRecheck: () => void }) {
  const px = stats?.proxy
  const setAccountProxy = useApp((s) => s.setAccountProxy)
  const pushToast = useApp((s) => s.pushToast)
  const [changeOpen, setChangeOpen] = useState(false)
  return (
    <>
    <SectionCard
      title="Прокси"
      icon={<Globe size={15} className="text-iris-300" />}
      action={
        <div className="flex items-center gap-2">
          {/* MR-129: сменить прокси прямо из карточки — выбор из базы прокси или ввод нового. */}
          <button onClick={() => setChangeOpen(true)} className="btn-soft h-8 text-xs">
            <Server size={13} /> Сменить прокси
          </button>
          <button onClick={onRecheck} disabled={loading} className="btn-soft h-8 text-xs disabled:opacity-50">
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Проверить
          </button>
        </div>
      }
    >
      {!px?.configured ? (
        // Прокси НЕ назначен. Раньше здесь было «Прямое подключение» — звучало как рабочий
        // режим, хотя на деле аккаунт вообще не проверяется и идёт с общего IP сервера.
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-4 text-center">
          <div className="inline-flex items-center gap-1.5 text-sm font-bold text-amber-200"><ShieldAlert size={15} /> Нет прокси</div>
          <div className="mt-1 text-xs text-amber-200/80">
            Аккаунт не проверяется и не идёт в работу без прокси — назначьте его в менеджере аккаунтов.
          </div>
        </div>
      ) : (
        <>
          <div className="mb-3 rounded-xl border border-line bg-elevated px-3 py-2 font-mono text-xs text-iris-300 break-all">{px.raw}</div>
          <div className="mb-3">
            {px.working == null ? (
              <span className="inline-flex items-center gap-1.5 rounded-lg bg-slate-500/15 px-2.5 py-1 text-xs font-bold text-slate-300"><ShieldQuestion size={13} /> Не проверено</span>
            ) : px.working ? (
              <span className="inline-flex items-center gap-1.5 rounded-lg bg-spark-500/15 px-2.5 py-1 text-xs font-bold text-spark-300"><ShieldCheck size={13} /> Работает</span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-lg bg-rose-500/15 px-2.5 py-1 text-xs font-bold text-rose-300"><ShieldAlert size={13} /> Не отвечает · помечен нерабочим</span>
            )}
            <span className="ml-2 text-xs text-muted">Проверено: {fmtDate(px.checkedAt)}</span>
          </div>
          {/* Причина прямым текстом: почему аккаунт не удалось проверить. */}
          {stats?.status.checkNote && (
            <div className="mb-3 rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-xs text-amber-200">
              {stats.status.checkNote}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <MiniStat label="Протокол" value={px.protocol ?? '—'} />
            <MiniStat label="IP" value={px.ip ?? '—'} />
            <MiniStat label="Порт" value={px.port != null ? String(px.port) : '—'} />
            <MiniStat label="Логин" value={px.login ?? '—'} />
          </div>
        </>
      )}
    </SectionCard>
    <ChangeProxyModal
      acc={changeOpen ? account : null}
      onClose={() => setChangeOpen(false)}
      onSave={(id, p) => { void setAccountProxy(id, p).then(() => { pushToast({ type: 'success', title: 'Прокси обновлён', desc: 'Нажмите «Проверить», чтобы проверить новый прокси' }); setChangeOpen(false); onRecheck() }) }}
    />
    </>
  )
}

/* mini-stat cell */
function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-elevated p-2.5">
      <div className="text-[10px] font-bold uppercase tracking-wide text-faint">{label}</div>
      <div className="mt-0.5 truncate font-mono text-sm font-semibold text-fg">{value}</div>
    </div>
  )
}


const DAILY_ACTION_LABELS: Record<string, string> = {
  comments: 'Комментарии',
  dm: 'ЛС незнакомым',
  joins: 'Вступления',
  reactions: 'Реакции',
}

function DailyLimitsCard({ accountId }: { accountId: string }) {
  const [daily, setDaily] = useState<AccountDaily | null>(null)
  useEffect(() => {
    let alive = true
    void fetchAccountDaily(accountId).then((d) => { if (alive) setDaily(d) }).catch(() => {})
    return () => { alive = false }
  }, [accountId])
  return (
    <SectionCard title="Суточные лимиты" icon={<BarChart3 size={15} className="text-spark-300" />}>
      {!daily ? (
        <div className="py-3 text-center text-sm text-muted">Загрузка…</div>
      ) : (
        <div className="space-y-2.5">
          {daily.items.map((it) => {
            const pct = it.cap ? Math.min(100, Math.round((it.used / it.cap) * 100)) : 0
            const barColor = it.reached ? '#ef4444' : pct >= 75 ? '#f59e0b' : '#0ec464'
            return (
              <div key={it.action}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="text-fg">{DAILY_ACTION_LABELS[it.action] ?? it.action}</span>
                  <span className={cn('font-semibold tabular-nums', it.reached ? 'text-rose-300' : 'text-muted')}>
                    {it.used} / {it.cap}{it.reached ? ' · лимит' : ''}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
                  <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: barColor }} />
                </div>
              </div>
            )
          })}
          <div className="pt-1 text-[11px] text-faint">Сбрасывается в полночь. При достижении потолка модули пропускают аккаунт.</div>
        </div>
      )}
    </SectionCard>
  )
}

function TrustCard({ trust }: { trust: AccountStats['trust'] }) {
  const tone = trust.band === 'high' ? { c: '#0ec464', chip: 'text-spark-300 bg-spark-500/15' }
    : trust.band === 'mid' ? { c: '#f59e0b', chip: 'text-amber-300 bg-amber-500/15' }
    : { c: '#ef4444', chip: 'text-rose-300 bg-rose-500/15' }
  const PARTS: { key: keyof AccountStats['trust']['parts']; label: string; w: string }[] = [
    { key: 'flood', label: 'FloodWait 24ч', w: '40%' },
    { key: 'bans', label: 'История блоков', w: '25%' },
    { key: 'actions', label: 'Чистые действия', w: '15%' },
    { key: 'age', label: 'Возраст / AIR', w: '20%' },
  ]
  return (
    <SectionCard title="Оценка доверия" icon={<BarChart3 size={15} style={{ color: tone.c }} />}>
      <div className="flex items-center gap-4 py-1">
        <Gauge value={trust.score} color={tone.c} />
        <div className="min-w-0">
          <span className={cn('rounded-md px-2 py-0.5 text-xs font-bold', tone.chip)}>{trust.label}</span>
          <div className="mt-1 text-xs text-muted">{trust.hint}</div>
        </div>
      </div>
      <div className="mt-2 space-y-1.5">
        {PARTS.map((p) => (
          <div key={p.key}>
            <div className="mb-0.5 flex items-center justify-between text-[11px]">
              <span className="text-fg">{p.label} <span className="text-faint">· вес {p.w}</span></span>
              <span className="font-semibold tabular-nums text-muted">{trust.parts[p.key]}/100</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
              <div className="h-full rounded-full" style={{ width: `${trust.parts[p.key]}%`, background: tone.c }} />
            </div>
          </div>
        ))}
      </div>
      <div className="pt-2 text-[11px] text-faint">Пороги: &lt;40 — авто-стоп → прогрев · 40–70 — консервативный режим · &gt;70 — в пул.</div>
    </SectionCard>
  )
}

export function HealthTab({ stats, accountId }: { stats: AccountStats | null; accountId: string }) {
  if (!stats) return <div className="py-8 text-center text-sm text-muted">Нет данных</div>
  const { health, longevity, activity, trust } = stats
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

      <TrustCard trust={trust} />

      <DailyLimitsCard accountId={accountId} />

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

export function ChannelsTab({ accountId }: { accountId: string }) {
  const [state, setState] = useState<{ loading: boolean; busy: boolean; busyLabel?: string; error?: string; items: AccountChannel[] }>({ loading: true, busy: false, items: [] })
  useEffect(() => {
    let alive = true
    setState({ loading: true, busy: false, items: [] }) // §3: не показываем каналы/папки прежнего аккаунта, пока грузим нового
    void fetchAccountChannels(accountId).then((r) => {
      if (!alive) return
      setState({ loading: false, busy: r.busy, busyLabel: r.busyIn?.moduleLabel, error: r.error, items: r.channels })
    }).catch((e) => alive && setState({ loading: false, busy: false, error: e instanceof Error ? e.message : 'error', items: [] }))
    return () => { alive = false }
  }, [accountId])

  const pushToast = useApp((s) => s.pushToast)
  const [q, setQ] = useState('')
  const [kind, setKind] = useState(0) // 0 — все, 1 — каналы, 2 — группы
  const [leavingId, setLeavingId] = useState<string | null>(null)

  const leave = async (c: AccountChannel) => {
    if (!(await confirmDialog({
      title: c.kind === 'channel' ? 'Выйти из канала?' : 'Выйти из группы?',
      message: `Аккаунт покинет «${c.title}». Действие можно отменить только повторным вступлением.`,
      confirmLabel: 'Выйти', tone: 'danger',
    }))) return
    setLeavingId(c.id)
    try {
      const r = await leaveAccountChannel(accountId, c.id)
      if (!r.ok) { pushToast({ type: 'error', title: 'Не удалось выйти', desc: r.error || '' }); return }
      setState((s) => ({ ...s, items: s.items.filter((x) => x.id !== c.id) }))
      pushToast({ type: 'success', title: c.kind === 'channel' ? 'Вышли из канала' : 'Вышли из группы', desc: c.title })
    } catch (e) {
      pushToast({ type: 'error', title: 'Ошибка', desc: e instanceof Error ? e.message : '' })
    } finally { setLeavingId(null) }
  }

  if (state.loading) return <LiveLoading label="Загрузка каналов из Telegram…" />
  if (state.busy) return <BusyNotice label={state.busyLabel} />
  if (state.error) return <ErrorNotice error={state.error} />
  if (!state.items.length) return <div className="py-10 text-center text-sm text-muted">Каналов и групп не найдено</div>

  const channelsN = state.items.filter((c) => c.kind === 'channel').length
  const groupsN = state.items.length - channelsN
  const shown = state.items
    .filter((c) => kind === 0 || (kind === 1 ? c.kind === 'channel' : c.kind === 'group'))
    .filter((c) => !q.trim() || `${c.title} ${c.username}`.toLowerCase().includes(q.trim().toLowerCase()))

  return (
    <div className="space-y-2">
      <Segmented options={[`Все · ${state.items.length}`, `Каналы · ${channelsN}`, `Группы · ${groupsN}`]} value={kind} onChange={setKind} size="sm" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="input h-9 text-sm"
        placeholder={`Поиск среди ${state.items.length} каналов/групп…`}
      />
      <div className="max-h-96 space-y-1.5 overflow-y-auto">
      {shown.length === 0 && <div className="py-6 text-center text-sm text-muted">Ничего не найдено</div>}
      {shown.map((c) => (
        <div key={c.id} className="group/ch flex items-center gap-3 rounded-xl border border-line bg-elevated/40 px-3 py-2.5">
          <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg text-xs font-bold', c.kind === 'channel' ? 'bg-iris-500/15 text-iris-300' : 'bg-spark-500/15 text-spark-300')}>
            {c.kind === 'channel' ? <Hash size={15} /> : <User size={15} />}
          </span>
          {/* Клик по строке — открыть канал/группу в Telegram (если есть публичный @username). */}
          {c.username ? (
            <a href={`https://t.me/${c.username}`} target="_blank" rel="noreferrer" className="min-w-0 flex-1" title="Открыть в Telegram">
              <div className="flex items-center gap-1.5 truncate text-sm font-semibold text-fg transition-colors group-hover/ch:text-spark-300">{c.title}<ExternalLink size={12} className="shrink-0 opacity-0 transition-opacity group-hover/ch:opacity-100" /></div>
              <div className="truncate text-xs text-muted">@{c.username}{c.members ? ` · ${c.members.toLocaleString('ru-RU')} уч.` : ''}</div>
            </a>
          ) : (
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-fg">{c.title}</div>
              <div className="truncate text-xs text-muted">{c.kind === 'channel' ? 'Канал' : 'Группа'} · приватный{c.members ? ` · ${c.members.toLocaleString('ru-RU')} уч.` : ''}</div>
            </div>
          )}
          {c.unread > 0 && <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[11px] font-bold text-rose-300">{c.unread}</span>}
          {/* MR-129: «взять отсюда» — копируем ссылку/@username, чтобы вставить канал как цель. */}
          {c.username && (
            <button
              type="button"
              onClick={() => { void navigator.clipboard?.writeText(`https://t.me/${c.username}`); pushToast({ type: 'success', title: 'Скопировано', desc: `@${c.username}` }) }}
              className="btn-icon h-8 w-8 shrink-0 text-muted hover:text-spark-300"
              title="Скопировать ссылку канала (вставить как цель)"
            >
              <Copy size={14} />
            </button>
          )}
          <button
            type="button"
            onClick={() => void leave(c)}
            disabled={leavingId === c.id}
            className="btn-icon h-8 w-8 shrink-0 text-rose-300 hover:bg-rose-500/10 disabled:opacity-50"
            title="Выйти из канала/группы"
          >
            {leavingId === c.id ? <Loader2 size={14} className="animate-spin" /> : <LogOut size={14} />}
          </button>
        </div>
      ))}
      </div>
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
