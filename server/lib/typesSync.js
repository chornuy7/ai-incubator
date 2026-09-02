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
    // profiles — единственная таблица операторов. Дубль в снесённую таблицу users убран.
    const { error } = await db.from('profiles').update({ user_type_id: tid }).eq('legacy_id', u.id)
    if (!error) report.users += 1
  }

  // ── 5. Убрать типы-сироты ────────────────────────────────────────────────
  // Сиды из миграции (administrator/operator/viewer) не соответствуют ни одной роли.
  // Оставлять их — захламлять таблицу, которую заказчик открывает и читает. Удаляем
  // только те, на которые никто не ссылается: связи и юзеры уже перепривязаны выше.
  const roleIds = new Set(roles.map((r) => r.id))
  const orphans = (typeRows || []).filter((t) => !roleIds.has(t.name))
  for (const o of orphans) {
    const { count } = await db.from('profiles').select('id', { count: 'exact', head: true }).eq('user_type_id', o.id)
    if (count) continue // на тип кто-то ссылается — не трогаем
    const { error } = await db.from('user_types').delete().eq('id', o.id)
    if (!error) report.removedTypes += 1
  }

  return { ok: true, ...report }
}

/**
 * §11.3: спроецировать модульные связи в нормальные таблицы.
 *
 * Подписки, наборы, кампании и цены ссылаются на модули СТРОКАМИ внутри jsonb —
 * тот же приём, который заказчик критиковал у типов. Здесь они раскладываются по
 * таблицам связей (`subscription_modules`, `bundle_modules`, `campaign_modules`) и
 * цен (`module_prices`), чтобы в БД было видно отношения, а не текст в json.
 *
 * Источник правды НЕ меняется: биллинг и подписки продолжают читать jsonb. Переписывать
 * их на эти таблицы — отдельная работа с тестами, а не побочный эффект синхронизации;
 * ошибка там стоит денег клиента. Поэтому — проекция, пересобираемая при изменениях.
 *
 * Идемпотентна. Если миграция `2026-07-30-module-links.sql` не применена, тихо выходит:
 * отсутствие проекции не должно ломать сохранение подписки или набора.
 */
export async function syncModuleLinks() {
  if (!supabaseEnabled()) return { ok: false, reason: 'файловый бэкенд' }
  const db = getSupabase()
  if (!db) return { ok: false, reason: 'нет клиента Supabase' }

  const { data: modRows, error: modErr } = await db.from('modules').select('id,key')
  if (modErr) return { ok: false, reason: 'нет справочника modules — сначала sync-types' }
  const modId = new Map((modRows || []).map((r) => [r.key, r.id]))
  const report = { prices: 0, subscriptions: 0, bundles: 0, campaigns: 0, skipped: [] }

  /** Ключи модулей из значения, которое может быть массивом, объектом или 'all'. */
  const keysOf = (v) => {
    if (Array.isArray(v)) return v.filter((x) => typeof x === 'string')
    if (v && typeof v === 'object') return Object.keys(v)
    return [] // 'all' и мусор — связями не выражаются, остаются флагом в исходной таблице
  }

  /** Перезалить связи одной таблицы: сначала удалить старые, потом вставить свежие. */
  const relink = async (table, ownerCol, ownerId, keys) => {
    await db.from(table).delete().eq(ownerCol, ownerId)
    const rows = keys.map((k) => modId.get(k)).filter(Boolean).map((mid) => ({ [ownerCol]: ownerId, module_id: mid }))
    if (rows.length) await db.from(table).upsert(rows, { onConflict: `${ownerCol},module_id` })
    return rows.length
  }

  try {
    // ── Цены модулей ─────────────────────────────────────────────────────────
    const { effectivePrices } = await import('../priceStore.js')
    const eff = await effectivePrices()
    const priceRows = []
    for (const m of eff.modules || []) {
      const mid = modId.get(m.key)
      if (!mid) continue
      priceRows.push({ module_id: mid, month_price: m.month ?? 0, action_price: m.action ?? 0, month_tokens: m.monthlyTokens ?? 100, updated_at: new Date().toISOString() })
    }
    if (priceRows.length) {
      const { error } = await db.from('module_prices').upsert(priceRows, { onConflict: 'module_id' })
      if (error) throw new Error(`module_prices: ${error.message}`)
      report.prices = priceRows.length
      // MR-149: базовые цены изменились в БД — сбросить кэш effectivePrices, чтобы новые
      // значения из module_prices применились сразу, а не через TTL.
      try { const { invalidateBasePrices } = await import('../priceStore.js'); invalidateBasePrices() } catch { /* ignore */ }
    }

    // ── Подписки ─────────────────────────────────────────────────────────────
    // Состав подписок живёт строками в user_subscriptions (JSON-колонки больше нет),
    // поэтому проекцию строим из них. Метку «*» («все модули») не тащим: это признак
    // админского доступа, а не перечень модулей.
    const { data: subRows } = await db.from('user_subscriptions').select('user_id, module_key')
    const bySub = new Map()
    for (const r of subRows || []) {
      if (r.module_key === '*') continue
      if (!bySub.has(r.user_id)) bySub.set(r.user_id, [])
      bySub.get(r.user_id).push(r.module_key)
    }
    /*
     * MR-190: проекцию subscription_modules больше не строим.
     *
     * Её никто не читал — ни один запрос в коде к ней не обращается. Это была вторая
     * модель подписки рядом с user_subscriptions: 47 строк, которые молча поддерживались
     * и однажды разошлись бы с настоящими данными. Источник правды один — user_subscriptions.
     */
    void bySub

    // ── Наборы ───────────────────────────────────────────────────────────────
    /*
     * MR-190: наборы больше не перестраиваем из JSON-колонки — теперь всё наоборот.
     * Состав читается ИЗ bundle_modules (server/bundles.js), а пишется туда при создании
     * набора. Перестройка из JSON затирала бы источник правды копией.
     */

    // ── Кампании ─────────────────────────────────────────────────────────────
    const { data: camps } = await db.from('campaigns').select('id, modules')
    for (const c of camps || []) report.campaigns += await relink('campaign_modules', 'campaign_id', c.id, keysOf(c.modules))
  } catch (e) {
    // Таблиц ещё нет (миграция не применена) — это не ошибка вызывающего кода.
    const msg = String(e?.message || e)
    if (/module_prices|subscription_modules|bundle_modules|campaign_modules|does not exist|schema cache/i.test(msg)) {
      return { ok: false, reason: 'примените supabase/migrations/2026-07-30-module-links.sql', ...report }
    }
    throw e
  }

  return { ok: true, ...report }
}
