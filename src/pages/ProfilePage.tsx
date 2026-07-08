import { useState } from 'react'
import {
  UserCog, User, Shield, Bell, Handshake, Cable, Save, Copy, RefreshCw, Eye, EyeOff, Check, Zap,
} from 'lucide-react'
import { useApp } from '@/mocks/store'
import { PageHeader, Card, Switch, Badge } from '@/shared/ui'
import { cn } from '@/shared/lib/utils'

const TABS = [
  { key: 'profile', label: 'Настройки профиля', icon: User },
  { key: 'account', label: 'Настройки аккаунта', icon: UserCog },
  { key: 'security', label: 'Настройки безопасности', icon: Shield },
  { key: 'notifications', label: 'Уведомления', icon: Bell },
  { key: 'partner', label: 'Партнёрская программа', icon: Handshake },
  { key: 'api', label: 'API', icon: Cable },
]

export function ProfilePage() {
  const data = useApp((s) => s.data)
  const updateUser = useApp((s) => s.updateUser)
  const toggleNotification = useApp((s) => s.toggleNotification)
  const pushToast = useApp((s) => s.pushToast)
  const [tab, setTab] = useState('profile')

  const [firstName, setFirstName] = useState(data.user.firstName)
  const [lastName, setLastName] = useState(data.user.lastName)
  const [nick, setNick] = useState(data.user.nick)
  const [showKey, setShowKey] = useState(false)

  const save = () => { updateUser({ firstName, lastName, nick }); pushToast({ type: 'success', title: 'Изменения сохранены' }) }
  const copy = (text: string, label: string) => { navigator.clipboard?.writeText(text).catch(() => {}); pushToast({ type: 'success', title: `${label} скопирован` }) }

  const apiKey = 'aii_live_sk_9f2c8b71e4a6d0f3c5b8a1e7'
  const refLink = 'https://incubator.ai/r/illia7'

  return (
    <div>
      <PageHeader title="Мой аккаунт" subtitle="Профиль, безопасность и интеграции" icon={<UserCog size={22} />} />

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
            <Card>
              <div className="mb-5 flex items-center gap-4">
                <div className="grid h-16 w-16 place-items-center rounded-2xl bg-iris-gradient text-2xl font-bold text-white">{firstName[0]}{lastName[0]}</div>
                <div>
                  <div className="font-display text-lg font-bold text-fg">{firstName} {lastName}</div>
                  <div className="text-sm text-muted">@{nick} · {data.user.email}</div>
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
          )}

          {tab === 'account' && (
            <Card className="space-y-5">
              <div className="flex items-center justify-between rounded-2xl border border-line bg-elevated p-4">
                <div><div className="text-sm text-muted">Текущий тариф</div><div className="font-display text-lg font-bold text-fg">{data.plan.name}</div></div>
                <button onClick={() => pushToast({ type: 'info', title: 'Смена тарифа (демо)' })} className="btn-iris h-10">Изменить тариф</button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-line bg-elevated p-4"><div className="text-sm text-muted">Лимит аккаунтов</div><div className="font-display text-lg font-bold text-fg">{data.accounts.filter((a) => !a.inTrash).length} / {data.plan.accountLimit}</div></div>
                <div className="rounded-2xl border border-line bg-elevated p-4"><div className="flex items-center gap-1.5 text-sm text-muted"><Zap size={14} className="text-amber-400" /> Баланс монет</div><div className="font-display text-lg font-bold text-fg">{data.coins.toFixed(2)}</div></div>
              </div>
              <div>
                <label className="label">Часовой пояс</label>
                <input defaultValue="UTC+3 (Moscow)" className="input max-w-xs" />
              </div>
              <div className="flex justify-between rounded-2xl border border-rose-500/30 bg-rose-500/8 p-4">
                <div><div className="text-sm font-bold text-fg">Удалить аккаунт</div><div className="text-xs text-muted">Все данные будут удалены безвозвратно</div></div>
                <button onClick={() => pushToast({ type: 'error', title: 'Удаление в демо отключено' })} className="btn-danger h-9">Удалить</button>
              </div>
            </Card>
          )}

          {tab === 'security' && (
            <Card className="space-y-5">
              <div>
                <div className="mb-3 text-sm font-bold text-fg">Смена пароля</div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div><label className="label">Текущий пароль</label><input type="password" className="input" placeholder="••••••••" /></div>
                  <div /><div><label className="label">Новый пароль</label><input type="password" className="input" placeholder="••••••••" /></div>
                  <div><label className="label">Повторите пароль</label><input type="password" className="input" placeholder="••••••••" /></div>
                </div>
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
              <div className="flex justify-end"><button onClick={() => pushToast({ type: 'success', title: 'Настройки безопасности сохранены' })} className="btn-primary h-10"><Save size={16} /> Сохранить</button></div>
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
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                {[['Приглашено', '12'], ['Активных', '5'], ['Заработано', '340 ⚡']].map(([l, v]) => (
                  <Card key={l} className="p-4"><div className="font-display text-2xl font-bold text-fg">{v}</div><div className="text-xs text-muted">{l}</div></Card>
                ))}
              </div>
              <Card>
                <div className="text-sm font-bold text-fg">Ваша реферальная ссылка</div>
                <div className="mt-2 flex gap-2">
                  <input value={refLink} readOnly className="input font-mono text-sm" />
                  <button onClick={() => copy(refLink, 'Реф-ссылка')} className="btn-primary h-[42px] px-4"><Copy size={16} /></button>
                </div>
                <p className="mt-2 text-xs text-muted">Получайте 20% от пополнений приглашённых пользователей в монетах ⚡.</p>
              </Card>
            </div>
          )}

          {tab === 'api' && (
            <Card className="space-y-4">
              <div className="flex items-center justify-between">
                <div><div className="text-sm font-bold text-fg">API-ключ</div><div className="text-xs text-muted">Для интеграции с внешними сервисами</div></div>
                <Badge tone="spark">Активен</Badge>
              </div>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input value={showKey ? apiKey : '•'.repeat(apiKey.length)} readOnly className="input pr-11 font-mono text-sm" />
                  <button onClick={() => setShowKey((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-fg">{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button>
                </div>
                <button onClick={() => copy(apiKey, 'API-ключ')} className="btn-ghost h-[42px] px-4"><Copy size={16} /></button>
                <button onClick={() => pushToast({ type: 'success', title: 'Ключ перевыпущен (демо)' })} className="btn-ghost h-[42px] px-4"><RefreshCw size={16} /></button>
              </div>
              <div className="rounded-xl border border-line bg-elevated p-4">
                <div className="mb-2 text-sm font-bold text-fg">Быстрый старт</div>
                <pre className="overflow-x-auto rounded-lg bg-bg p-3 font-mono text-xs text-spark-300">{`curl https://api.incubator.ai/v1/accounts \\
  -H "Authorization: Bearer ${showKey ? apiKey : 'aii_live_sk_***'}"`}</pre>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted"><Check size={14} className="text-spark-400" /> Документация API доступна на docs.incubator.ai (демо-ссылка)</div>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
