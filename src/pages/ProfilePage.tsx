import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import {
  UserCog, Shield, Bell, Handshake, Cable, Save, Copy, History as HistoryIcon, Package, CalendarClock, AlertTriangle, Trash2 } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { fetchBalance, fetchWalletHistory, type Balance, type WalletEntry } from '@/api/balanceApi'
import { deleteUser, changeMyPassword } from '@/api/usersApi'
import { useSession } from '@/features/auth/session'
import { PageHeader, Card, Switch, Badge, Modal } from '@/shared/ui'
import { cn, coins as fmtCoins } from '@/shared/lib/utils'
import { useTabParam } from '@/shared/lib/useTabParam'

// 24 стандартных часовых пояса (целочасовые, UTC-12…UTC+11) с городом-подсказкой.
const ALL_TIMEZONES: string[] = [
  'UTC-12:00', 'UTC-11:00', 'UTC-10:00 · Гонолулу', 'UTC-09:00', 'UTC-08:00 · Лос-Анджелес',
  'UTC-07:00 · Денвер', 'UTC-06:00 · Чикаго', 'UTC-05:00 · Нью-Йорк', 'UTC-04:00', 'UTC-03:00 · Буэнос-Айрес',
  'UTC-02:00', 'UTC-01:00', 'UTC+00:00 · Лондон', 'UTC+01:00 · Берлин', 'UTC+02:00 · Варшава',
  'UTC+03:00 · Киев / Москва', 'UTC+04:00 · Дубай', 'UTC+05:00', 'UTC+06:00', 'UTC+07:00 · Бангкок',
  'UTC+08:00 · Пекин', 'UTC+09:00 · Токио', 'UTC+10:00 · Сидней', 'UTC+11:00',
]

