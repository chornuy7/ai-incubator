import fs from 'fs/promises'
import path from 'path'
import { SESSIONS_DIR } from './config.js'
import { loadAllMeta, getAccountMeta, setAccountMeta, deleteAccountMeta, countryFromPhone, avatarColor } from './accountsMeta.js'
import { loadSessionString, createClient } from './tgAuth.js'
import { getAccountLock } from './lib/accountLocks.js'

async function listSessionIds() {
  await fs.mkdir(SESSIONS_DIR, { recursive: true })
  const files = await fs.readdir(SESSIONS_DIR)
  return files.filter((f) => f.endsWith('.session')).map((f) => f.replace(/\.session$/, ''))
}

function formatLastSeen(ts) {
  if (!ts) return '—'
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'только что'
  if (min < 60) return `${min} мин`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} ч`
  return `${Math.floor(h / 24)} д`
}

/** @param {string} accountId @param {object} meta @param {object | null} me @param {boolean} sessionOk */
function toAccountDto(accountId, meta, me, sessionOk) {
  const phone = me?.phone || meta.phone || ''
  const first = me?.firstName || ''
  const last = me?.lastName || ''
  const name = `${first} ${last}`.trim() || meta.name || phone || accountId

  let status = meta.status || 'active'
  if (!sessionOk) status = 'reauth'
  else if (sessionOk && status === 'reauth') status = 'active'

  return {
    id: accountId,
    tgSessionId: accountId,
    avatarColor: meta.avatarColor || avatarColor(accountId),
    name,
    phone: phone && !phone.startsWith('+') ? `+${phone}` : phone || '—',
    username: me?.username || meta.username || `user_${accountId.slice(-6)}`,
    userId: me?.id?.toString?.() ?? meta.userId ?? '',
    role: meta.role || 'Резерв',
    project: meta.project || 'incubator_ai',
    country: meta.country || countryFromPhone(phone),
    status,
    lastSeen: formatLastSeen(meta.updatedAt || meta.createdAt),
    proxy: meta.proxy || '—',
    inTrash: !!meta.inTrash,
    createdAt: meta.createdAt || Date.now(),
    busyIn: (() => {
      const lock = getAccountLock(accountId)
      return lock ? { moduleKey: lock.moduleKey, taskId: lock.taskId, moduleLabel: lock.moduleLabel } : undefined
    })(),
  }
}

export async function tgListAccounts() {
  const ids = await listSessionIds()
  const accounts = []

  for (const accountId of ids) {
    let meta = await getAccountMeta(accountId)
    const sessionStr = await loadSessionString(accountId)
    if (!sessionStr) continue

    let me = null
    let sessionOk = false
    try {
      const client = await createClient(sessionStr, meta.proxy)
      me = await client.getMe()
      sessionOk = true
      await client.disconnect()

      meta = await setAccountMeta(accountId, {
        name: `${me.firstName || ''} ${me.lastName || ''}`.trim(),
        username: me.username,
        phone: me.phone,
        userId: me.id?.toString?.(),
        ...(meta.status === 'reauth' ? { status: 'active' } : {}),
      })
    } catch {
      sessionOk = false
    }

    accounts.push(toAccountDto(accountId, meta, me, sessionOk))
  }

  accounts.sort((a, b) => b.createdAt - a.createdAt)
  return accounts
}

export async function tgPatchAccount(accountId, patch) {
  const sessionStr = await loadSessionString(accountId)
  if (!sessionStr) throw new Error('Аккаунт не найден')

  const allowed = ['role', 'project', 'country', 'status', 'proxy', 'inTrash', 'note']
  /** @type {Record<string, unknown>} */
  const clean = {}
  for (const k of allowed) {
    if (patch[k] !== undefined) clean[k] = patch[k]
  }
  await setAccountMeta(accountId, clean)
  const accounts = await tgListAccounts()
  return accounts.find((a) => a.id === accountId)
}

export async function tgDeleteAccount(accountId) {
  const sessionPath = path.join(SESSIONS_DIR, `${accountId}.session`)
  try {
    await fs.unlink(sessionPath)
  } catch {
    /* already gone */
  }
  await deleteAccountMeta(accountId)
}

export async function tgEmptyTrash() {
  const allMeta = await loadAllMeta()
  const trashed = Object.entries(allMeta).filter(([, m]) => m.inTrash).map(([id]) => id)
  for (const id of trashed) await tgDeleteAccount(id)
  return trashed.length
}
