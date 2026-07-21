/**
 * §2: поиск аккаунтов в папке. Люди хранят их по-разному — кто-то держит папку на
 * аккаунт с вложенной `tdata`, кто-то валит `.session` пачкой в одну директорию,
 * рядом часто лежит `.json` с телефоном/прокси/2FA от продавца. Сканер обходит дерево
 * и возвращает плоский список найденного, чтобы человек отметил галочками, что везти.
 *
 * Читаем только метаданные и имена — сами сессии не расшифровываем, это делает
 * `lib/sessionImport.js` уже на этапе импорта.
 */
import fs from 'fs/promises'
import path from 'path'
import { resolveTdataDir, tdataAccountIndexes } from './sessionImport.js'

/** Глубже этого не спускаемся: на дереве вроде C:\ сканирование иначе не кончится. */
const MAX_DEPTH = 4
/** Каталоги, в которые заходить бессмысленно и дорого. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'System Volume Information', '$RECYCLE.BIN', 'Windows', 'AppData'])

/** Возможные названия полей в json-файлах от продавцов — единого стандарта нет. */
const PHONE_KEYS = ['phone', 'Phone', 'phone_number', 'number', 'tel']
const TWOFA_KEYS = ['twoFA', 'two_fa', 'twofa', 'password', 'two_factor_password', 'cloud_password']
const PROXY_KEYS = ['proxy', 'Proxy', 'proxy_url']

const pick = (obj, keys) => { for (const k of keys) { if (obj?.[k] != null && obj[k] !== '') return obj[k] } return null }

/**
 * Прокси в json бывает и строкой, и массивом `[type, host, port, user, pass]` (формат Telethon).
 * @returns {string|null} URL-строка, совместимая с server/proxy.js#parseProxy
 */
function normProxyFromJson(v) {
  if (!v) return null
  if (typeof v === 'string') return v.trim() || null
  if (Array.isArray(v) && v.length >= 3) {
    const [type, host, port, user, pass] = v
    const scheme = String(type).toLowerCase().includes('http') ? 'http' : 'socks5'
    const auth = user ? `${encodeURIComponent(user)}${pass ? ':' + encodeURIComponent(pass) : ''}@` : ''
    return `${scheme}://${auth}${host}:${port}`
  }
  if (typeof v === 'object') {
    const host = v.host || v.addr || v.ip
    const port = v.port
    if (!host || !port) return null
    const scheme = String(v.scheme || v.type || 'socks5').toLowerCase().includes('http') ? 'http' : 'socks5'
    const auth = v.username || v.user ? `${encodeURIComponent(v.username || v.user)}${v.password ? ':' + encodeURIComponent(v.password) : ''}@` : ''
    return `${scheme}://${auth}${host}:${port}`
  }
  return null
}

/**
 * Отпечаток устройства из json продавца: под ним сессия была создана. Подключаться
 * другим отпечатком — для Telegram это смена устройства на живой авторизации, поэтому
 * тащим его вместе с аккаунтом и дальше ходим только так.
 * Формат ключей — как у распространённых конвертеров (TeleRaptor и родственные).
 * @param {object} j
 */
function readFingerprint(j) {
  const fp = {
    apiId: Number(j.app_id || j.api_id) || undefined,
    apiHash: j.app_hash || j.api_hash || undefined,
    device: j.device || j.device_model || undefined,
    system: j.sdk || j.system_version || undefined,
    appVersion: j.app_version || undefined,
    langCode: j.lang_pack || j.lang_code || undefined,
    systemLangCode: j.system_lang_pack || j.system_lang_code || undefined,
  }
  return Object.values(fp).some((v) => v !== undefined) ? fp : null
}

/**
 * Метаданные из json рядом с аккаунтом (`acc1.session` + `acc1.json`, либо любой json в папке tdata).
 * Best-effort: битый json просто игнорируем.
 * @param {string} file путь к json
 */
