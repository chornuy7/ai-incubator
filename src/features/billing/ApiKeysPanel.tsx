import { useEffect, useMemo, useState } from 'react'
import { Copy, Trash2, Plus, KeyRound, Loader2 } from 'lucide-react'
import { fetchApiKeys, issueApiKey, revokeApiKey, type ApiKeyInfo } from '@/api/adminApi'
import { fetchAccounts, type ServerAccount } from '@/api/accountsApi'
import { Select } from '@/shared/ui'
import { useApp } from '@/mocks/store'

/**
 * §10.3: управление API-ключами «мозгов» — только для владельца.
 *
 * Полное значение ключа приходит с сервера ОДИН раз при выпуске и показывается
 * тут же с кнопкой «скопировать»; после перезагрузки его уже не достать — только
 * префикс. Так утёкший список не выдаёт рабочие ключи (как у Stripe/GitHub).
 */
export function ApiKeysPanel() {
  const pushToast = useApp((s) => s.pushToast)
  const [keys, setKeys] = useState<ApiKeyInfo[] | null>(null)
  const [name, setName] = useState('')
  const [accountId, setAccountId] = useState('')
  const [accounts, setAccounts] = useState<ServerAccount[]>([])
  const [busy, setBusy] = useState(false)
  const [fresh, setFresh] = useState<{ id: string; key: string } | null>(null)

  const load = () => { void fetchApiKeys().then(setKeys).catch(() => setKeys([])) }
  useEffect(load, [])
  // Ключ выпускается ПОД аккаунт — нужен их список для выбора.
  useEffect(() => { void fetchAccounts().then((a) => setAccounts(a.filter((x) => !x.inTrash))).catch(() => {}) }, [])

  const accountName = useMemo(() => {
    const m: Record<string, string> = {}
    for (const a of accounts) m[a.id] = a.name || a.username || a.phone || a.id.slice(-6)
    return m
  }, [accounts])

  const issue = async () => {
    if (!accountId) { pushToast({ type: 'error', title: 'Выберите аккаунт', desc: 'Ключ выпускается под конкретный аккаунт' }); return }
    setBusy(true)
    try {
      const k = await issueApiKey(name.trim() || 'API-ключ', accountId)
      setFresh({ id: k.id, key: k.key })
      setName('')
      pushToast({ type: 'success', title: 'Ключ выпущен', desc: 'Скопируйте — потом он не покажется' })
      load()
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось выпустить', desc: e instanceof Error ? e.message : '' })
    } finally { setBusy(false) }
  }

  const revoke = async (id: string) => {
    try {
      await revokeApiKey(id)
      if (fresh?.id === id) setFresh(null)
      pushToast({ type: 'success', title: 'Ключ отозван' })
      load()
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось отозвать', desc: e instanceof Error ? e.message : '' })
    }
  }

  const copy = (v: string) => { void navigator.clipboard?.writeText(v); pushToast({ type: 'success', title: 'Скопировано' }) }

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-2 text-sm font-bold text-fg"><KeyRound size={15} /> API-ключи для «мозгов»</div>
        <p className="mt-1 text-xs text-muted">
          Ключом внешний AI-оркестратор создаёт цели, кампании и задачи по API (§10.3).
          Полное значение видно один раз при выпуске.
        </p>
      </div>

      {fresh && (
        <div className="rounded-xl border border-spark-500/40 bg-spark-500/8 p-3">
          <div className="mb-1 text-xs font-semibold text-spark-300">Новый ключ — скопируйте сейчас, потом не покажется:</div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-bg px-2 py-1.5 font-mono text-xs text-fg">{fresh.key}</code>
            <button onClick={() => copy(fresh.key)} className="btn-ghost h-8 px-3"><Copy size={14} /></button>
          </div>
        </div>
      )}

      {/* Ключ = 1 аккаунт: выбираем, под какой аккаунт он выдаётся. «Мозги» этим ключом
          работают только с ним и не могут выйти на другие аккаунты. */}
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Название — напр. «Оркестратор Клиента А»"
          className="input h-9 min-w-0" />
        <Select
          value={accountId}
          onChange={setAccountId}
          searchable
          placeholder="Аккаунт для ключа *"
          options={accounts.map((a) => ({ value: a.id, label: accountName[a.id] || a.id }))}
        />
        <button onClick={() => void issue()} disabled={busy || !accountId} className="btn-primary h-9 disabled:opacity-40">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Выпустить ключ
        </button>
      </div>

      <div className="rounded-xl border border-line">
        {!keys ? (
          <div className="p-4 text-sm text-muted">Загрузка…</div>
        ) : !keys.length ? (
          <div className="p-4 text-sm text-muted">Ключей пока нет.</div>
        ) : (
          keys.map((k) => (
            <div key={k.id} className="flex flex-wrap items-center gap-3 border-b border-line/60 px-3 py-2.5 text-sm last:border-0">
              <span className={k.revoked ? 'text-muted line-through' : 'text-fg'}>{k.name}</span>
              <code className="rounded bg-elevated px-1.5 py-0.5 font-mono text-xs text-muted">{k.prefix}</code>
              {k.accountId && (
                <span className="rounded bg-iris-500/12 px-1.5 py-0.5 text-[10px] font-bold text-iris-300" title={`Ключ работает только с аккаунтом ${k.accountId}`}>
                  → {accountName[k.accountId] || k.accountId.slice(-6)}
                </span>
              )}
              {k.revoked && <span className="rounded bg-white/8 px-1.5 py-0.5 text-[10px] font-bold text-muted">отозван</span>}
              <span className="text-xs text-faint">
                {k.lastUsedAt ? `использован ${new Date(k.lastUsedAt).toLocaleDateString('ru-RU')}` : 'ещё не использован'}
              </span>
              {!k.revoked && (
                <button onClick={() => void revoke(k.id)} className="ml-auto grid h-7 w-7 place-items-center rounded-md border border-line text-muted hover:border-red-500/40 hover:text-red-300" title="Отозвать">
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))
        )}
      </div>
      <p className="text-xs text-muted">Документация API — <code>docs/API-v1.md</code>.</p>
    </div>
  )
}
