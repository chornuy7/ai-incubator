import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import {
  UserCog, Shield, Bell, Handshake, Cable, Save, Copy, History as HistoryIcon, Package, CalendarClock, AlertTriangle, Trash2 } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { fetchWalletHistory, type Balance, type WalletEntry } from '@/api/balanceApi'
import { isSubscriptionEntry } from '@/features/billing/walletKind'
import { useBalance } from '@/features/billing/balanceStore'
import { expiryInfo, daysLeftPhrase } from '@/features/billing/expiry'
import { deleteUser, changeMyPassword } from '@/api/usersApi'
import { useSession } from '@/features/auth/session'
import { can } from '@/shared/lib/access'
import { PageHeader, Card, Switch, Badge, Modal } from '@/shared/ui'
import { cn, balance as fmtBalance } from '@/shared/lib/utils'
import { useTabParam } from '@/shared/lib/useTabParam'
import { moduleTitle } from '@/shared/config/modules'

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
  // сверить было не с чем. MR-151: источник общий с шапкой (см. balanceStore) —
  // свой поллер тут был третьим запросом того же `/api/balance`.
  const balance = useBalance()
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
 * Строки истории кошелька — общая разметка для карточки в профиле и модалки в подписках.
 *
 * Показываем «до → после» рядом с суммой: одна цифра «−0.15» не даёт понять, было это
 * списание с 80 или последние монеты.
 *
 * Правка 24.08: сумма и остаток были одинаково мелкими и серыми — понять, пришло или ушло,
 * можно было только вчитавшись в знак. Теперь плюс зелёный, минус красный, у суммы стоит
 * знак валюты, а «до → после» набрано крупнее подписи.
 */
/**
 * Строки журнала кошелька.
 *
 * MR-230, две правки заказчика:
 *
 * 1. «Вы не должны обрезать никогда текст». Причина операции стояла в одну строку с
 *    `truncate` — длинная («Токены подписки (месяц): Мейлинг, Нейрокомментинг и ещё 11»)
 *    обрывалась многоточием, и за что списали, было не прочесть. Теперь переносится.
 * 2. «До-после на первой строке, а снизу дата». Раньше всё лежало в один ряд и на узком
 *    экране разъезжалось.
 *
 * `только` — показывать лишь операции по подписке (окно на странице подписок, MR-199).
 */
/*
 * «… и ещё 11» — не текст, а свёрнутый список.
 *
 * Заказчик 31.08: «щоб не писало "и ещё 11", а я міг натиснути і там покажеться фул
 * список». Развернуть можно только то, что сохранено: состав операции пишется колонкой
 * `modules` (миграция 2026-08-31). У строк, записанных раньше, состава нет — они
 * остаются свёрнутыми, и кнопки у них нет: предлагать разворот, который ничего не
 * покажет, хуже, чем не предлагать.
 *
 * Свёрнутый хвост ищем по НАШЕЙ же формулировке: её пишет listModules, а не человек.
 */
function Причина({ r }: { r: WalletEntry }) {
  const [развернуть, setРазвернуть] = useState(false)
  const текст = r.reason || 'без описания'
  const свёрнуто = / и ещё \d+$/.exec(текст)
  const все = (r.modules || []).map(moduleTitle)
  if (!свёрнуто || все.length <= 3) return <>{текст}</>

  const первые = все.slice(0, 3).join(', ')
  // Отрезаем перечисление по нему самому, а не по позиции хвоста: между ними стоит
  // только запятая, но искать начало списка надёжнее по совпадению с составом.
  const где = текст.lastIndexOf(первые)
  const голова = где >= 0 ? текст.slice(0, где) : текст.slice(0, свёрнуто.index)
  return (
    <>
      {голова}{развернуть ? все.join(', ') : первые}{' '}
      <button
        type="button"
        onClick={() => setРазвернуть((v) => !v)}
        className="rounded px-1 font-semibold text-spark-300 underline decoration-dotted underline-offset-2 hover:bg-white/[.06]"
      >
        {развернуть ? 'свернуть' : `и ещё ${все.length - 3}`}
      </button>
    </>
  )
}

