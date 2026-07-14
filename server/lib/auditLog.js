/**
 * Единый аудит-лог (Lane A, Фаза 1). Реализует docs/CONTRACT-audit-log.md.
 *
 * Append-only JSONL: неизменяемый след аудит-событий (смена статуса, перенос профиля,
 * массовое действие, force-снятие лока) — то, что должно быть видно с инициатором (§4, §5.2).
 * Операционные логи задач остаются в task.logs (taskStore.appendLog) — это отдельный поток.
 *
 * `buildAuditEntry` — чистая нормализация записи (юнит-тестируется отдельно от I/O).
 */
import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** Путь можно переопределить env (для тестов/изоляции). */
const AUDIT_FILE = process.env.AUDIT_LOG_FILE || path.join(__dirname, '..', 'data', 'audit.log.jsonl')
/** Ротация: при превышении размера обрезаем до последних KEEP строк (защита от роста диска). */
const MAX_BYTES = Number(process.env.AUDIT_MAX_BYTES) || 2 * 1024 * 1024
const KEEP_LINES = Number(process.env.AUDIT_KEEP_LINES) || 5000

/**
 * Нормализовать запись аудита к контрактному виду. Чистая функция.
 * @param {{
 *   action?: string, module?: string, initiator?: string, code?: string, reason?: string,
 *   account?: string, scope?: object, meta?: object, id?: string, ts?: string
 * }} input
 */
export function buildAuditEntry(input = {}) {
  return {
    id: input.id || crypto.randomUUID().slice(0, 8),
    ts: input.ts || new Date().toISOString(),
    action: input.action || 'legacy',
    module: input.module || 'core',
    initiator: input.initiator || 'system',
    code: input.code || '',
    reason: input.reason || '',
    scope: input.scope || {},
    ...(input.account ? { account: input.account } : {}),
    ...(input.meta ? { meta: input.meta } : {}),
  }
}

/**
 * Дописать запись в аудит-лог (создаёт файл при отсутствии).
 * @param {Parameters<typeof buildAuditEntry>[0]} input
 */
export async function appendAudit(input) {
  const entry = buildAuditEntry(input)
  await fs.mkdir(path.dirname(AUDIT_FILE), { recursive: true })
  await fs.appendFile(AUDIT_FILE, JSON.stringify(entry) + '\n', 'utf8')
  // Best-effort ротация: если файл вырос — оставить последние KEEP_LINES строк.
  try {
    const st = await fs.stat(AUDIT_FILE)
    if (st.size > MAX_BYTES) {
      const lines = (await fs.readFile(AUDIT_FILE, 'utf8')).split('\n').filter(Boolean)
      if (lines.length > KEEP_LINES) {
        await fs.writeFile(AUDIT_FILE, lines.slice(-KEEP_LINES).join('\n') + '\n', 'utf8')
      }
    }
  } catch { /* ротация не критична — пропускаем */ }
  return entry
}

/**
 * Прочитать последние записи аудита (новые сверху).
 * @param {{ limit?: number, action?: string, initiator?: string, account?: string }} [filter]
 */
export async function readAudit(filter = {}) {
  const { limit = 200, action, initiator, account } = filter
  let lines
  try {
    lines = (await fs.readFile(AUDIT_FILE, 'utf8')).split('\n').filter(Boolean)
  } catch {
    return []
  }
  /** @type {object[]} */
  const out = []
  for (const l of lines) {
    try {
      const e = JSON.parse(l)
      if (action && e.action !== action) continue
      if (initiator && e.initiator !== initiator) continue
      if (account && e.account !== account && !(e.scope?.accounts || []).includes(account)) continue
      out.push(e)
    } catch { /* skip broken line */ }
  }
  return out.slice(-limit).reverse()
}
