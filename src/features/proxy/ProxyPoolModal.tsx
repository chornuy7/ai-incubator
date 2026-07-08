import { useState } from 'react'
import { Server, Plus, Trash2, Loader2, CheckCircle2, XCircle } from 'lucide-react'
import { Modal, Select } from '@/shared/ui'
import { useApp } from '@/mocks/store'
import { checkProxy } from '@/mocks/tgApi'
import { cn } from '@/shared/lib/utils'
import type { Proxy } from '@/shared/types'

const STATUS: Record<Proxy['status'], { label: string; icon: React.ReactNode; cls: string }> = {
  ok: { label: 'Живой', icon: <CheckCircle2 size={14} />, cls: 'text-spark-300' },
  dead: { label: 'Мёртвый', icon: <XCircle size={14} />, cls: 'text-rose-300' },
  checking: { label: 'Проверка', icon: <Loader2 size={14} className="animate-spin" />, cls: 'text-amber-300' },
}

export function ProxyPoolModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const proxies = useApp((s) => s.data.proxies)
  const addProxy = useApp((s) => s.addProxy)
  const removeProxy = useApp((s) => s.removeProxy)
  const pushToast = useApp((s) => s.pushToast)
  const guardNet = useApp((s) => s.guardNet)

  const [type, setType] = useState<'socks5' | 'http'>('socks5')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [login, setLogin] = useState('')
  const [checking, setChecking] = useState(false)

  const add = () => {
    if (!host.trim() || !port.trim()) return pushToast({ type: 'error', title: 'Заполните хост и порт' })
    if (!guardNet('добавление прокси')) return
    addProxy({ type, host: host.trim(), port: Number(port), login: login.trim() || undefined })
    pushToast({ type: 'success', title: 'Прокси добавлен', desc: `${type}://${host}:${port}` })
    setHost(''); setPort(''); setLogin('')
  }

  const check = async () => {
    if (!guardNet('проверка прокси')) return
    setChecking(true)
    const res = await checkProxy(`${host}:${port}`)
    setChecking(false)
    pushToast({ type: res.ok ? 'success' : 'error', title: res.ok ? `Прокси доступен · ${res.ping}мс` : 'Прокси недоступен' })
  }

  return (
    <Modal open={open} onClose={onClose} title="Пул прокси" subtitle="Прокси распределяются между аккаунтами" icon={<Server size={22} />} size="lg">
      {/* Add form */}
      <div className="mb-5 rounded-2xl border border-line bg-elevated p-4">
        <div className="mb-3 text-sm font-bold text-fg">Добавить прокси</div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <label className="label">Тип</label>
            <Select value={type} onChange={(v) => setType(v as 'socks5' | 'http')} options={[{ value: 'socks5', label: 'SOCKS5' }, { value: 'http', label: 'HTTP' }]} />
          </div>
          <div>
            <label className="label">Хост</label>
            <input value={host} onChange={(e) => setHost(e.target.value)} className="input" placeholder="12.34.56.78" />
          </div>
          <div>
            <label className="label">Порт</label>
            <input value={port} onChange={(e) => setPort(e.target.value)} className="input" placeholder="1080" inputMode="numeric" />
          </div>
          <div>
            <label className="label">Логин</label>
            <input value={login} onChange={(e) => setLogin(e.target.value)} className="input" placeholder="необязательно" />
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          <button onClick={check} disabled={checking || !host} className="btn-ghost h-10">
            {checking ? <Loader2 size={15} className="animate-spin" /> : 'Проверить'}
          </button>
          <button onClick={add} className="btn-primary h-10"><Plus size={16} /> Добавить в пул</button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-2xl border border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-elevated text-left text-xs font-bold uppercase tracking-wide text-muted">
              <th className="px-4 py-2.5">Прокси</th>
              <th className="px-4 py-2.5">Тип</th>
              <th className="px-4 py-2.5">Статус</th>
              <th className="px-4 py-2.5">Аккаунтов</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {proxies.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-muted">Пул пуст — добавьте первый прокси.</td></tr>
            ) : proxies.map((p) => {
              const st = STATUS[p.status]
              return (
                <tr key={p.id} className="border-b border-line/60 last:border-0">
                  <td className="px-4 py-2.5 font-mono text-fg">{p.host}:{p.port}</td>
                  <td className="px-4 py-2.5 uppercase text-muted">{p.type}</td>
                  <td className={cn('px-4 py-2.5', st.cls)}><span className="inline-flex items-center gap-1.5 font-semibold">{st.icon} {st.label}</span></td>
                  <td className="px-4 py-2.5 text-fg">{p.usedBy}</td>
                  <td className="px-4 py-2.5 text-right">
                    <button onClick={() => removeProxy(p.id)} className="btn-icon h-8 w-8 text-rose-300"><Trash2 size={14} /></button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Modal>
  )
}
