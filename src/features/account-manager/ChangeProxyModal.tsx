import { useEffect, useState } from 'react'
import { Server } from 'lucide-react'
import { Modal, Select } from '@/shared/ui'
import { cn } from '@/shared/lib/utils'
import { fetchProxies, type Proxy as ApiProxy } from '@/api/proxiesApi'
import type { TgAccount } from '@/shared/types'

function formatProxyLabel(proxy: string) {
  if (!proxy || proxy === '—') return 'Прямое подключение'
  return proxy
}

/**
 * Модалка «Сменить прокси» — выбор из базы прокси или ввод нового.
 * Вынесена из AccountsPage, чтобы переиспользовать и в карточке аккаунта (вкладка «Прокси»,
 * MR-129) без циклического импорта (AccountsPage сам импортирует карточку).
 */
export function ChangeProxyModal({ acc, onClose, onSave }: { acc: TgAccount | null; onClose: () => void; onSave: (id: string, proxy: string) => void }) {
  const [useProxy, setUseProxy] = useState(true)
  const [value, setValue] = useState('')
  const [pool, setPool] = useState<ApiProxy[]>([])
  const [fromPool, setFromPool] = useState(true)

  useEffect(() => {
    if (!acc) return
    void fetchProxies().then(setPool).catch(() => setPool([]))
  }, [acc?.id])

  useEffect(() => {
    if (!acc) return
    const has = acc.proxy && acc.proxy !== '—'
    setUseProxy(!!has)
    setValue(has ? acc.proxy : '')
  }, [acc?.id])

  return (
    <Modal
      open={!!acc}
      onClose={onClose}
      title="Сменить прокси"
      subtitle={acc?.name}
      icon={<Server size={22} />}
      size="sm"
      footer={<>
        <button onClick={onClose} className="btn-ghost h-10">Отмена</button>
        <button
          onClick={() => acc && onSave(acc.id, useProxy ? (value.trim() || acc.proxy) : '—')}
          className="btn-primary h-10"
        >
          Сохранить
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
              <p className="text-xs text-muted">База прокси пуста — введите новый, он попадёт в базу.</p>
            ) : (
              <>
                <label className="label">Прокси из базы ({pool.length})</label>
                <Select
                  value={value}
                  onChange={setValue}
                  placeholder="Выберите прокси"
                  options={pool.map((p) => {
                    const auth = p.username ? `${p.username}${p.password ? ':' + p.password : ''}@` : ''
                    const url = `${p.scheme}://${auth}${p.host}:${p.port}`
                    const shown = `${p.scheme}://${p.host}:${p.port}`
                    const geo = p.country ? ` · ${p.country.toUpperCase()}` : ''
                    return { value: url, label: `${shown}${geo}${p.status === 'dead' ? ' · не отвечает' : ''}` }
                  })}
                />
              </>
            )
          ) : (
            <>
              <label className="label">Новый прокси</label>
              <input value={value} onChange={(e) => setValue(e.target.value)} className="input" placeholder="socks5://host:port" />
            </>
          )}
          <p className="mt-2 text-xs text-muted">Текущий: <span className="font-mono">{formatProxyLabel(acc?.proxy ?? '')}</span></p>
        </>
      ) : (
        <p className="text-sm text-muted">Аккаунт будет подключаться напрямую, без SOCKS5/HTTP прокси.</p>
      )}
    </Modal>
  )
}