function WalletRows({ rows, только }: { rows: WalletEntry[] | null; только?: 'subscription' }) {
  const [валюта, setВалюта] = useState<'all' | 'coins' | 'usd'>('all')
  if (!rows) return <div className="text-sm text-muted">Загрузка…</div>

  const свои = только === 'subscription' ? rows.filter((r) => isSubscriptionEntry(r.reason)) : rows
  const видимые = свои.filter((r) => {
    if (валюта === 'all') return true
    const деньги = (r as WalletEntry & { currency?: string }).currency === 'usd'
    return валюта === 'usd' ? деньги : !деньги
  })

  /*
   * Пустой список в окне подписок и в кошельке значит РАЗНОЕ. В кошельке «операций не
   * было» — правда. В окне подписок операции могут быть, просто ни одна не про подписку
   * (так у админа: модули выданы, а не куплены). Говорить ему «операций не было» —
   * враньё, по которому он пойдёт искать несуществующую поломку.
   */
  if (!свои.length) {
    return (
      <div className="text-sm text-muted">
        {только === 'subscription' ? 'Покупок подписки и модулей пока не было.' : 'Операций пока не было.'}
      </div>
    )
  }

  return (
    <div>
      {/* Фильтр по валюте — заказчик 30.08: «чтобы отображались только токены либо только доллары». */}
      <div className="mb-2 flex gap-1">
        {([['all', 'Всё'], ['coins', 'Токены'], ['usd', 'Деньги']] as const).map(([k, подпись]) => (
          <button
            key={k}
            onClick={() => setВалюта(k)}
            className={cn('rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors',
              валюта === k ? 'bg-spark-500/15 text-spark-300' : 'text-muted hover:bg-white/[.04]')}
          >
            {подпись}
          </button>
        ))}
      </div>

      {!видимые.length ? (
        <div className="py-3 text-sm text-muted">В этом разрезе операций нет.</div>
      ) : (
        <div className="space-y-1">
          {видимые.map((r, i) => {
            const plus = r.amount > 0
            const money = (r as WalletEntry & { currency?: string }).currency === 'usd'
            const unit = money ? '$' : '⚡'
            return (
              <div key={r.ts + '-' + i} className="border-b border-line/40 py-2 last:border-0">
                <div className="flex items-start gap-x-3">
                  <span className={cn('flex w-28 shrink-0 items-center gap-1 text-base font-bold tabular-nums', plus ? 'text-emerald-300' : 'text-rose-300')}>
                    {plus ? '+' : '−'}{fmtBalance(Math.abs(r.amount))}
                    <span className="text-xs font-semibold opacity-70">{unit}</span>
                  </span>
                  {/* break-words, а не truncate: текст переносится, а не обрывается. */}
                  <span className="min-w-0 flex-1 break-words text-sm leading-snug text-fg"><Причина r={r} /></span>
                  {/* «остаток 240 → 120» читается так, будто остаток — это 240 (заказчик
                      31.08: «остаток 240 → 120 виглядає по-дурному»). Подписываем ОБА числа:
                      что было и что осталось — тогда стрелка не нужна вовсе. */}
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-muted">
                    <span className="mr-1 text-xs font-normal text-faint">было</span>
                    {fmtBalance(r.before)}
                    <span className="mx-1 text-xs font-normal text-faint">· осталось</span>
                    <span className={plus ? 'text-emerald-300' : 'text-rose-300'}>{fmtBalance(r.after)}</span>
                    <span className="ml-1 text-xs font-normal opacity-70">{unit}</span>
                  </span>
                </div>
                <div className="mt-1 text-xs text-faint">{new Date(r.ts).toLocaleString('ru-RU')}</div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Загрузка истории по требованию — общий хук для карточки и модалки. */
function useWalletHistory(active: boolean) {
  const [rows, setRows] = useState<WalletEntry[] | null>(null)
  useEffect(() => {
    if (!active || rows) return
    void fetchWalletHistory(50).then(setRows).catch(() => setRows([]))
  }, [active, rows])
  return rows
}

/**
 * История операций по кошельку: когда, за что, сколько и что осталось.
 * Свои операции видит каждый, чужие — только админ (проверяется на сервере).
 */
export function WalletHistory() {
  const [open, setOpen] = useState(false)
  const rows = useWalletHistory(open)

  return (
    <div className="rounded-2xl border border-line bg-elevated p-4">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 text-left">
        <HistoryIcon size={15} className="text-muted" />
        <span className="text-sm font-semibold text-fg">История операций</span>
        <span className="ml-auto text-xs text-muted">{open ? 'свернуть' : 'показать'}</span>
      </button>
      {open && <div className="mt-3"><WalletRows rows={rows} /></div>}
    </div>
  )
}

/**
 * История операций КНОПКОЙ — для страницы подписок.
 *
 * Раскрывающийся блок стоял внизу страницы и его перекрывала нижняя панель запуска
 * (замечание владельца 24.08 и повторно 27.08): развернёшь — а список уезжает под неё.
 * Кнопка живёт в шапке справа, как «О модуле» в модулях, и открывает модалку — её
 * ничем не перекроешь, и до истории не нужно листать всю страницу.
 */
export function WalletHistoryButton() {
  const [open, setOpen] = useState(false)
  const rows = useWalletHistory(open)

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="btn-ghost h-9 shrink-0 text-xs" title="Когда, за что и сколько списывалось">
        <HistoryIcon size={14} /> История операций
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="История операций"
        subtitle="Когда, за что, сколько и что осталось на счету"
        icon={<HistoryIcon size={22} />}
        size="lg"
      >
        <div className="max-h-[60vh] overflow-y-auto pr-1"><WalletRows rows={rows} только="subscription" /></div>
      </Modal>
    </>
  )
}

/** «1 модуль · 2 модуля · 5 модулей» — иначе счётчик читается как ошибка перевода. */
function plural(n: number) {
  const ten = n % 100
  if (ten >= 11 && ten <= 14) return 'модулей'
  const one = n % 10
  if (one === 1) return 'модуль'
  if (one >= 2 && one <= 4) return 'модуля'
  return 'модулей'
}

/**
 * План и подписка: какой тариф/набор подключён и до какого числа. Срок берётся с
 * сервера (expiresAt); нет срока — «бессрочно» (демо и дефолтное пространство).
 */
function SubscriptionCard({ balance }: { balance: Balance | null }) {
  const me = useSession((st) => st.user)
  const modules = balance?.modules

  /*
   * Сотруднику показываем его СОБСТВЕННЫЙ набор (просьба владельца 27.08: «в подписках
   * суб-пользователя показываем только количество доступных именно для него открытых»).
   *
   * Подписку сотрудник наследует от владельца целиком — оттуда и приходило «5 модулей».
   * Но открыто ему может быть два: в меню он видит два, а карточка обещала пять. Считаем
   * пересечение подписки владельца с тем, что ему реально разрешено, и подписываем, из
   * скольких это выбрано, — иначе непонятно, урезали его или у владельца столько и есть.
   */
  const own = Array.isArray(modules) && me && !me.isAdmin
    ? modules.filter((k) => can(me.permissions ?? null, false, 'module', k))
    : null
  const ограничен = !!own && !!modules && Array.isArray(modules) && own.length < modules.length

  const sub = modules === 'all' || modules == null
    ? 'Все модули'
    : `${(own ?? modules).length} ${plural((own ?? modules).length)}`
  // §5 (21.08): дата — словами («до 19 сентября 2026»). «19.09.2026» оператор читает
  // как ребус, а спутать день с месяцем в цифрах — вопрос одного взгляда.
  const exp = expiryInfo(balance?.expiresAt)
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
          {ограничен && (
            <div className="text-[11px] text-muted">открыто вам · у владельца {Array.isArray(modules) ? modules.length : 0}</div>
          )}
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted">Оплачено</div>
          <div className={cn(
            'flex items-center gap-1.5 font-semibold',
            exp.expired ? 'text-red-300' : exp.soon ? 'text-amber-300' : 'text-fg',
          )}>
            {exp.soon && !exp.expired ? <AlertTriangle size={14} /> : <CalendarClock size={14} className="text-muted" />}
            {exp.perpetual ? 'бессрочно' : exp.expired ? `истекла ${exp.date}` : `до ${exp.date}`}
          </div>
          {/* Меньше недели — предупреждаем: когда срок выйдет, модули просто перестанут
              запускаться, и лучше узнать об этом заранее, а не по отказу задачи. */}
          {!exp.perpetual && !exp.expired && (
            <div className={cn('text-[11px]', exp.soon ? 'text-amber-300' : 'text-muted')}>
              {exp.soon
                ? `осталось ${daysLeftPhrase(exp.daysLeft)} — продлите подписку`
                : `осталось ${daysLeftPhrase(exp.daysLeft)}`}
            </div>
          )}
          {exp.expired && <div className="text-[11px] text-red-300">модули не запускаются — продлите подписку</div>}
        </div>
        {/* Правка 14.08: «Подписки» и «Изменить тариф» вели в одно место (/panel/user/subscription) —
            убрали дубль, оставили одну кнопку с названием целевой страницы «Подписки». */}
        {/*
          Сотруднику кнопки нет (правка 27.08). Подписка — не его: сервер на покупку
          отвечает «подписку оформляет владелец пространства», и кнопка вела на экран,
          где сделать нельзя ничего.
        */}
        {!balance?.isSub && (
          <div className="ml-auto flex items-center gap-2">
            <Link to="/panel/user/subscription" className="btn-iris h-9 text-sm"><Package size={14} /> Подписки</Link>
          </div>
        )}
      </div>
    </Card>
  )
}
