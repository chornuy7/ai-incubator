import { useEffect, useState } from 'react'
import { Radio, Plus, RefreshCw, Trash2, ExternalLink, MessageSquare } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { PageHeader, Card, EmptyState, Badge } from '@/shared/ui'
import { fetchChannels, upsertChannel, updateChannel, refreshChannel, deleteChannel, channelRating, type Channel } from '@/api/channelsApi'

function fmt(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n)
}
function ago(ts: number | null) {
  if (!ts) return 'не обновлялось'
  const min = Math.round((Date.now() - ts) / 60000)
  if (min < 1) return 'только что'
  if (min < 60) return `${min} мин назад`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} ч назад`
  return `${Math.round(h / 24)} дн назад`
}

export function ChannelsPage() {
  const pushToast = useApp((s) => s.pushToast)
  const [channels, setChannels] = useState<Channel[]>([])
  const [loading, setLoading] = useState(true)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const load = async () => {
    try { setChannels(await fetchChannels()) }
    catch (err) { pushToast({ type: 'error', title: 'Не удалось загрузить каналы', desc: err instanceof Error ? err.message : '' }) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  const add = async () => {
    const list = input.split(/[\n,;]+/).map((s) => s.trim().replace(/^https?:\/\/t\.me\//, '@').replace(/^@?/, '@')).filter((s) => s.length > 1)
    if (!list.length) return
    try {
      for (const u of list) await upsertChannel({ username: u, source: 'manual' })
      setInput('')
      pushToast({ type: 'success', title: `Добавлено каналов: ${list.length}` })
      await load()
    } catch (err) { pushToast({ type: 'error', title: 'Ошибка', desc: err instanceof Error ? err.message : '' }) }
  }

  const refresh = async (c: Channel) => {
    setBusy(c.id)
    try {
      await refreshChannel(c.id)
      pushToast({ type: 'success', title: 'Статистика обновлена', desc: c.username || c.title })
      await load()
    } catch (err) { pushToast({ type: 'error', title: 'Не удалось обновить', desc: err instanceof Error ? err.message : '' }) }
    finally { setBusy(null) }
  }

  const toggleBot = async (c: Channel) => {
    try { await updateChannel(c.id, { botInGroup: !c.botInGroup }); await load() }
    catch (err) { pushToast({ type: 'error', title: 'Ошибка', desc: err instanceof Error ? err.message : '' }) }
  }

  const remove = async (c: Channel) => {
    if (!window.confirm(`Удалить канал ${c.username || c.title} из базы?`)) return
    try { await deleteChannel(c.id); await load() }
    catch (err) { pushToast({ type: 'error', title: 'Ошибка', desc: err instanceof Error ? err.message : '' }) }
  }

  return (
    <div>
      <PageHeader
        title="Каналы"
        subtitle="Общая база каналов: без дублей, со статистикой. «Обновить сейчас» тянет свежие данные свободным аккаунтом (§3.9)."
        icon={<Radio size={22} />}
        badge={channels.length ? `${channels.length}` : undefined}
      />

      <div className="mb-3 flex gap-2">
        <input className="input h-10 flex-1" value={input} onChange={(e) => setInput(e.target.value)} placeholder="@channel или t.me/channel (можно несколько через запятую)" onKeyDown={(e) => e.key === 'Enter' && void add()} />
        <button onClick={() => void add()} className="btn-primary h-10"><Plus size={16} /> Добавить</button>
      </div>

      {loading ? (
        <Card className="p-6 text-sm text-white/50">Загрузка…</Card>
      ) : channels.length === 0 ? (
        <EmptyState icon={<Radio size={26} />} title="База каналов пуста" desc="Добавьте каналы вручную или они попадут сюда из парсера (без дублей)." />
      ) : (
        <div className="flex flex-col gap-2">
          {channels.map((c) => (
            <Card key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-semibold text-white">{c.title || c.username || c.link}</span>
                  {(() => { const r = channelRating(c); return <span title="Рейтинг: приоритет активности, не только подписчики (§3.8)" className="cursor-help"><Badge tone={r >= 7 ? 'spark' : r >= 4 ? 'amber' : 'rose'}>★ {r}/10</Badge></span> })()}
                  {c.hasComments && <Badge tone="iris"><MessageSquare size={10} className="mb-0.5 inline" /> комменты</Badge>}
                  {c.activityLabel && <Badge tone={c.activityLabel === 'high' ? 'spark' : c.activityLabel === 'medium' ? 'amber' : c.activityLabel === 'stale' ? 'rose' : 'muted'}>{({ high: 'активный', medium: 'умеренный', low: 'редко', stale: 'нет постов' } as const)[c.activityLabel]}</Badge>}
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-white/40">
                  {c.username && <span>@{c.username}</span>}
                  <span>{fmt(c.subscribers)} подписчиков</span>
                  {c.language && <span>{c.language}</span>}
                  {c.region && <span>{c.region}</span>}
                  <span>обновлено: {ago(c.lastStatsAt)}</span>
                  {c.lastPostAt ? <span>последний пост: {ago(c.lastPostAt)}</span> : null}
                  <button onClick={() => void toggleBot(c)} className={c.botInGroup ? 'text-spark-300' : 'text-white/40 hover:text-white/70'} title="Если бот в группе — авто-обновление ~раз в час, иначе раз в день">
                    {c.botInGroup ? '🤖 бот в группе (авто ~1ч)' : 'нет бота (авто 1/день)'}
                  </button>
                  {c.sources?.length > 1 && <span>источников: {c.sources.length}</span>}
                </div>
              </div>
              <div className="flex items-center gap-1">
                {c.username && <a href={`https://t.me/${c.username}`} className="btn-icon h-8 w-8" aria-label="Открыть в Telegram"><ExternalLink size={14} /></a>}
                <button onClick={() => void refresh(c)} disabled={busy === c.id} className="btn-ghost h-8 text-xs" title="Обновить сейчас"><RefreshCw size={13} className={busy === c.id ? 'animate-spin' : ''} /> Обновить</button>
                <button onClick={() => void remove(c)} className="btn-icon h-8 w-8" aria-label="Удалить"><Trash2 size={14} /></button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
