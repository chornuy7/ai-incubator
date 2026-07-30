/**
 * §11.3: наполнить `user_types` / `modules` / `user_type_modules` из реальных ролей.
 *
 * Со звонка 29.07: типизация должна храниться ССЫЛКОЙ, а не текстом в строке юзера, а
 * права — отдельной таблицей связей из двух референсов. Таблицы создала миграция
 * `2026-07-30-owner-and-types.sql`; здесь они наполняются данными.
 *
 * ВАЖНО про модель. Наша система прав богаче схемы «тип ↔ модуль»: кроме модулей есть
 * блоки внутри модуля, разделы панели и ресурсы (`roles.permissions`). Поэтому здесь
 * не замена RBAC, а ПРОЕКЦИЯ его модульного среза в нормальные таблицы:
 *   • `user_types.name` = id роли (он латинский и стабильный, проходит CHECK-паттерн),
 *     `title` = человеческое имя роли;
 *   • `user_type_modules` = какие модули роль разрешает;
 *   • `users.user_type_id` = ссылка на первую роль юзера.
 * Гейт доступа (`can()`) продолжает читать `roles.permissions` — переключать его на эти
 * таблицы можно только после того, как проекция подтверждена на живых данных, иначе
 * ошибка в синхронизации молча снимет людям доступ.
 *
 * Функция идемпотентна: гоняется повторно без дублей.
 */
import { getSupabase, supabaseEnabled } from './supabase.js'
import { listModuleKeys } from '../modules/registry.js'
import { moduleTitle } from './moduleTitles.js'
import { listRoles } from '../roles.js'
import { listUsers } from '../users.js'

/** CHECK в БД: имя типа — латиница, 2–40 символов, без точек и пробелов. */
const NAME_OK = /^[a-z][a-z0-9_-]{1,39}$/

export async function syncTypesAndModules() {
  if (!supabaseEnabled()) return { ok: false, reason: 'файловый бэкенд — таблицы типов только в Supabase' }
  const db = getSupabase()
  if (!db) return { ok: false, reason: 'нет клиента Supabase' }

  const report = { modules: 0, types: 0, links: 0, users: 0, skippedRoles: [], removedTypes: 0 }

  // ── 1. Справочник модулей ────────────────────────────────────────────────
  const mods = listModuleKeys()
    .filter((k) => NAME_OK.test(k))
    .map((k) => ({ key: k, title: moduleTitle(k) }))
  if (mods.length) {
    const { error } = await db.from('modules').upsert(mods, { onConflict: 'key' })
    if (error) throw new Error(`modules: ${error.message}`)
    report.modules = mods.length
  }
  const { data: modRows } = await db.from('modules').select('id,key')
  const modId = new Map((modRows || []).map((r) => [r.key, r.id]))

  // ── 2. Типы из ролей ─────────────────────────────────────────────────────
  const roles = await listRoles()
  const types = []
  for (const r of roles) {
    // id роли — ключ типа. Если он не проходит паттерн БД, роль пропускаем и
    // говорим об этом в отчёте, а не подставляем выдуманное имя.
    if (!NAME_OK.test(String(r.id || ''))) { report.skippedRoles.push(r.id); continue }
    types.push({ name: r.id, title: r.name || r.id })
  }
  if (types.length) {
    const { error } = await db.from('user_types').upsert(types, { onConflict: 'name' })
    if (error) throw new Error(`user_types: ${error.message}`)
    report.types = types.length
  }
  const { data: typeRows } = await db.from('user_types').select('id,name')
  const typeId = new Map((typeRows || []).map((r) => [r.name, r.id]))

  // ── 3. Связи тип ↔ модуль ────────────────────────────────────────────────
  // Сначала снимаем старые связи синхронизируемых типов: роль могла ПОТЕРЯТЬ модуль,
  // и upsert сам по себе такую связь не убрал бы.
  const syncedTypeIds = types.map((t) => typeId.get(t.name)).filter(Boolean)
  if (syncedTypeIds.length) {
    await db.from('user_type_modules').delete().in('user_type_id', syncedTypeIds)
  }
  const links = []
  for (const r of roles) {
    const tid = typeId.get(r.id)
    if (!tid) continue
    for (const [key, val] of Object.entries(r.permissions?.modules || {})) {
      if (val !== 'allow') continue
      const mid = modId.get(key)
      if (!mid) continue
      links.push({ user_type_id: tid, module_id: mid })
    }
  }
  if (links.length) {
    const { error } = await db.from('user_type_modules').upsert(links, { onConflict: 'user_type_id,module_id' })
    if (error) throw new Error(`user_type_modules: ${error.message}`)
    report.links = links.length
  }

  // ── 4. Ссылка типа у пользователя ────────────────────────────────────────
  // Берём ПЕРВУЮ роль: тип — один, а ролей у человека может быть несколько.
  // Полный набор ролей остаётся в roles/role_ids и продолжает работать как раньше.
  const users = await listUsers()
  for (const u of users) {
    const first = (u.roleIds || [])[0] || u.roleId || ''
    const tid = typeId.get(first)
    if (!tid) continue
    const { error } = await db.from('users').update({ user_type_id: tid }).eq('id', u.id)
    if (!error) report.users += 1
  }

  // ── 5. Убрать типы-сироты ────────────────────────────────────────────────
  // Сиды из миграции (administrator/operator/viewer) не соответствуют ни одной роли.
  // Оставлять их — захламлять таблицу, которую заказчик открывает и читает. Удаляем
  // только те, на которые никто не ссылается: связи и юзеры уже перепривязаны выше.
  const roleIds = new Set(roles.map((r) => r.id))
  const orphans = (typeRows || []).filter((t) => !roleIds.has(t.name))
  for (const o of orphans) {
    const { count } = await db.from('users').select('id', { count: 'exact', head: true }).eq('user_type_id', o.id)
    if (count) continue // на тип кто-то ссылается — не трогаем
    const { error } = await db.from('user_types').delete().eq('id', o.id)
    if (!error) report.removedTypes += 1
  }

  return { ok: true, ...report }
}
