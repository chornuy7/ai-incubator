import { useEffect, useState } from 'react'
import { Server, Loader2 } from 'lucide-react'
import { Modal, Select } from '@/shared/ui'
import { cn } from '@/shared/lib/utils'
import { fetchProxies, createProxy, isUsableProxy, type Proxy as ApiProxy } from '@/api/proxiesApi'
import { useApp } from '@/mocks/store'
import type { TgAccount } from '@/shared/types'

/**
 * Модалка «Сменить прокси» — выбор из базы прокси или ввод нового.
 * Вынесена из AccountsPage, чтобы переиспользовать и в карточке аккаунта (вкладка «Прокси»,
 * MR-129) без циклического импорта (AccountsPage сам импортирует карточку).
 */
// MR-290: наружу отдаём ССЫЛКУ на прокси (или null — «без прокси»), а не строку
// подключения. Строку собирает сервер из каталога, поэтому пароли не ходят через браузер.
export function ChangeProxyModal({ acc, onClose, onSave }: { acc: TgAccount | null; onClose: () => void; onSave: (id: string, proxyId: string | null) => void }) {
  const [useProxy, setUseProxy] = useState(true)
  const [value, setValue] = useState('')
  const [pool, setPool] = useState<ApiProxy[]>([])
  const [fromPool, setFromPool] = useState(true)
  // Правка 14.08: «Ввести новый» — структурированная форма как в модуле «Прокси», а не сырой URL.
  // Новый прокси создаётся в каталоге (createProxy) и уже оттуда назначается — единый источник.
  const [nf, setNf] = useState({ label: '', scheme: 'socks5' as 'socks5' | 'http', host: '', port: '', username: '', password: '' })
  const [busy, setBusy] = useState(false)
  const pushToast = useApp((s) => s.pushToast)
  const setNfField = (k: keyof typeof nf, v: string) => setNf((s) => ({ ...s, [k]: v }))

  const handleSave = async () => {
    if (!acc) return
    if (!useProxy) { onSave(acc.id, null); return }
    if (fromPool) { onSave(acc.id, value.trim() || acc.proxyId || null); return }
    // «Ввести новый»: создаём прокси в каталоге (модуль «Прокси» — источник), затем назначаем.
    if (!nf.host.trim() || !nf.port.trim()) { pushToast({ type: 'error', title: 'Укажите хост и порт' }); return }
    setBusy(true)
    try {
      const created = await createProxy({
        label: nf.label.trim() || undefined,
        scheme: nf.scheme,
        host: nf.host.trim(),
        port: Number(nf.port) || 0,
        username: nf.username.trim() || undefined,
        password: nf.password.trim() || undefined,
      })
      pushToast({ type: 'success', title: 'Прокси добавлен в каталог', desc: created.label || `${created.host}:${created.port}` })
      onSave(acc.id, created.id)
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось создать прокси', desc: e instanceof Error ? e.message : '' })
    } finally { setBusy(false) }
  }

  useEffect(() => {
    if (!acc) return
    // Правка заказчика 14.08: показываем ВСЕ прокси из базы (чтобы видеть больше двух),
    // рабочие — сверху, нерабочие помечаем «не отвечает» и не даём выбрать по ошибке.
    void fetchProxies()
      .then((list) => setPool([...list].sort((a, b) => Number(isUsableProxy(b)) - Number(isUsableProxy(a)))))
      .catch(() => setPool([]))
  }, [acc?.id])

  useEffect(() => {
    if (!acc) return
    // Модалка правит НАЗНАЧЕНИЕ прокси, а не строку подключения: строки в аккаунте
    // больше нет вовсе. Поле начинается пустым — прокси выбирают из каталога.
    setUseProxy(!!acc.proxyId)
    setValue('')
  }, [acc?.id])

  return (
    <Modal
      open={!!acc}
      onClose={onClose}
      title={acc?.proxyId ? 'Сменить прокси' : 'Добавить прокси'}
      subtitle={acc?.name}
      icon={<Server size={22} />}
      size="sm"
      footer={<>
        <button onClick={onClose} disabled={busy} className="btn-ghost h-10 disabled:opacity-50">Отмена</button>
        <button onClick={() => void handleSave()} disabled={busy} className="btn-primary h-10 disabled:opacity-50">
          {busy ? <><Loader2 size={16} className="animate-spin" /> Создаём…</> : (useProxy && !fromPool ? 'Создать и назначить' : 'Сохранить')}
        </button>
      </>}
    >
      <div className="mb-3 inline-flex rounded-lg border border-line bg-elevated p-0.5">
        <button
          type="button"
          onClick={() => setUseProxy(false)}
          className={cn('rounded-md px-3 py-1 text-xs font-semibold', !useProxy ? 'bg-spark-gradient text-[#04150c]' : 'text-muted')}
        >
          Без прокси
        </button>
        <button
          type="button"
          onClick={() => setUseProxy(true)}
          className={cn('rounded-md px-3 py-1 text-xs font-semibold', useProxy ? 'bg-spark-gradient text-[#04150c]' : 'text-muted')}
        >
          Через прокси
        </button>
      </div>
      {useProxy ? (
        <>
          <div className="mb-2 inline-flex rounded-lg border border-line bg-elevated p-0.5 text-xs">
            <button type="button" onClick={() => setFromPool(true)}
              className={cn('rounded-md px-2.5 py-1 font-semibold', fromPool ? 'bg-spark-gradient text-[#04150c]' : 'text-muted')}>
              Из базы прокси
            </button>
            <button type="button" onClick={() => setFromPool(false)}
              className={cn('rounded-md px-2.5 py-1 font-semibold', !fromPool ? 'bg-spark-gradient text-[#04150c]' : 'text-muted')}>
              Ввести новый
            </button>
          </div>
          {fromPool ? (
            pool.length === 0 ? (
              <p className="text-xs text-muted">Рабочих прокси в базе нет — введите новый, он попадёт в базу.</p>
            ) : (
              <>
                <label className="label">Прокси из базы ({pool.length})</label>
                <Select
                  value={value}
                  onChange={setValue}
                  placeholder="Выберите прокси"
                  options={pool.map((p) => {
                    // Подпись без пароля: сервер его больше не отдаёт, да он тут и не нужен —
                    // выбор уезжает идентификатором (MR-290).
                    const auth = p.username ? `${p.username}@` : ''
                    const url = `${p.scheme}://${auth}${p.host}:${p.port}`
                    const addr = `${p.scheme}://${p.host}:${p.port}`
                    const geo = p.country ? ` · ${p.country.toUpperCase()}` : ''
                    // Правка 14.08: показываем только НАЗВАНИЕ прокси (+ гео/статус), без полного
                    // адреса — по адресу не вспомнишь, что это. Адрес — в подсказке (title).
                    const dead = !isUsableProxy(p)
                    const status = dead ? ' · не отвечает' : p.status === 'unknown' ? ' · не проверен' : ''
                    const name = p.label || addr
                    return { value: url, label: `${name}${geo}${status}`, disabled: dead }
                  })}
                />
              </>
            )
          ) : (
            // Правка 14.08: как в модуле «Прокси» — отдельные поля, а не сырой URL.
            // Новый прокси создаётся в каталоге и оттуда назначается (единый источник).
            <div className="grid grid-cols-2 gap-2">
              <div className="col-span-2"><label className="label">Название</label><input value={nf.label} onChange={(e) => setNfField('label', e.target.value)} className="input" placeholder="Напр. Ферма UA #1" /></div>
              <div><label className="label">Протокол</label>
                <Select value={nf.scheme} onChange={(v) => setNfField('scheme', v)} options={[{ value: 'socks5', label: 'SOCKS5' }, { value: 'http', label: 'HTTP' }]} />
              </div>
              <div><label className="label">Порт</label><input value={nf.port} onChange={(e) => setNfField('port', e.target.value.replace(/[^0-9]/g, ''))} className="input" placeholder="1080" inputMode="numeric" /></div>
              <div className="col-span-2"><label className="label">Host / IP</label><input value={nf.host} onChange={(e) => setNfField('host', e.target.value)} className="input" placeholder="1.2.3.4" /></div>
              <div><label className="label">Логин</label><input value={nf.username} onChange={(e) => setNfField('username', e.target.value)} className="input" placeholder="(опц.)" /></div>
              <div><label className="label">Пароль</label><input value={nf.password} onChange={(e) => setNfField('password', e.target.value)} className="input" placeholder="(опц.)" /></div>
              <p className="col-span-2 text-[11px] text-muted">Прокси попадёт в каталог модуля «Прокси» и будет назначен аккаунту. Статус/страна определяются при проверке.</p>
            </div>
          )}
          <p className="mt-2 text-xs text-muted">Текущий: <span className="font-mono">{acc?.proxyLabel || 'Прямое подключение'}</span></p>
        </>
      ) : (
        <p className="text-sm text-muted">Аккаунт будет подключаться напрямую, без SOCKS5/HTTP прокси.</p>
      )}
    </Modal>
  )
}
