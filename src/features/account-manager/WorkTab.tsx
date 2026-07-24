import { useEffect, useState } from 'react'
import { Zap, AlertTriangle, Contact, ListChecks } from 'lucide-react'
import { fetchAccountWork, type AccountWork } from '@/api/accountsApi'
import { coins as fmtCoins } from '@/shared/lib/utils'

/**
 * «Работа» — что аккаунт нам ПРИНЁС, в отличие от остальных вкладок, которые
 * описывают, кто он такой (профиль, прокси, здоровье, каналы).
 *
 * Владелец покупает аккаунты за деньги и должен видеть отдачу каждого: этот собрал
 * 800 строк, а тот сжёг токены и привёл ноль лидов. Без такого разреза решение
 * «какие профили докупать, а какие списать» принимается на ощупь.
 *
 * Действия задачи делятся на число участвовавших аккаунтов — приписать все 500
 * комментариев каждому из пяти профилей значило бы впятеро завысить отдачу.
 */
export function WorkTab({ accountId }: { accountId: string }) {
  const [work, setWork] = useState<AccountWork | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    void fetchAccountWork(accountId)
      .then((w) => { if (alive) setWork(w) })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : 'Не удалось загрузить') })
    return () => { alive = false }
  }, [accountId])

  if (err) return <div className="p-4 text-sm text-red-300">{err}</div>
  if (!work) return <div className="p-4 text-sm text-muted">Загрузка…</div>

  const fmt = (n: number) => new Intl.NumberFormat('ru-RU').format(Math.round(n))
  const never = !work.tasks && !work.tokens

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat icon={<ListChecks size={14} />} label="Задач" value={fmt(work.tasks)}
          hint={work.lastUsed ? `последняя ${new Date(work.lastUsed).toLocaleDateString('ru-RU')}` : 'не участвовал'} />
        <Stat icon={<Zap size={14} />} label="Действий" value={fmt(work.actions)}
          hint="доля этого аккаунта" />
        <Stat icon={<Zap size={14} />} label="Токенов" value={fmt(work.tokens)}
          hint={work.tokenCoins ? `${fmtCoins(work.tokenCoins)} ⚡ за ИИ` : 'ИИ не использовал'} />
        <Stat icon={<Contact size={14} />} label="Лидов" value={fmt(work.leads.total)}
          hint={`${work.leads.active} в работе · ${work.leads.target} довели до цели`} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-line bg-elevated p-4">
          <div className="text-xs text-muted">Обошёлся всего</div>
          <div className="font-display text-2xl font-bold text-amber-300">{fmtCoins(work.totalCoins)} ⚡</div>
          <div className="mt-1 text-[11px] text-muted">
            за действия {fmtCoins(work.spent)} · за ИИ {fmtCoins(work.tokenCoins)}
          </div>
        </div>
        <div className="rounded-2xl border border-line bg-elevated p-4">
          <div className="flex items-center gap-1.5 text-xs text-muted"><AlertTriangle size={13} /> Ошибок в его задачах</div>
          <div className={`font-display text-2xl font-bold ${work.errors ? 'text-red-300' : 'text-fg'}`}>{fmt(work.errors)}</div>
          <div className="mt-1 text-[11px] text-muted">
            {work.errors ? 'частые ошибки — повод проверить прокси и прогрев' : 'работает без сбоев'}
          </div>
        </div>
      </div>

      {never ? (
        <div className="rounded-2xl border border-line bg-elevated p-6 text-center text-sm text-muted">
          Аккаунт ещё ни в чём не участвовал.
        </div>
      ) : (
        <>
          <div className="rounded-2xl border border-line bg-elevated p-4">
            <div className="mb-2.5 text-sm font-semibold text-fg">Куда уходила работа</div>
            <div className="space-y-1.5">
              {work.byModule.map((m) => (
                <div key={m.moduleKey} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-line/40 pb-1.5 text-sm last:border-0">
                  <span className="text-fg">{m.title}</span>
                  <span className="tabular-nums text-muted">
                    {fmt(m.tasks)} задач · <span className="text-fg">{fmt(m.actions)} действий</span>
                    {m.tokens ? ` · ${fmt(m.tokens)} ток.` : ''}
                    {m.spent ? <span className="text-amber-300"> · {fmtCoins(m.spent)} ⚡</span> : null}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {!!work.recent.length && (
            <div className="rounded-2xl border border-line bg-elevated p-4">
              <div className="mb-2.5 text-sm font-semibold text-fg">Последние задачи</div>
              <div className="space-y-1">
                {work.recent.map((t) => (
                  <div key={t.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                    <span className="text-fg">{t.title}</span>
                    <span className="text-muted">{t.status}</span>
                    <span className="text-muted">{fmt(t.actions)} действий</span>
                    <span className="ml-auto text-faint">{t.at ? new Date(t.at).toLocaleString('ru-RU') : ''}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Stat({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-elevated p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted">{icon}{label}</div>
      <div className="font-display text-2xl font-bold text-fg">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted">{hint}</div>}
    </div>
  )
}
