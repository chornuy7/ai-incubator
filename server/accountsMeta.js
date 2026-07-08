import fs from 'fs/promises'
import path from 'path'
import { SESSIONS_DIR } from './config.js'

const META_FILE = path.join(path.dirname(SESSIONS_DIR), 'accounts-meta.json')

const DEFAULT_META = {
  role: 'Резерв',
  project: 'incubator_ai',
  country: 'ua',
  status: 'active',
  inTrash: false,
}

export async function loadAllMeta() {
  try {
    const raw = await fs.readFile(META_FILE, 'utf8')
    return /** @type {Record<string, object>} */ (JSON.parse(raw))
  } catch {
    return {}
  }
}

async function saveAllMeta(meta) {
  await fs.mkdir(path.dirname(META_FILE), { recursive: true })
  await fs.writeFile(META_FILE, JSON.stringify(meta, null, 2), 'utf8')
}

export async function getAccountMeta(accountId) {
  const all = await loadAllMeta()
  return { ...DEFAULT_META, ...(all[accountId] || {}) }
}

export async function setAccountMeta(accountId, patch) {
  const all = await loadAllMeta()
  all[accountId] = {
    ...DEFAULT_META,
    ...(all[accountId] || {}),
    ...patch,
    updatedAt: Date.now(),
  }
  if (!all[accountId].createdAt) all[accountId].createdAt = Date.now()
  await saveAllMeta(all)
  return all[accountId]
}

export async function deleteAccountMeta(accountId) {
  const all = await loadAllMeta()
  delete all[accountId]
  await saveAllMeta(all)
}

export function countryFromPhone(phone) {
  const p = (phone || '').replace(/\D/g, '')
  if (p.startsWith('380')) return 'ua'
  if (p.startsWith('7')) return 'ru'
  if (p.startsWith('48')) return 'pl'
  if (p.startsWith('49')) return 'de'
  if (p.startsWith('77') || p.startsWith('76')) return 'kz'
  return 'ua'
}

export function avatarColor(accountId) {
  const palette = ['#0ec464', '#7145ff', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#ec4899']
  let h = 0
  for (let i = 0; i < accountId.length; i++) h = (h * 31 + accountId.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}
