import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
  UserCog, Shield, Bell, Handshake, Cable, Save, Copy, Zap, History as HistoryIcon, Package, CalendarClock } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { fetchBalance, fetchWalletHistory, type Balance, type WalletEntry } from '@/api/balanceApi'
import { useSession } from '@/features/auth/session'
import { PageHeader, Card, Switch, Badge } from '@/shared/ui'
import { cn, coins as fmtCoins } from '@/shared/lib/utils'
import { useTabParam } from '@/shared/lib/useTabParam'

// MR-158: «Настройки профиля» и «Настройки аккаунта» объединены в один раздел.
const TABS = [
  { key: 'profile', label: 'Профиль и аккаунт', icon: UserCog },
  { key: 'security', label: 'Настройки безопасности', icon: Shield },
  { key: 'notifications', label: 'Уведомления', icon: Bell },
  { key: 'partner', label: 'Партнёрская программа', icon: Handshake },
  { key: 'api', label: 'API', icon: Cable },
]

export function ProfilePage() {
  const data = useApp((s) => s.data)
  // Тариф, лимит и баланс — с сервера, а не из моков: раньше на странице профиля
  // висели те же нарисованные «Базовая» и 80.00, что и в шапке, и пополнение
  // сверить было не с чем.
  const [balance, setBalance] = useState<Balance | null>(null)
  useEffect(() => {
    const load = () => { void fetchBalance().then(setBalance).catch(() => {}) }
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [])
  const updateUser = useApp((s) => s.updateUser)
  const toggleNotification = useApp((s) => s.toggleNotification)
  const pushToast = useApp((s) => s.pushToast)
  const sessionUser = useSession((s) => s.user)
  const [tab, setTab] = useTabParam<string>('profile')

  const [firstName, setFirstName] = useState(data.user.firstName)
  const [lastName, setLastName] = useState(data.user.lastName)
  const [nick, setNick] = useState(data.user.nick)
  // MR-158: смена пароля с валидацией (длина ≥ 8, новый ≠ текущий, повтор совпадает).
  const [pwCur, setPwCur] = useState('')
  const [pwNew, setPwNew] = useState('')
  const [pwRepeat, setPwRepeat] = useState('')

  const save = () => { updateUser({ firstName, lastName, nick }); pushToast({ type: 'success', title: 'Изменения сохранены' }) }
  const saveSecurity = () => {
    if (!pwNew && !pwRepeat && !pwCur) { pushToast({ type: 'success', title: 'Настройки безопасности сохранены' }); return }
    if (pwNew.length < 8) { pushToast({ type: 'error', title: 'Пароль слишком короткий', desc: 'Минимум 8 символов' }); return }
    if (!/[0-9]/.test(pwNew) || !/[a-zA-Zа-яА-Я]/.test(pwNew)) { pushToast({ type: 'error', title: 'Слабый пароль', desc: 'Нужны и буквы, и цифры' }); return }
    if (pwNew !== pwRepeat) { pushToast({ type: 'error', title: 'Пароли не совпадают' }); return }
    if (pwNew === pwCur) { pushToast({ type: 'error', title: 'Новый пароль совпадает с текущим' }); return }
    setPwCur(''); setPwNew(''); setPwRepeat('')
    pushToast({ type: 'success', title: 'Пароль обновлён' })
  }

  const refLink = 'https://incubator.ai/r/illia7'

  return (
    <div>
      <PageHeader title="Мой аккаунт" subtitle="Профиль, безопасность и интеграции" icon={<UserCog size={22} />} />

      {/* План и подписка: какой тариф/набор подключён и до какого числа. */}
      <SubscriptionCard balance={balance} />

      <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
        {/* Subtabs */}
        <Card className="h-max p-2">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn('flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors', tab === t.key ? 'bg-spark-500/12 text-spark-300' : 'text-muted hover:bg-elevated hover:text-fg')}
            >
              <t.icon size={17} /> {t.label}
            </button>
          ))}
        </Card>

        {/* Content */}
        <div>
          {tab === 'profile' && (
            <div className="space-y-4">
            <Card>
              <div className="mb-5 flex items-center gap-4">
                <div className="grid h-16 w-16 place-items-center rounded-2xl bg-iris-gradient text-2xl font-bold text-white">
                  {(sessionUser?.name || `${firstName} ${lastName}`).trim().slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <div className="font-display text-lg font-bold text-fg">{sessionUser?.name || `${firstName} ${lastName}`}</div>
                  <div className="truncate text-sm text-muted">{sessionUser?.email || `@${nick} · ${data.user.email}`}</div>
                  {/* Свой UID — чтобы можно было отправить в поддержку при обращении. */}
                  {sessionUser?.id && (
                    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
                      <span className="font-mono">UID: {sessionUser.id}</span>
                      <button
                        onClick={() => { void navigator.clipboard?.writeText(sessionUser.id || ''); pushToast({ type: 'success', title: 'UID скопирован', desc: 'Можно отправить в поддержку' }) }}
                        className="text-spark-300 hover:underline"
                      >
                        копировать
                      </button>
                    </div>
                  )}
                  {sessionUser && (
                    <Badge tone={sessionUser.isAdmin ? 'iris' : 'spark'}>
                      {sessionUser.isAdmin ? 'Администратор' : `Роль: ${sessionUser.roleName || 'не задана'}`}
                    </Badge>
                  )}
                </div>
                <button onClick={() => pushToast({ type: 'info', title: 'Загрузка аватара (демо)' })} className="btn-ghost ml-auto h-9">Сменить фото</button>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div><label className="label">Имя</label><input value={firstName} onChange={(e) => setFirstName(e.target.value)} className="input" /></div>
                <div><label className="label">Фамилия</label><input value={lastName} onChange={(e) => setLastName(e.target.value)} className="input" /></div>
                <div><label className="label">Никнейм</label><input value={nick} onChange={(e) => setNick(e.target.value)} className="input" /></div>
                <div><label className="label">E-mail</label><input value={data.user.email} disabled className="input opacity-60" /></div>
              </div>
              <div className="mt-5 flex justify-end"><button onClick={save} className="btn-primary h-10"><Save size={16} /> Сохранить изменения</button></div>
            </Card>

            {/* MR-158: бывшая вкладка «Настройки аккаунта» — тариф/лимиты/часовой пояс.
                «История операций» убрана из профиля (живёт в разделе подписки). */}
            <Card className="space-y-5">
              <div className="flex items-center justify-between rounded-2xl border border-line bg-elevated p-4">
                <div><div className="text-sm text-muted">Текущий тариф</div><div className="font-display text-lg font-bold text-fg">{balance?.plan.name ?? data.plan.name}</div></div>
                <button onClick={() => pushToast({ type: 'info', title: 'Смена тарифа (демо)' })} className="btn-iris h-10">Изменить тариф</button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-line bg-elevated p-4"><div className="text-sm text-muted">Лимит аккаунтов</div><div className="font-display text-lg font-bold text-fg">{data.accounts.filter((a) => !a.inTrash).length} / {balance?.plan.accountLimit ?? data.plan.accountLimit}</div></div>
                <div className="rounded-2xl border border-line bg-elevated p-4"><div className="flex items-center gap-1.5 text-sm text-muted"><Zap size={14} className="text-amber-400" /> Баланс монет</div><div className="font-display text-lg font-bold text-fg">{fmtCoins(balance?.coins ?? data.coins)}</div></div>
              </div>

              <div>
                <label className="label">Часовой пояс</label>
                <select defaultValue="Europe/Kyiv" className="input max-w-xs">
                  <option value="Europe/Kyiv">Киев (UTC+3)</option>
                  <option value="Europe/Moscow">Москва (UTC+3)</option>
                  <option value="Europe/Warsaw">Варшава (UTC+2)</option>
                  <option value="Europe/London">Лондон (UTC+1)</option>
                  <option value="UTC">UTC</option>
                </select>
              </div>
              <div className="flex justify-between rounded-2xl border border-rose-500/30 bg-rose-500/8 p-4">
                <div><div className="text-sm font-bold text-fg">Удалить аккаунт</div><div className="text-xs text-muted">Все данные будут удалены безвозвратно</div></div>
                <button onClick={() => pushToast({ type: 'error', title: 'Удаление в демо отключено' })} className="btn-danger h-9">Удалить</button>
              </div>
            </Card>
            </div>
          )}

          {tab === 'security' && (
            <Card className="space-y-5">
              <div>
                <div className="mb-3 text-sm font-bold text-fg">Смена пароля</div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div><label className="label">Текущий пароль</label><input type="password" value={pwCur} onChange={(e) => setPwCur(e.target.value)} className="input" placeholder="••••••••" /></div>
                  <div /><div><label className="label">Новый пароль</label><input type="password" value={pwNew} onChange={(e) => setPwNew(e.target.value)} className="input" placeholder="минимум 8 символов" /></div>
                  <div><label className="label">Повторите пароль</label><input type="password" value={pwRepeat} onChange={(e) => setPwRepeat(e.target.value)} className="input" placeholder="••••••••" /></div>
                </div>
                {pwNew && pwNew.length < 8 && <div className="mt-2 text-xs text-rose-300">Пароль должен быть не короче 8 символов.</div>}
                {pwRepeat && pwNew !== pwRepeat && <div className="mt-1 text-xs text-rose-300">Пароли не совпадают.</div>}
              </div>
              <div className="border-t border-line pt-4">
                <Switch checked label="Двухфакторная аутентификация" desc="Дополнительная защита входа через приложение" onChange={() => pushToast({ type: 'info', title: '2FA (демо)' })} />
              </div>
              <div className="border-t border-line pt-4">
                <div className="mb-2 text-sm font-bold text-fg">Активные сессии</div>
                <div className="space-y-2">
                  {[['Windows · Chrome', 'Киев · сейчас', true], ['iPhone · Safari', 'Киев · 2 дня назад', false]].map(([d, loc, cur]) => (
                    <div key={d as string} className="flex items-center justify-between rounded-xl border border-line bg-elevated p-3">
                      <div><div className="text-sm font-semibold text-fg">{d}</div><div className="text-xs text-muted">{loc}</div></div>
                      {cur ? <Badge tone="spark">Текущая</Badge> : <button onClick={() => pushToast({ type: 'success', title: 'Сессия завершена (демо)' })} className="btn-ghost h-8 text-xs">Завершить</button>}
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex justify-end"><button onClick={saveSecurity} className="btn-primary h-10"><Save size={16} /> Сохранить</button></div>
            </Card>
          )}

          {tab === 'notifications' && (
            <Card className="space-y-1">
              {data.notifications.map((n, i) => (
                <div key={n.id} className={cn('flex items-center justify-between gap-4 py-3.5', i > 0 && 'border-t border-line')}>
                  <div><div className="text-sm font-bold text-fg">{n.label}</div><div className="text-xs text-muted">{n.desc}</div></div>
                  <Switch checked={n.enabled} onChange={() => toggleNotification(n.id)} />
                </div>
              ))}
            </Card>
          )}

          {tab === 'partner' && (
            // MR-158: партнёрка пока недоступна — контент под blur + пометка «Скоро».
            <div className="relative">
              <div className="pointer-events-none select-none space-y-4 blur-sm">
                <div className="grid gap-3 sm:grid-cols-3">
                  {[['Приглашено', '12'], ['Активных', '5'], ['Заработано', '340 ⚡']].map(([l, v]) => (
                    <Card key={l} className="p-4"><div className="font-display text-2xl font-bold text-fg">{v}</div><div className="text-xs text-muted">{l}</div></Card>
                  ))}
                </div>
                <Card>
                  <div className="text-sm font-bold text-fg">Ваша реферальная ссылка</div>
                  <div className="mt-2 flex gap-2">
                    <input value={refLink} readOnly className="input font-mono text-sm" />
                    <button className="btn-primary h-[42px] px-4"><Copy size={16} /></button>
                  </div>
                  <p className="mt-2 text-xs text-muted">Получайте 20% от пополнений приглашённых пользователей в монетах ⚡.</p>
                </Card>
              </div>
              <div className="absolute inset-0 grid place-items-center">
                <div className="rounded-2xl border border-line bg-elevated/90 px-5 py-3 text-center shadow-lg">
                  <div className="text-sm font-bold text-fg">Партнёрская программа скоро</div>
                  <div className="mt-0.5 text-xs text-muted">Раздел в разработке — уведомим о запуске.</div>
                </div>
              </div>
            </div>
          )}

          {tab === 'api' && (
            <Card className="space-y-3">
              <div className="text-sm font-semibold text-fg">Приватный API — «мозги» проекта</div>
              <p className="text-sm text-muted">
                Ключ доступа <b className="text-fg">не выпускается в интерфейсе</b> и не хранится в базе:
                это один сервисный ключ, он живёт только в окружении сервера (<code>MURMEX_API_KEY</code>).
                Так его нельзя выбрать или скопировать из панели.
              </p>
              {sessionUser?.isAdmin || !sessionUser ? (
                <p className="text-sm text-muted">
                  Как задать ключ и подключиться (API / MCP) — в админ-панели, вкладка <b className="text-fg">API</b>.
                </p>
              ) : (
                <p className="text-sm text-muted">
                  Настройку ключа выполняет владелец рабочего пространства на сервере.
                </p>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}


/**
 * История операций по кошельку: когда, за что, сколько и что осталось.
 *
 * Показываем «до → после» рядом с суммой: одна цифра «−0.15» не даёт понять, было
 * это списание с 80 или последние монеты. Свои операции видит каждый, чужие — только
 * админ (проверяется на сервере).
 */
export function WalletHistory() {
  const [rows, setRows] = useState<WalletEntry[] | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open || rows) return
    void fetchWalletHistory(50).then(setRows).catch(() => setRows([]))
  }, [open, rows])

  return (
    <div className="rounded-2xl border border-line bg-elevated p-4">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 text-left">
        <HistoryIcon size={15} className="text-muted" />
        <span className="text-sm font-semibold text-fg">История операций</span>
        <span className="ml-auto text-xs text-muted">{open ? 'свернуть' : 'показать'}</span>
      </button>

      {open && (
        <div className="mt-3">
          {!rows ? (
            <div className="text-sm text-muted">Загрузка…</div>
          ) : !rows.length ? (
            <div className="text-sm text-muted">Операций пока не было.</div>
          ) : (
            <div className="space-y-1">
              {rows.map((r, i) => (
                <div key={r.ts + '-' + i} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-line/40 py-1.5 text-sm last:border-0">
                  <span className={cn('w-20 shrink-0 font-semibold tabular-nums', r.amount > 0 ? 'text-spark-300' : 'text-amber-300')}>
                    {r.amount > 0 ? '+' : ''}{fmtCoins(r.amount)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted">{r.reason || 'без описания'}</span>
                  <span className="shrink-0 text-xs tabular-nums text-faint">{fmtCoins(r.before)} → {fmtCoins(r.after)}</span>
                  <span className="shrink-0 text-xs text-faint">{new Date(r.ts).toLocaleString('ru-RU')}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * План и подписка: какой тариф/набор подключён и до какого числа. Срок берётся с
 * сервера (expiresAt); нет срока — «бессрочно (демо)», пока не подключён провайдер.
 */
function SubscriptionCard({ balance }: { balance: Balance | null }) {
  const modules = balance?.modules
  const sub = modules === 'all' || modules == null ? 'Все модули' : `${modules.length} ${modules.length === 1 ? 'модуль' : 'модулей'}`
  const exp = balance?.expiresAt || 0
  const now = Date.now()
  const active = !exp || exp > now
  const fmtDate = (ts: number) => new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const daysLeft = exp ? Math.max(0, Math.ceil((exp - now) / (24 * 60 * 60 * 1000))) : 0
  return (
    <Card className="mb-4 p-4">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
        <div className="flex items-center gap-2.5">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-spark-500/12 text-spark-300"><Package size={18} /></div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted">Тариф</div>
            <div className="font-semibold text-fg">{balance?.plan?.name || '—'}</div>
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted">Подписка</div>
          <div className="font-semibold text-fg">{sub}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted">Срок</div>
          <div className={cn('flex items-center gap-1.5 font-semibold', active ? 'text-fg' : 'text-red-300')}>
            <CalendarClock size={14} className="text-muted" />
            {exp ? (active ? `активна до ${fmtDate(exp)}` : `истекла ${fmtDate(exp)}`) : 'бессрочно (демо)'}
          </div>
          {!!exp && active && <div className="text-[11px] text-muted">осталось {daysLeft} дн.</div>}
        </div>
        <Link to="/panel/user/subscription" className="btn-ghost ml-auto h-9 border border-line text-sm"><Package size={14} /> Подписки</Link>
      </div>
    </Card>
  )
}