// MR-158: «Настройки профиля» и «Настройки аккаунта» объединены в один раздел.
const TABS = [
  { key: 'profile', label: 'Профиль и аккаунт', icon: UserCog },
  { key: 'security', label: 'Настройки безопасности', icon: Shield },
  { key: 'notifications', label: 'Уведомления', icon: Bell },
  { key: 'partner', label: 'Партнёрская программа', icon: Handshake },
  { key: 'api', label: 'API', icon: Cable },
  // Правка 14.08: удаление аккаунта — ОТДЕЛЬНЫЙ пункт меню, красным (не в профиле).
  { key: 'delete', label: 'Удалить аккаунт', icon: Trash2, danger: true },
] as const

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
  // MR-158: смена пароля с валидацией (длина ≥ 8, новый ≠ текущий, повтор совпадает) + индикатор прочности.
  const [pwCur, setPwCur] = useState('')
  const [pwNew, setPwNew] = useState('')
  const [pwRepeat, setPwRepeat] = useState('')

  // Правка 14.08: удаление аккаунта — ВСЕГДА 2 подтверждения. Шаг 1 (осознание) → шаг 2
  // (ввод слова УДАЛИТЬ). Демо-заглушки «удаление отключено» больше нет — рвём по-настоящему.
  const logout = useSession((s) => s.logout)
  const [delStep, setDelStep] = useState<0 | 1 | 2>(0)
  const [delWord, setDelWord] = useState('')
  const [delBusy, setDelBusy] = useState(false)
  const doDelete = async () => {
    if (!sessionUser?.id) { pushToast({ type: 'error', title: 'Нет активной сессии' }); return }
    setDelBusy(true)
    try {
      await deleteUser(sessionUser.id)
      pushToast({ type: 'success', title: 'Аккаунт удалён' })
      setDelStep(0)
      logout()
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось удалить', desc: e instanceof Error ? e.message : '' })
    } finally { setDelBusy(false) }
  }

  // Правка 12.08: загрузка аватара (файл юзера) + сохранение локально, чтобы переживало перезагрузку.
  const avatarKey = sessionUser?.id ? `ai-incubator:avatar:${sessionUser.id}` : 'ai-incubator:avatar'
  const [avatar, setAvatar] = useState<string | null>(() => { try { return localStorage.getItem(avatarKey) } catch { return null } })
  const fileRef = useRef<HTMLInputElement>(null)
  const onPickAvatar = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = ''
    if (!f) return
    if (!f.type.startsWith('image/')) { pushToast({ type: 'error', title: 'Нужен файл-изображение' }); return }
    if (f.size > 2 * 1024 * 1024) { pushToast({ type: 'error', title: 'Файл слишком большой', desc: 'Максимум 2 МБ' }); return }
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result || '')
      setAvatar(url)
      try { localStorage.setItem(avatarKey, url) } catch { /* превышена квота — оставляем в памяти */ }
      pushToast({ type: 'success', title: 'Фото обновлено' })
    }
    reader.readAsDataURL(f)
  }
  // Прочность нового пароля: 0 (нет) … 4 (сильный).
  const pwScore = (p: string) => {
    if (!p) return 0
    let s = 0
    if (p.length >= 8) s += 1
    if (p.length >= 12) s += 1
    if (/[0-9]/.test(p) && /[a-zа-яA-ZА-Я]/.test(p)) s += 1
    if (/[^A-Za-zА-Яа-я0-9]/.test(p)) s += 1
    return s
  }

  const save = () => { updateUser({ firstName, lastName, nick }); pushToast({ type: 'success', title: 'Изменения сохранены' }) }
  const [pwBusy, setPwBusy] = useState(false)
  const saveSecurity = async () => {
    if (!pwNew && !pwRepeat && !pwCur) { pushToast({ type: 'success', title: 'Настройки безопасности сохранены' }); return }
    // Правка 14.08: валидация в ОБРАТНОМ порядке — СНАЧАЛА текущий пароль (сервер сверит его
    // с БД, current-first), и только потом надёжность нового. Раньше «Пароли не совпадают» /
    // «Слабый пароль» показывались раньше, чем «Текущий пароль неверный».
    if (!pwCur) { pushToast({ type: 'error', title: 'Введите текущий пароль' }); return }
    if (!pwNew) { pushToast({ type: 'error', title: 'Введите новый пароль' }); return }
    if (pwNew.length > 64) { pushToast({ type: 'error', title: 'Слишком длинный пароль', desc: 'Максимум 64 символа' }); return }
    if (pwNew !== pwRepeat) { pushToast({ type: 'error', title: 'Пароли не совпадают' }); return }
    if (pwNew === pwCur) { pushToast({ type: 'error', title: 'Новый пароль совпадает с текущим' }); return }
    setPwBusy(true)
    try {
      // Сервер: сначала проверяет ТЕКУЩИЙ пароль по БД, потом надёжность нового (лимит: ≥8, буквы+цифры).
      await changeMyPassword(pwCur, pwNew)
      setPwCur(''); setPwNew(''); setPwRepeat('')
      pushToast({ type: 'success', title: 'Пароль обновлён' })
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось сменить пароль', desc: e instanceof Error ? e.message : 'Проверьте текущий пароль' })
    } finally { setPwBusy(false) }
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
              className={cn('flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors',
                'danger' in t && t.danger
                  ? (tab === t.key ? 'bg-rose-500/12 text-rose-300' : 'text-rose-400/80 hover:bg-rose-500/8 hover:text-rose-300')
                  : (tab === t.key ? 'bg-spark-500/12 text-spark-300' : 'text-muted hover:bg-elevated hover:text-fg'))}
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
                <div className="h-16 w-16 shrink-0 overflow-hidden rounded-2xl">
                  {avatar
                    ? <img src={avatar} alt="Аватар" className="h-full w-full object-cover" />
                    : <div className="grid h-full w-full place-items-center bg-iris-gradient text-2xl font-bold text-white">{(sessionUser?.name || `${firstName} ${lastName}`).trim().slice(0, 2).toUpperCase()}</div>}
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
                <input ref={fileRef} type="file" accept="image/*" onChange={onPickAvatar} className="hidden" />
                <button onClick={() => fileRef.current?.click()} className="btn-ghost ml-auto h-9">Сменить фото</button>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div><label className="label">Имя</label><input value={firstName} onChange={(e) => setFirstName(e.target.value)} className="input" /></div>
                <div><label className="label">Фамилия</label><input value={lastName} onChange={(e) => setLastName(e.target.value)} className="input" /></div>
                <div><label className="label">Никнейм</label><input value={nick} onChange={(e) => setNick(e.target.value)} className="input" /></div>
                <div><label className="label">E-mail</label><input value={data.user.email} disabled className="input opacity-60" /></div>
              </div>
              <div className="mt-5 flex justify-end"><button onClick={save} className="btn-primary h-10"><Save size={16} /> Сохранить изменения</button></div>
            </Card>

            {/* Правка 14.08: тариф/лимит/баланс убраны из профиля — они уже в шапке панели и в
                карточке подписки сверху. Остаётся только часовой пояс. Удаление вынесено в
                отдельный пункт меню (вкладка «Удалить аккаунт»). */}
            <Card className="space-y-5">
              <div>
                <label className="label">Часовой пояс</label>
                <select defaultValue="UTC+03:00 · Киев / Москва" className="input max-w-xs">
                  {ALL_TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                </select>
              </div>
            </Card>
            </div>
          )}

          {/* Правка 14.08: удаление аккаунта — ОТДЕЛЬНЫЙ пункт меню, с юридическим предупреждением
              и подтверждением вводом e-mail (как GitHub). */}
          {tab === 'delete' && (
            <Card className="space-y-4 border-rose-500/30">
              <div className="flex items-center gap-2 text-rose-300">
                <AlertTriangle size={18} />
                <h2 className="text-lg font-bold">Удаление аккаунта</h2>
              </div>
              <div className="space-y-2 rounded-2xl border border-line bg-elevated/50 p-4 text-sm leading-relaxed text-muted">
                <p>Удаление аккаунта <b className="text-fg">закрывает ваш доступ</b> к сервису и рабочему пространству: профиль, привязанные Telegram-аккаунты, задачи, история и баланс перестанут быть доступны.</p>
                <p>Мы удаляем ваш <b className="text-fg">доступ</b>, а не персональные данные третьих лиц. Часть данных может сохраняться в резервных копиях и журналах в объёме и на срок, которых требует закон, после чего удаляется в штатном порядке.</p>
                <p>Действие <b className="text-rose-300">необратимо</b>. Если вы просто хотите приостановить работу — не удаляйте аккаунт, обратитесь в поддержку.</p>
              </div>
              <div className="flex justify-end">
                <button onClick={() => { setDelWord(''); setDelStep(1) }} className="btn-danger h-10">
                  <Trash2 size={16} /> Удалить аккаунт
                </button>
              </div>
            </Card>
          )}

          {tab === 'security' && (
            <Card className="space-y-5">
              <div>
                <div className="mb-3 text-sm font-bold text-fg">Смена пароля</div>
                {/* autoComplete=new-password/off — чтобы браузер НЕ подставлял сохранённый пароль
                    в поле «текущий» (был баг: поле приходило заполненным). */}
                <div className="grid gap-3 sm:grid-cols-2">
                  <div><label className="label">Текущий пароль</label><input type="password" autoComplete="off" maxLength={64} value={pwCur} onChange={(e) => setPwCur(e.target.value)} className="input" placeholder="••••••••" /></div>
                  <div />
                  <div>
                    <label className="label">Новый пароль</label>
                    <input type="password" autoComplete="new-password" maxLength={64} value={pwNew} onChange={(e) => setPwNew(e.target.value)} className="input" placeholder="8–64 символа" />
                    {pwNew && (() => {
                      const m = [
                        { w: '25%', c: 'bg-rose-500', t: 'Очень слабый', tc: 'text-rose-300' },
                        { w: '50%', c: 'bg-rose-400', t: 'Слабый', tc: 'text-rose-300' },
                        { w: '75%', c: 'bg-amber-400', t: 'Средний', tc: 'text-amber-300' },
                        { w: '100%', c: 'bg-spark-500', t: 'Сильный', tc: 'text-spark-300' },
                      ][Math.max(0, pwScore(pwNew) - 1)]
                      return (
                        <div className="mt-1.5">
                          <div className="h-1 w-full overflow-hidden rounded-full bg-line"><div className={cn('h-full rounded-full transition-all', m.c)} style={{ width: m.w }} /></div>
                          <div className={cn('mt-0.5 text-[11px]', m.tc)}>Прочность: {m.t}{pwNew.length < 8 ? ' · нужно ≥ 8 символов' : ''}</div>
                        </div>
                      )
                    })()}
                  </div>
                  <div><label className="label">Повторите пароль</label><input type="password" autoComplete="new-password" maxLength={64} value={pwRepeat} onChange={(e) => setPwRepeat(e.target.value)} className="input" placeholder="••••••••" /></div>
                </div>
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
              <div className="flex justify-end"><button onClick={() => void saveSecurity()} disabled={pwBusy} className="btn-primary h-10 disabled:opacity-50"><Save size={16} /> {pwBusy ? 'Сохранение…' : 'Сохранить'}</button></div>
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

      {/* Удаление аккаунта — 2 подтверждения; финальное = ввод своего e-mail (как GitHub). */}
      <Modal
        open={delStep === 1}
        onClose={() => setDelStep(0)}
        size="sm"
        icon={<AlertTriangle size={20} className="text-rose-400" />}
        title="Удалить аккаунт?"
        subtitle="Подтверждение 1 из 2"
        footer={
          <div className="flex justify-end gap-2">
            <button onClick={() => setDelStep(0)} className="btn-ghost h-9">Отмена</button>
            <button onClick={() => { setDelWord(''); setDelStep(2) }} className="btn-danger h-9">Продолжить</button>
          </div>
        }
      >
        <p className="text-sm leading-relaxed text-muted">
          Будет <b className="text-fg">безвозвратно</b> закрыт доступ: профиль, привязанные
          Telegram-аккаунты, задачи, история и баланс. Восстановить будет нельзя.
        </p>
      </Modal>

      {(() => {
        const email = (sessionUser?.email || '').trim()
        const match = delWord.trim().toLowerCase() === email.toLowerCase() && !!email
        return (
          <Modal
            open={delStep === 2}
            onClose={() => setDelStep(0)}
            size="sm"
            icon={<Trash2 size={20} className="text-rose-400" />}
            title="Последнее подтверждение"
            subtitle="Подтверждение 2 из 2"
            footer={
              <div className="flex justify-end gap-2">
                <button onClick={() => setDelStep(1)} className="btn-ghost h-9">Назад</button>
                <button
                  disabled={!match || delBusy}
                  onClick={() => void doDelete()}
                  className="btn-danger h-9 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {delBusy ? 'Удаление…' : 'Удалить навсегда'}
                </button>
              </div>
            }
          >
            <p className="mb-3 text-sm text-muted">
              Чтобы подтвердить, введите свой e-mail <b className="text-fg">{email}</b> в поле ниже.
            </p>
            <input
              autoFocus
              value={delWord}
              onChange={(e) => setDelWord(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && match) void doDelete() }}
              className="input"
              placeholder={email}
            />
          </Modal>
        )
      })()}
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
        {/* Правка 14.08: «Подписки» и «Изменить тариф» вели в одно место (/panel/user/subscription) —
            убрали дубль, оставили одну кнопку с названием целевой страницы «Подписки». */}
        <div className="ml-auto flex items-center gap-2">
          <Link to="/panel/user/subscription" className="btn-iris h-9 text-sm"><Package size={14} /> Подписки</Link>
        </div>
      </div>
    </Card>
  )
}