export async function readSidecarJson(file) {
  try {
    const raw = await fs.readFile(file, 'utf8')
    const j = JSON.parse(raw)
    if (!j || typeof j !== 'object') return null
    const rawPhone = pick(j, PHONE_KEYS) ? String(pick(j, PHONE_KEYS)).replace(/[^\d+]/g, '') : null
    return {
      // Телефон приводим к единому виду с «+»: в json его пишут и так, и так.
      phone: rawPhone ? (rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`) : null,
      twoFA: pick(j, TWOFA_KEYS) ? String(pick(j, TWOFA_KEYS)) : null,
      proxy: normProxyFromJson(pick(j, PROXY_KEYS)),
      username: j.username ? String(j.username).replace(/^@/, '') : null,
      userId: Number(j.user_id || j.userId || j.id) || null,
      fingerprint: readFingerprint(j),
    }
  } catch { return null }
}

/** Найти json-спутник для файла `<name>.session` → `<name>.json`. */
async function sidecarFor(file) {
  const guess = file.replace(/\.session$/i, '.json')
  try { await fs.access(guess) } catch { return null }
  return readSidecarJson(guess)
}

/** Телефон из имени файла/папки: продавцы часто называют их прямо номером. */
function phoneFromName(name) {
  const m = String(name || '').match(/\+?\d{10,15}/)
  return m ? (m[0].startsWith('+') ? m[0] : `+${m[0]}`) : null
}

/**
 * Обойти дерево и найти аккаунты.
 * @param {string} root
 * @param {{ maxDepth?: number, passcode?: string }} [opts]
 * @returns {Promise<{ items: object[], scannedDirs: number }>}
 */
export async function scanFolder(root, opts = {}) {
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : MAX_DEPTH
  const items = []
  let scannedDirs = 0

  /** @param {string} dir @param {number} depth */
  async function walk(dir, depth) {
    if (depth > maxDepth) return
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    scannedDirs++

    // Сама эта папка — tdata (или содержит вложенную tdata)? Тогда внутрь не спускаемся:
    // там сотни служебных файлов Telegram Desktop, искать в них нечего.
    const tdataDir = await resolveTdataDir(dir)
    if (tdataDir) {
      const idxs = await tdataAccountIndexes(tdataDir, opts.passcode)
      const json = entries.find((e) => e.isFile() && e.name.toLowerCase().endsWith('.json'))
      const meta = json ? await readSidecarJson(path.join(dir, json.name)) : null
      // Имя аккаунта — это имя ЕГО папки. Если указали прямо на `tdata`, берём родителя:
      // сама по себе «tdata» ничего человеку не говорит.
      const base = path.basename(dir)
      const label = base.toLowerCase() === 'tdata' ? path.basename(path.dirname(dir)) : base
      for (const accountIdx of idxs) {
        items.push({
          kind: 'tdata',
          path: tdataDir,
          name: idxs.length > 1 ? `${label} (аккаунт ${accountIdx + 1})` : label,
          accountIdx,
          phone: meta?.phone || phoneFromName(label),
          proxy: meta?.proxy || null,
          twoFA: meta?.twoFA || null,
          fingerprint: meta?.fingerprint || null,
        })
      }
      return
    }

    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        await walk(full, depth + 1)
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.session')) {
        const meta = await sidecarFor(full)
        const base = e.name.replace(/\.session$/i, '')
        items.push({
          kind: 'session-file',
          path: full,
          name: base,
          phone: meta?.phone || phoneFromName(base),
          proxy: meta?.proxy || null,
          twoFA: meta?.twoFA || null,
          fingerprint: meta?.fingerprint || null,
        })
      }
    }
  }

  await walk(root, 0)
  return { items, scannedDirs }
}

/**
 * Список папок для «проводника» в UI. Файлы не отдаём — выбирать можно только директорию.
 * @param {string} dir пустая строка = корни (диски на Windows, `/` на Linux)
 */
export async function listDirs(dir) {
  if (!dir) {
    if (process.platform === 'win32') {
      // Быстрее и надёжнее, чем звать wmic: просто пробуем буквы дисков.
      const drives = []
      for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
        const p = `${l}:\\`
        try { await fs.access(p); drives.push({ name: p, path: p }) } catch { /* нет такого диска */ }
      }
      return { parent: null, dirs: drives }
    }
    return { parent: null, dirs: [{ name: '/', path: '/' }] }
  }
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  const up = path.dirname(dir)
  return { parent: up === dir ? '' : up, dirs }
}
