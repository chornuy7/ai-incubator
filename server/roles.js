/**
 * RBAC: роли и права доступа (§8.1, docs/CONTRACT-rbac.md).
 * Главный админ создаёт роли и раздаёт доступы к модулям, блокам внутри модулей и
 * ресурсам (папки/каналы/таймеры/шаблоны). Каждый доступ — allow|deny («2 чекбокса»:
 * дать / убрать доступ). По умолчанию — deny (нет доступа, подсвечивается в UI).
 * Хранение — JSON data/roles.json; путь через env ROLES_FILE (изоляция тестов).
 */
import crypto from 'crypto'
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'
import { getSupabase, supabaseEnabled } from './lib/supabase.js'

function sbRoles() { return supabaseEnabled() ? getSupabase() : null }
/*
 * MR-290: права роли лежат СТРОКАМИ в `role_permissions`, а дерево `permissions`
 * собирается из них при чтении.
 *
 * Структура прав всегда была регулярной — 555 правил в боевых данных, у каждого ровно
 * два значения, `allow` или `deny`, — но записана деревом, из-за чего «у кого есть
 * доступ к аккаунту acc_…» требовало перебора всех сорока шести ролей. Для системы
 * доступа это тот вопрос, который задают при разборе инцидента, то есть когда ответ
 * нужен сразу. Плюс опечатка: `'alow'` записывалась молча и читалась как «не allow» —
 * право пропадало без единой ошибки. В колонке с ограничением так уже не выйдет.
 *
 * Форма прав НАРУЖУ не меняется: код собирает то же дерево. Менять хранение и формат
 * проверки доступа одной правкой нельзя — это единственное место, где ошибка означает
 * не потерянные данные, а открытый чужому человеку кабинет.
 *
 * `personalFor` и `freeAccess` переехали в колонки. Раньше они ездили ВНУТРИ прав
 * намеренно: колонки не было, а заводить её значило получить сборку, которая до
 * применения миграции молча теряет метку — роль сохранялась бы «ничьей», при следующем
 * сохранении не находилась бы и создавалась заново, у суба размножались бы роли, а
 * выданный доступ пропадал. Теперь колонка есть, а `permissions` продолжает писаться
 * до следующего выпуска — метка доезжает обоими путями.
 */
const personalOf = (perm) => String(perm?.personalFor || '')

/*
 * `folderChannels` — единственное право, значение которого СПИСОК, а не allow/deny.
 *
 * Устроено оно так: `{ fld_1: ['news_ru', 'crypto'] }` — «из этой папки роли видны только
 * эти каналы». Пустой список или отсутствие ключа означают ОБРАТНОЕ: видна вся папка
 * (см. `folderTargetsForRole`). То есть потеря этого права не отбирает доступ, а РАСШИРЯЕТ
 * его — роль получает папку целиком. Ошибка, которая выглядит как «всё работает».
 *
 * В строках список раскладывается по одной строке на канал, а папка и канал склеиваются в
 * `item_id`. Разделителем взят символ, которого не бывает ни в идентификаторе папки
 * (`fld_…`), ни в имени канала (буквы, цифры, подчёркивание): двоеточие или дефис однажды
 * встретились бы внутри значения, и право распалось бы не в том месте.
 */
const LIST_RESOURCE = 'folderChannels'
const LIST_SEP = '/'

/** Разрез прав ↔ поле в дереве. Одна карта на оба перевода — не два списка. */
const SCOPES = [['module', 'modules'], ['block', 'blocks'], ['section', 'sections'], ['resource', 'resources']]
const FIELD_BY_SCOPE = new Map(SCOPES)
const SCOPE_BY_FIELD = new Map(SCOPES.map(([scope, field]) => [field, scope]))

/**
 * Строки правил → дерево прав в прежнем виде.
 *
 * Правила на весь вид ресурса обрабатываются ПЕРВЫМИ, поэлементные — после: правило на
 * конкретный аккаунт точнее, чем на «аккаунты вообще», и должно перекрывать. В боевых
 * данных обе формы у одного вида не встречаются, но порядок задан явно, чтобы поведение
 * не зависело от того, в каком порядке база вернула строки.
 * @param {Array<{scope:string,subject:string,item_id:string,effect:string}>} rows
 */
export function rulesToPermissions(rows) {
  const p = { modules: {}, blocks: {}, sections: {}, resources: {} }
  for (const r of [...(rows || [])].sort((a, b) => (a.item_id ? 1 : 0) - (b.item_id ? 1 : 0))) {
    const field = FIELD_BY_SCOPE.get(r.scope)
    if (!field) continue
    if (r.scope === 'resource' && r.item_id) {
      // Каналы папки — единственное право со СПИСКОМ вместо allow/deny (см. LIST_RESOURCE).
      if (r.subject === LIST_RESOURCE) {
        const [folderId, ...хвост] = String(r.item_id).split(LIST_SEP)
        const target = хвост.join(LIST_SEP)
        if (!folderId || !target) continue
        const bucket = p.resources[LIST_RESOURCE] && typeof p.resources[LIST_RESOURCE] === 'object' ? p.resources[LIST_RESOURCE] : {}
        bucket[folderId] = [...(bucket[folderId] || []), target]
        p.resources[LIST_RESOURCE] = bucket
        continue
      }
      const cur = p.resources[r.subject]
      const bucket = cur && typeof cur === 'object' ? cur : {}
      bucket[r.item_id] = r.effect
      p.resources[r.subject] = bucket
      continue
    }
    p[field][r.subject] = r.effect
  }
  return p
}

/** Дерево прав → строки правил. Всё, что не `allow`/`deny`, отбрасывается. */
export function permissionsToRules(roleId, permissions) {
  const rows = []
  for (const [field, value] of Object.entries(permissions || {})) {
    const scope = SCOPE_BY_FIELD.get(field)
    if (!scope || !value || typeof value !== 'object') continue
    for (const [subject, v] of Object.entries(value)) {
      if (!subject) continue
      if (typeof v === 'string') {
        if (v === ALLOW || v === DENY) rows.push({ role_id: roleId, scope, subject, item_id: '', effect: v })
        continue
      }
      if (scope !== 'resource' || !v || typeof v !== 'object') continue
      for (const [itemId, iv] of Object.entries(v)) {
        if (!itemId) continue
        // Список каналов папки — строка на канал. Пустой список не пишем: он и означает
        // «вся папка», то есть отсутствие ограничения, и хранить его нечем.
        if (subject === LIST_RESOURCE && Array.isArray(iv)) {
          for (const цель of iv) {
            const t = String(цель ?? '').trim()
            if (t && !t.includes(LIST_SEP)) rows.push({ role_id: roleId, scope, subject, item_id: `${itemId}${LIST_SEP}${t}`, effect: ALLOW })
          }
          continue
        }
        if (iv === ALLOW || iv === DENY) rows.push({ role_id: roleId, scope, subject, item_id: itemId, effect: iv })
      }
    }
  }
  return rows
}

export const rowToRole = (r, rules = null) => {
  // Правила прочитаны — они и есть права. Не прочитаны (миграция не доехала) — остаётся
  // дерево из колонки. Пустой набор правил у роли, которой правила читали, — это
  // «прав нет», и подменять его старым деревом нельзя: снятые права вернулись бы.
  const permissions = rules ? rulesToPermissions(rules) : (r.permissions || {})
  const freeAccess = r.free_access ?? permissions.freeAccess ?? false
  const personalFor = r.personal_for || personalOf(r.permissions)
  /*
   * `freeAccess` ВОЗВРАЩАЕТСЯ В ДЕРЕВО, хотя хранится колонкой.
   *
   * Его читают из прав в четырёх местах — `effectivePermissions`, маршруты модулей и
   * дважды фронт (`user.permissions.freeAccess`). Собранное из строк дерево этого флага
   * не содержит: правил такого разреза нет и не должно быть. Не вернув его сюда, мы
   * получили бы ровно ту поломку, от которой вся задача и защищается: роль со свободным
   * доступом внезапно упирается в подписку, причём молча и только на проде — в файловом
   * режиме, где дерево читается как есть, всё бы работало.
   */
  if (freeAccess) permissions.freeAccess = true
  if (personalFor) permissions.personalFor = personalFor
  return { id: r.id, name: r.name, permissions, builtin: !!r.builtin, userId: r.user_id || undefined, personalFor, freeAccess }
}

// §11.3: user_id — кто создал роль (до применения миграции колонки нет, см. ownerColumn).
const roleToRow = (r) => ({
  id: r.id, name: r.name, builtin: !!r.builtin, user_id: r.userId || null,
  personal_for: r.personalFor || null,
  free_access: r.permissions?.freeAccess === true || r.freeAccess === true,
  // Дерево пока пишется тоже: до выката кода доступ считает предыдущая версия — по нему.
  permissions: { ...(r.permissions || {}), ...(r.personalFor ? { personalFor: r.personalFor } : {}) },
})

/**
 * Переписать правила роли. Сначала снимаем старые, потом кладём новые — обратный порядок
 * на миг оставил бы роль с обоими наборами, а лишнее правило в системе доступа это не
 * «мелкое расхождение», а открытый доступ.
 */
async function writeRoleRules(db, role) {
  const rows = permissionsToRules(role.id, role.permissions)
  const { error: delErr } = await db.from('role_permissions').delete().eq('role_id', role.id)
  if (delErr) {
    // Таблицы ещё нет — миграция не доехала; права остались в дереве, оно пока пишется.
    if (isMissingTable(delErr)) return
    /*
     * Любой другой отказ молчанием не покрываем. Раньше здесь стояло просто `return`, и
     * это означало: старые правила не сняты, новые не записаны, а наружу ушёл успех.
     * В системе доступа «сохранили» при несохранённом — худший вид ошибки: человек видит
     * новые права в интерфейсе и уходит, а действуют прежние.
     */
    throw new Error(`[role_permissions] прежние права роли не сняты: ${delErr.message}`)
  }
  if (!rows.length) return
  const { error } = await db.from('role_permissions').upsert(rows, { onConflict: 'role_id,scope,subject,item_id' })
  if (error) throw new Error(`[role_permissions] права роли не сохранены: ${error.message}`)
}
import { MODULE_LABELS } from './lib/accountLocks.js'
import { listFolders } from './targetFolders.js'
import { listChannels } from './channels.js'
import { loadAllMeta } from './accountsMeta.js'
import { listGroups } from './accountGroups.js'

// Путь — ФУНКЦИЯ, а не константа: при вычислении на импорте тесты, выставляющие
// env позже, писали бы в боевые data/. Так и случилось — прогон накопил там
// 22 лишние роли и 36 пользователей.
const ROLES_FILE = () => process.env.ROLES_FILE || dataPath('roles.json')

export const ALLOW = 'allow'
export const DENY = 'deny'

/** Встроенная роль главного админа — обходит проверки (bypass). Не удаляется/не редактируется. */
export const ADMIN_ROLE_ID = 'role_admin'

/**
 * Единый словарь блоков внутри модуля (§8.1 «блоки в модулях»).
 *
 * ПОРЯДОК = порядок секций на странице модуля (правка 21.08 по просьбе владельца:
 * «во всех модулях мы меняли порядок, в нижней плашке нужно так же»). Человек выдаёт
 * права, глядя на страницу модуля в голове, — и когда список прав идёт в другом порядке,
 * каждый пункт приходится искать заново. Сверено по LiveModule.tsx:
 *   аккаунты и «Параметры и лимиты» → `run`
 *   группы/цели                     → `targets`
 *   промпты и палитра реакций (ИИ)  → `templates`
 *   «Защита и тайминги»             → `settings`
 *   результаты и логи               → в самом низу, как на странице
 *
 * Подписи тоже переписаны словами страницы модуля: «Настройки и пресеты» ничему на
 * экране не соответствовало, а искали по нему блок «Защита и тайминги».
 * Ключи НЕ меняются — по ним записаны выданные права.
 */
export const BLOCKS = [
  { key: 'run', label: 'Аккаунты, параметры и запуск' },
  { key: 'targets', label: 'Целевые каналы и группы' },
  { key: 'templates', label: 'ИИ: промпты и шаблоны' },
  { key: 'settings', label: 'Защита и тайминги' },
  { key: 'results', label: 'Результаты' },
]

/*
 * Блока «Логи» здесь БОЛЬШЕ НЕТ (правка владельца 26.08: «где у нас в мейлинге или в
 * любом другом модуле логи и результаты? такого же нету»).
 *
 * Проверено по всем витринам: своей секции логов нет ни у одного модуля — логи задачи
 * живут в Дашборде задач, у парсеров это прямо написано на экране («Логи по этой задаче —
 * в Дашборде задач»). Тумблер открывал доступ к тому, чего не существует.
 *
 * Ключ `logs` в уже выданных правах остаётся лежать как есть: он ни на что не влияет, а
 * чистить чужие записи ради косметики опаснее, чем оставить их.
 */

/**
 * Какие блоки есть У КАЖДОГО модуля и как они называются НА ЕГО ЭКРАНЕ.
 *
 * Правка владельца 26.08: «модули и блоки поменялись, нужно, чтобы при выдаче ролям они
 * назывались идентично тому, что есть, и убрать те, которых уже нет». Раньше список был
 * ОДИН на все модули — шесть пунктов, одинаковых для парсера и для комментинга. Из-за
 * этого выдавали «ИИ: промпты и шаблоны» парсеру, где промптов нет вовсе, и искали на
 * экране «Целевые каналы» там, где написано «Настройки поиска».
 *
 * КЛЮЧИ НЕ МЕНЯЮТСЯ — по ним записаны уже выданные права; новых не заводим, иначе у
 * сотрудников молча пропал бы доступ к разделам (пустой ключ = запрет). Меняются только
 * СОСТАВ на модуль и ПОДПИСИ.
 */
export const MODULE_BLOCKS = {
  // «Результаты» — только там, где секция результатов действительно есть на экране
  // (парсеры и рейтинг). У остальных модулей результат смотрят в Дашборде задач, и
  // тумблер обещал бы несуществующее.
  'neuro-commenting': ['run', 'targets', 'templates', 'settings'],
  'neuro-chatting': ['run', 'targets', 'templates', 'settings'],
  'neuro-dialogs': ['run', 'templates', 'settings'],
  'mass-react': ['run', 'targets', 'templates', 'settings'],
  'mass-looking': ['run', 'targets', 'settings'],
  warming: ['run', 'settings'],
  mailing: ['run', 'targets', 'templates', 'settings'],
  autoposting: ['run', 'targets', 'templates', 'settings'],
  ggr: ['run', 'results'],
  parsing: ['run', 'targets', 'settings', 'results'],
  'parsing-groups': ['run', 'targets', 'settings', 'results'],
  'parsing-users': ['run', 'targets', 'settings', 'results'],
  'parsing-messages': ['run', 'targets', 'settings', 'results'],
  'parsing-comments': ['run', 'targets', 'settings', 'results'],
  'spam-unblock': ['run'],
}

/** Подписи, отличающиеся от общих: слово должно совпадать с тем, что видно на экране. */
const BLOCK_LABEL_OVERRIDES = {
  parsing: { targets: 'Настройки поиска', settings: 'Защита и тайминги' },
  'parsing-groups': { targets: 'Настройки поиска' },
  'parsing-users': { targets: 'Настройки парсинга (источники)', settings: 'Фильтры, защита и тайминги' },
  'parsing-messages': { targets: 'Настройки парсинга (источники)', settings: 'Фильтры, защита и тайминги' },
  'parsing-comments': { targets: 'Настройки парсинга (источники)', settings: 'Фильтры, защита и тайминги' },
  mailing: { targets: 'Получатели и чёрный список', templates: 'Текст сообщения' },
  'mass-react': { templates: 'Палитра реакций' },
  'neuro-dialogs': { templates: 'ИИ: промпты и цель диалога' },
  warming: { run: 'Аккаунты и уровень прогрева' },
  ggr: { run: 'Аккаунты и запуск' },
  autoposting: { targets: 'Каналы и чёрный список', templates: 'Текст поста и публикация' },
}

/**
 * Блоки одного модуля с подписями — то, что рисует редактор ролей.
 * Неизвестный модуль (новый, ещё не описанный) получает полный набор: лучше показать
 * лишний тумблер, чем молча лишить владельца возможности что-то закрыть.
 */
export function blocksForModule(moduleKey) {
  const keys = MODULE_BLOCKS[moduleKey] || BLOCKS.map((b) => b.key)
  const over = BLOCK_LABEL_OVERRIDES[moduleKey] || {}
  return keys.map((k) => ({ key: k, label: over[k] || (BLOCKS.find((b) => b.key === k)?.label ?? k) }))
}

/**
 * Разделы навигации, доступ к которым выдаётся ролью (§8.1 «доступ на всё, не только модули»).
 * Ключ = путь роутинга. НЕ включает: админ-страницы (роли/пользователи — только админ) и
 * «всегда-доступный» минимум (Мой аккаунт, Поддержка). По умолчанию — deny (не показывать).
 */
export const SECTIONS = [
  { key: '/panel', label: 'Менеджер аккаунтов' },
  { key: '/panel/proxies', label: 'Прокси' },
  { key: '/panel/automation', label: 'Автоматизация' },
  { key: '/panel/goals', label: 'Цели' },
  { key: '/panel/campaign', label: 'Кампания' },
  { key: '/panel/tasks', label: 'Дашборд задач' },
  { key: '/panel/crm', label: 'CRM · Лиды' },
  { key: '/panel/analytics', label: 'Аналитика' },
  { key: '/panel/my-statistics', label: 'Моя статистика' },
  { key: '/panel/logs', label: 'Логи' },
  { key: '/panel/inbox', label: 'Обзор аккаунта' },
  { key: '/panel/channels', label: 'Каналы (база)' },
  { key: '/panel/parsing-history', label: 'Логи парсинга' },
]

/** Типы ресурсов с индивидуальным доступом (§8.1). folders/channels — по элементам. */
export const RESOURCE_TYPES = [
  { type: 'accounts', label: 'Аккаунты (кто виден в менеджере/пикере)', perItem: true },
  { type: 'accountGroups', label: 'Группы аккаунтов (доступ сразу на группу, §12)', perItem: true },
  { type: 'folders', label: 'Папки целей', perItem: true },
  { type: 'channels', label: 'Целевые каналы', perItem: true },
  { type: 'timers', label: 'Таймеры / планировщик', perItem: false },
  { type: 'searchTemplates', label: 'Шаблоны поиска', perItem: false },
  // По умолчанию человек видит в Дашборде только СВОИ запуски: чужие задачи — это
  // чужие аккаунты, цели и переписка. Это право открывает весь дашборд целиком —
  // выдаётся тимлиду или тому, кто отвечает за всю сетку.
  { type: 'allTasks', label: 'Чужие задачи (видеть и управлять всеми в Дашборде)', perItem: false },
  // Право поддержки: видеть ВСЕ тикеты пользователей и отвечать в них «как поддержка»
  // (а не как обычный юзер). Обычно выдаётся роли «Поддержка», которой больше ничего не нужно.
  { type: 'support', label: 'Поддержка (видеть все тикеты и отвечать как поддержка)', perItem: false },
]

/** Нормализовать значение доступа: всё, что не 'allow', — deny. @param {*} v */
function normPerm(v) {
  return v === ALLOW ? ALLOW : DENY
}

/** Нормализовать карту `folderId → string[]` (какие каналы/ссылки папки выданы роли).
 *  Пустой массив/отсутствие для разрешённой папки = все каналы папки. @param {*} obj */
function normFolderChannels(obj) {
  /** @type {Record<string,string[]>} */
  const out = {}
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v)) out[k] = [...new Set(v.map((x) => String(x || '').trim().replace(/^@/, '')).filter(Boolean))]
    }
  }
  return out
}

/** Нормализовать карту `key → allow|deny`. @param {*} obj */
function normPermMap(obj) {
  /** @type {Record<string,'allow'|'deny'>} */
  const out = {}
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) out[k] = normPerm(v)
  }
  return out
}

/** Привести вход к чистой роли (без служебных полей). @param {object} input */
export function normalizeRole(input = {}) {
  const p = input.permissions || {}
  const r = p.resources || {}
  return {
    name: String(input.name ?? '').trim(),
    isTemplate: !!input.isTemplate,
    // Владелец роли. Терялся здесь: роут исправно клал `userId`, а нормализация его не
    // переносила — роль сохранялась «ничьей». Последствия обидные: владелец мог создать
    // роль, но не отредактировать её (PUT требует `target.userId === ctx.id`), а сама
    // роль показывалась ВСЕМ владельцам как системный шаблон (`!r.userId`). Отсюда же
    // общий список из десятков чужих «Новая роль 5/6» на экране у каждого (21.08).
    userId: String(input.userId ?? '').trim(),
    /*
     * Персональная роль субпользователя (уточнение владельца 21.08). Доступ суба
     * настраивается в ЕГО карточке, а не на странице ролей: владелец щёлкает модули из
     * своей подписки, а под капотом это пишется в роль, потому что гейт доступа умеет
     * только роли. Такие роли невидимы в списке — иначе у владельца с десятком
     * сотрудников список превратился бы в свалку «Доступ · Иван», «Доступ · Пётр».
     */
    personalFor: String(input.personalFor ?? p.personalFor ?? '').trim(),
    permissions: {
      // Метка персональной роли едет внутри прав: см. комментарий у roleToRow — колонки
      // под неё нет, а jsonb сохраняется целиком в любом бэкенде.
      ...(String(input.personalFor ?? p.personalFor ?? '').trim() ? { personalFor: String(input.personalFor ?? p.personalFor).trim() } : {}),
      // Роль «без оплаты» (тест/модератор): доступ к модулям в обход подписки.
      freeAccess: !!p.freeAccess,
      modules: normPermMap(p.modules),
      blocks: normPermMap(p.blocks), // ключ = `${moduleKey}:${blockKey}`
      sections: normPermMap(p.sections), // ключ = путь раздела (напр. '/panel/proxies')
      resources: {
        accounts: normPermMap(r.accounts), // accountId → allow/deny (кто виден роли)
        accountGroups: normPermMap(r.accountGroups), // §12: groupId → allow/deny (доступ на всю группу)
        folders: normPermMap(r.folders),
        channels: normPermMap(r.channels),
        folderChannels: normFolderChannels(r.folderChannels),
        timers: normPerm(r.timers),
        searchTemplates: normPerm(r.searchTemplates),
        allTasks: normPerm(r.allTasks),
        support: normPerm(r.support),
      },
    },
  }
}

const moduleMap = (keys, val) => Object.fromEntries(keys.map((k) => [k, val]))
const blockMap = (keys, blocks, val) => Object.fromEntries(keys.flatMap((k) => blocks.map((b) => [`${k}:${b}`, val])))
/** Карта разделов key→val. Без аргумента keys — все разделы каталога. */
const sectionMap = (val, keys = SECTIONS.map((s) => s.key)) => Object.fromEntries(keys.map((k) => [k, val]))

/**
 * Стартовый набор ролей — осмысленные шаблоны под реальные функции (не «всё подряд»).
 *  - Администратор — bypass (всё);
 *  - Оператор — универсальный исполнитель: все модули, все блоки, все разделы;
 *  - Модератор — вовлечение/модерация: комментинг/чаттинг/диалоги/реакции/масслукинг
 *    (запуск+настройки+цели+результаты+логи, БЕЗ редактирования шаблонов);
 *  - Sales — аутрич/CRM: запуск чаттинга/диалогов/мейлинга целиком + просмотр остального;
 *  - Viewer — только просмотр: результаты/логи + отчётные разделы.
 * Каждый шаблон: аккаунты по умолчанию НЕ выданы (админ раздаёт точечно).
 */
function defaultRoles() {
  const now = Date.now()
  const mods = Object.keys(MODULE_LABELS)
  const ALL_BLOCKS = BLOCKS.map((b) => b.key)                 // run/settings/targets/templates/results
  const VIEW = ['results']                                     // только просмотр
  const OPS = ['run', 'settings', 'targets', 'results']         // работа без редактирования промптов
  const OUTREACH = mods.filter((k) => ['neuro-chatting', 'neuro-dialogs', 'mailing'].includes(k))
  const ENGAGE = mods.filter((k) => ['neuro-commenting', 'neuro-chatting', 'neuro-dialogs', 'mass-react', 'mass-looking'].includes(k))
  const roleTpl = (id, name, permissions) => ({ id, name, builtin: false, isTemplate: true, permissions, createdAt: now, updatedAt: now })
  const res = (over = {}) => ({ accounts: {}, folders: {}, channels: {}, timers: DENY, searchTemplates: DENY, allTasks: DENY, support: DENY, ...over })
  return [
    {
      id: ADMIN_ROLE_ID,
      name: 'Администратор',
      builtin: true,
      isTemplate: false,
      permissions: { modules: {}, blocks: {}, sections: {}, resources: res({ timers: ALLOW, searchTemplates: ALLOW, allTasks: ALLOW }) },
      createdAt: now,
      updatedAt: now,
    },
    // Оператор — всё операционное: любые модули, все блоки, все разделы.
    roleTpl('role_operator', 'Оператор', {
      modules: moduleMap(mods, ALLOW),
      blocks: blockMap(mods, ALL_BLOCKS, ALLOW),
      sections: sectionMap(ALLOW),
      resources: res({ timers: ALLOW, searchTemplates: ALLOW }),
    }),
    // Модератор — вовлечение сообщества: только engagement-модули, без шаблонов и без парсинга/рассылок.
    roleTpl('role_moderator', 'Модератор', {
      modules: moduleMap(ENGAGE, ALLOW),
      blocks: blockMap(ENGAGE, OPS, ALLOW),
      sections: sectionMap(ALLOW, ['/panel', '/panel/tasks', '/panel/crm', '/panel/analytics', '/panel/my-statistics', '/panel/logs', '/panel/inbox', '/panel/channels']),
      resources: res({ searchTemplates: ALLOW }),
    }),
    // Sales — аутрич/продажи: чаттинг/диалоги/мейлинг целиком, остальное — просмотр.
    roleTpl('role_sales', 'Sales', {
      modules: moduleMap(mods, ALLOW),
      blocks: { ...blockMap(mods, VIEW, ALLOW), ...blockMap(OUTREACH, ALL_BLOCKS, ALLOW) },
      sections: sectionMap(ALLOW, ['/panel', '/panel/goals', '/panel/tasks', '/panel/crm', '/panel/analytics', '/panel/my-statistics', '/panel/inbox', '/panel/logs']),
      resources: res({ searchTemplates: ALLOW }),
    }),
    // Viewer — наблюдатель: результаты/логи + отчётные разделы, без запуска и настроек.
    roleTpl('role_viewer', 'Viewer', {
      modules: moduleMap(mods, ALLOW),
      blocks: blockMap(mods, VIEW, ALLOW),
      sections: sectionMap(ALLOW, ['/panel/tasks', '/panel/analytics', '/panel/my-statistics', '/panel/logs', '/panel/inbox']),
      resources: res(),
    }),
    // Поддержка — только тикеты: видит все обращения, отвечает как поддержка. Больше
    // ничего (никаких модулей/разделов, кроме «Поддержки»).
    roleTpl('role_support', 'Поддержка', {
      modules: {},
      blocks: {},
      sections: sectionMap(ALLOW, ['/panel/support']),
      resources: res({ support: ALLOW }),
    }),
  ]
}

export async function listRoles() {
  const db = sbRoles()
  if (db) {
    const { data } = await db.from('roles').select('*').order('created_at', { ascending: true })
    // Правила всех ролей одним запросом: список ролей лежит на горячем пути (проверка
    // доступа зовёт его на каждый запрос к API), и запрос на роль означал бы N+1.
    const { data: rules, error: rulesErr } = await db.from('role_permissions')
      .select('role_id, scope, subject, item_id, effect')
    const byRole = new Map()
    if (!rulesErr) for (const r of rules || []) {
      if (!byRole.has(r.role_id)) byRole.set(r.role_id, [])
      byRole.get(r.role_id).push(r)
    }
    // Ошибка чтения правил — миграция не доехала: тогда права берём из дерева, как
    // раньше. Разница принципиальная: пустой список правил у роли значит «прав нет», а
    // не «читать не удалось», и подменять его старым деревом было бы возвратом снятых прав.
    return (data || []).map((r) => rowToRole(r, rulesErr ? null : (byRole.get(r.id) || [])))
  }
  const roles = await readJson(ROLES_FILE(), null)
  if (!Array.isArray(roles)) {
    const seed = defaultRoles()
    await writeJson(ROLES_FILE(), seed)
    return seed
  }
  // §12: у ролей, созданных до групп аккаунтов, поля нет — дошиваем пустую карту,
  // чтобы матрица прав показывала группы (иначе нечего переключать).
  for (const r of roles) {
    if (r?.permissions?.resources && !r.permissions.resources.accountGroups) {
      r.permissions.resources.accountGroups = {}
    }
  }
  // Разовая миграция старых инсталляций: если НЕТ ни одной из §6-ролей
  // (Operator/Sales/Viewer) — добавляем их, не трогая существующие/пользовательские.
  // Гейт «ни одной» защищает от воскрешения одной удалённой дефолт-роли.
  const have = new Set(roles.map((r) => r.id))
  const sixIds = ['role_operator', 'role_moderator', 'role_sales', 'role_viewer']
  if (!sixIds.some((id) => have.has(id))) {
    const missing = defaultRoles().filter((r) => r.id !== ADMIN_ROLE_ID && !have.has(r.id))
    if (missing.length) {
      const merged = [...roles, ...missing]
      await writeJson(ROLES_FILE(), merged)
      return merged
    }
  }
  // Точечная миграция: роль «Поддержка» добавлена позже — дошиваем её, если её нет
  // (остальные дефолт-роли при этом уже могут быть, поэтому отдельно от блока выше).
  if (!have.has('role_support')) {
    const supp = defaultRoles().find((r) => r.id === 'role_support')
    if (supp) { roles.push(supp); await writeJson(ROLES_FILE(), roles) }
  }
  // Миграция поля `sections` (добавлено позже). Принцип: НЕ уменьшать доступ. До появления
  // `sections` все роли видели ВСЕ разделы — значит роли без этого поля получают весь набор
  // (allow). Новые роли стартуют с deny (emptyPermissions), админ выдаёт разделы вручную.
  const allSections = sectionMap(ALLOW)
  let migrated = false
  for (const r of roles) {
    if (r.permissions && r.permissions.sections == null) {
      r.permissions.sections = { ...allSections }
      migrated = true
    }
  }
  if (migrated) await writeJson(ROLES_FILE(), roles)
  return roles
}

export async function getRole(id) {
  const roles = await listRoles()
  return roles.find((r) => r.id === id) || null
}

/** Создать роль. @param {object} input @throws при пустом имени */
/**
 * Имя роли уже занято у ЭТОГО владельца? Сравниваем без регистра и лишних пробелов.
 *
 * Запрет клиентский существовал, но прямой запрос его обходил — а мусор копится быстро:
 * у владельца накопились 44 роли, среди них по три «Тимлид» и «Уволенный», отличить
 * которые невозможно (21.08). Чужие роли не мешают: у каждого владельца свой список.
 * @param {object[]} roles @param {string} name @param {string} userId @param {string} [skipId]
 */
function nameTaken(roles, name, userId, skipId = '') {
  const norm = (v) => String(v || '').trim().toLowerCase()
  const target = norm(name)
  return roles.some((r) => r.id !== skipId && norm(r.userId) === norm(userId) && norm(r.name) === target)
}

export async function createRole(input) {
  const clean = normalizeRole(input)
  if (!clean.name) throw new Error('Укажите название роли')
  const roles = await listRoles()
  if (nameTaken(roles, clean.name, clean.userId)) {
    throw new Error(`Роль «${clean.name}» уже есть — выберите другое название`)
  }
  const role = {
    id: `role_${crypto.randomUUID().slice(0, 8)}`,
    builtin: false,
    ...clean,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  const db = sbRoles()
  if (db) {
    const { insertWithOwner } = await import('./lib/ownerColumn.js')
    await insertWithOwner(db, 'roles', roleToRow(role))
    await writeRoleRules(db, role)
    return role
  }
  roles.push(role)
  await writeJson(ROLES_FILE(), roles)
  return role
}

/**
 * Обновить роль (имя и/или права). Встроенного админа переименовать можно, но права —
 * нет (он всегда bypass, менять нечего). @param {string} id @param {object} patch
 */
export async function updateRole(id, patch = {}) {
  const roles = await listRoles()
  const i = roles.findIndex((r) => r.id === id)
  if (i === -1) return null
  const clean = normalizeRole({ ...roles[i], ...patch })
  if (!clean.name) throw new Error('Название роли не может быть пустым')
  if (nameTaken(roles, clean.name, clean.userId || roles[i].userId, id)) {
    throw new Error(`Роль «${clean.name}» уже есть — выберите другое название`)
  }
  roles[i] = {
    ...roles[i],
    name: clean.name,
    isTemplate: clean.isTemplate,
    // Владельца сохраняем: правка роли не должна делать её ничьей (см. normalizeRole).
    userId: clean.userId || roles[i].userId || '',
    personalFor: clean.personalFor || roles[i].personalFor || '',
    // Права админа неизменяемы (bypass); у остальных — обновляем.
    ...(roles[i].id === ADMIN_ROLE_ID ? {} : { permissions: clean.permissions }),
    updatedAt: Date.now(),
  }
  const db = sbRoles()
  if (db) {
    // §11.3: updateWithOwner — до применения миграции колонки user_id нет, и обычный
    // update уронил бы правку роли целиком. Владелец при этом сохраняется: rowToRole
    // читает его из БД, roleToRow кладёт обратно.
    const { updateWithOwner } = await import('./lib/ownerColumn.js')
    await updateWithOwner(db, 'roles', roleToRow(roles[i]), 'id', id)
    await writeRoleRules(db, roles[i])
    return roles[i]
  }
  await writeJson(ROLES_FILE(), roles)
  return roles[i]
}

/** Удалить роль (кроме встроенных). @param {string} id */
export async function deleteRole(id) {
  const roles = await listRoles()
  const target = roles.find((r) => r.id === id)
  if (!target) return false
  if (target.builtin) throw new Error('Встроенную роль удалить нельзя')
  const db = sbRoles()
  if (db) { await db.from('roles').delete().eq('id', id); return true }
  const next = roles.filter((r) => r.id !== id)
  await writeJson(ROLES_FILE(), next)
  return true
}

/**
 * Каталог того, что можно раздавать: модули × блоки + ресурсы (с реальными элементами).
 * Фронт рендерит матрицу прав из этого каталога.
 */
/**
 * @param {{ modules?: string[]|'all'|null }} [limit] чем ограничить каталог модулей.
 *   Владелец пространства раздаёт роли своим субам (решение владельца 21.08: «если у
 *   овнера 5 купленных модулей, он может скрыть видимость у суба»), и показывать ему
 *   все 14 модулей платформы — значит предлагать выдать то, за что не заплачено:
 *   роль сохранится, а `accessGuard` всё равно упрётся в подписку. Пусть выбор с самого
 *   начала совпадает с тем, что реально может работать. Админ платформы видит всё.
 */
export async function buildCatalog(limit = null) {
  const allow = limit?.modules
  const modules = Object.entries(MODULE_LABELS)
    .filter(([key]) => !allow || allow === 'all' || (Array.isArray(allow) && allow.includes(key)))
    .map(([key, label]) => ({ key, label }))
  const [folders, channels, meta, groups] = await Promise.all([listFolders(), listChannels(), loadAllMeta(), listGroups()])

  /*
   * Утечка, найденная владельцем 21.08: каталог показывал РЕСУРСЫ ВСЕЙ ПЛАТФОРМЫ —
   * чужие Telegram-аккаунты по именам, чужие папки и каналы. Я ограничил подпиской
   * только модули, а ресурсы оставил как были, и на живом стенде клиент увидел
   * тринадцать чужих профилей: и сам факт их существования, и как людей зовут.
   *
   * Владелец видит только СВОЁ (ownerId / userId записи). Записи без владельца —
   * заведённые до появления скоупа — остаются видны лишь админу платформы: угадать
   * задним числом, чьи они, нельзя, а показывать всем «на всякий случай» — это и есть
   * та самая утечка.
   */
  const owner = limit?.ownerId ? String(limit.ownerId) : null
  const mine = (rec) => {
    if (!owner) return true                                   // админ/дев — полный список
    const o = String(rec?.ownerId || rec?.userId || '')
    return o ? o === owner : false
  }

  // Аккаунты для выдачи доступа (лёгкий список из метаданных — без подключения к Telegram).
  const accountItems = Object.entries(meta)
    .filter(([, m]) => m && !m.inTrash && mine(m))
    .map(([id, m]) => ({ id, label: m.name || (m.username ? '@' + m.username : id) }))
  const resources = [
    { type: 'accounts', label: 'Аккаунты (кто виден роли)', perItem: true, items: accountItems },
    // §12: доступ сразу на группу — удобнее, чем отмечать аккаунты по одному.
    { type: 'accountGroups', label: 'Группы аккаунтов (доступ на всю группу)', perItem: true, items: groups.filter(mine).map((g) => ({ id: g.id, label: `${g.name} · ${(g.accountIds || []).length} акк.` })) },
    { type: 'folders', label: 'Папки целей', perItem: true, items: folders.filter(mine).map((f) => ({ id: f.id, label: f.name || f.id, channels: f.targets || [] })) },
    { type: 'channels', label: 'Целевые каналы', perItem: true, items: channels.filter(mine).map((c) => ({ id: c.id, label: c.title || (c.username ? '@' + c.username : c.id) })) },
    { type: 'timers', label: 'Таймеры / планировщик', perItem: false },
    { type: 'searchTemplates', label: 'Шаблоны поиска', perItem: false },
    { type: 'allTasks', label: 'Чужие задачи (видеть и управлять всеми в Дашборде)', perItem: false },
  ]
  /*
   * `blocks` (плоский список) остаётся для совместимости — по нему рисуется строка
   * «блок во ВСЕХ модулях». А `blocksByModule` говорит, какие блоки есть у КАЖДОГО
   * модуля и как они называются на его экране: у парсера нет промптов, у прогрева нет
   * целей, и показывать эти тумблеры значит обещать несуществующее (правка 26.08).
   */
  const blocksByModule = Object.fromEntries(modules.map((m) => [m.key, blocksForModule(m.key)]))
  return { modules, blocks: BLOCKS, blocksByModule, sections: SECTIONS, resources }
}

/**
 * Разрешён ли доступ роли к цели. Чистая функция (юнит-тест + будущий enforcement).
 * Админ (builtin ADMIN_ROLE_ID) — всегда true. По умолчанию — deny.
 * @param {object|null} role
 * @param {'module'|'block'|'section'|'account'|'accountGroup'|'folder'|'channel'|'timers'|'searchTemplates'|'allTasks'} kind
 * @param {string} [key]
 */
export function can(role, kind, key) {
  if (!role) return false
  if (role.builtin && role.id === ADMIN_ROLE_ID) return true
  const p = role.permissions || {}
  switch (kind) {
    case 'module': return p.modules?.[key] === ALLOW
    case 'block': return p.blocks?.[key] === ALLOW
    case 'section': return p.sections?.[key] === ALLOW
    case 'account': return p.resources?.accounts?.[key] === ALLOW
    case 'accountGroup': return p.resources?.accountGroups?.[key] === ALLOW // §12
    case 'folder': return p.resources?.folders?.[key] === ALLOW
    case 'channel': return p.resources?.channels?.[key] === ALLOW
    case 'timers': return p.resources?.timers === ALLOW
    case 'searchTemplates': return p.resources?.searchTemplates === ALLOW
    case 'allTasks': return p.resources?.allTasks === ALLOW
    default: return false
  }
}

const normTarget = (t) => String(t || '').trim().replace(/^@/, '').toLowerCase()

/**
 * Какие каналы папки видит роль. Админ — все. Папка не разрешена — []. Разрешена без
 * списка каналов — все каналы папки. Со списком — только выбранные (пересечение).
 * @param {object|null} role @param {string} folderId @param {string[]} folderTargets
 * @returns {string[]}
 */
export function allowedFolderTargets(role, folderId, folderTargets = []) {
  if (!role) return folderTargets
  if (role.builtin && role.id === ADMIN_ROLE_ID) return folderTargets
  const folders = role.permissions?.resources?.folders || {}
  if (Object.keys(folders).length === 0) return folderTargets // права папок не заданы — не ограничиваем
  if (folders[folderId] !== ALLOW) return []
  const fc = role.permissions?.resources?.folderChannels?.[folderId]
  if (!Array.isArray(fc) || fc.length === 0) return folderTargets
  const allow = new Set(fc.map(normTarget))
  return folderTargets.filter((t) => allow.has(normTarget(t)))
}

/** Список ролей пользователя (мульти-роль). Совместимо со старым одиночным roleId. @param {object|null} user */
export function userRoleIds(user) {
  if (!user) return []
  const raw = Array.isArray(user.roleIds) ? user.roleIds : (user.roleId != null ? [user.roleId] : [])
  return [...new Set(raw.map((x) => String(x || '').trim()).filter(Boolean))]
}

/** Есть ли у набора ролей админ (bypass). @param {string[]} ids */
export function hasAdminRole(ids = []) {
  return ids.includes(ADMIN_ROLE_ID)
}

/** Есть ли у роли право «Поддержка» (видеть все тикеты и отвечать как поддержка). @param {object[]} roles */
export function hasSupportCap(roles = []) {
  return (roles || []).some((r) => r?.permissions?.resources?.support === ALLOW)
}

/** Загрузить объекты ролей пользователя. @param {object|null} user @returns {Promise<object[]>} */
export async function rolesForUser(user) {
  const out = []
  for (const id of userRoleIds(user)) {
    const r = await getRole(id)
    if (r) out.push(r)
  }
  return out
}

/**
 * Объединить права нескольких ролей (union — «суммирование»): доступ allow, если его даёт
 * хотя бы одна роль. Каналы внутри папки складываются; если хоть одна роль дала папку без
 * ограничения по каналам (пустой список) — ограничение снимается (= все каналы). §8.1.
 * @param {object[]} roles @returns {RolePermissions}
 */
/**
 * Слить одно поэлементное право в общую карту. Семантика — «запрет сильнее»:
 * если хоть одна роль явно запретила элемент, объединение остаётся запретом,
 * сколько бы других ролей его ни разрешало. Иначе точечный запрет невозможно
 * было бы задать поверх группового доступа — ради чего он и существует.
 * @param {Record<string,string>} map @param {string} key @param {string} value
 */
function mergeItem(map, key, value) {
  if (map[key] === DENY) return // уже запрещено — allow не перебивает
  map[key] = value
}

/**
 * Полные права «без ограничений ролью» — для того, у кого роли нет вовсе.
 *
 * Правка 18.08. `null` в правах на сервере означал «не ограничен», а на клиенте
 * `can(null, …)` возвращает false — то есть ровно противоположное. Из-за расхождения
 * человек, зарегистрировавшийся сам и оплативший модули, не видел в меню НИЧЕГО:
 * подписка есть, «оплачен» стоит, а слева пусто (прогон 18.08, аккаунт Test Purchases).
 *
 * Отдаём явный объект: все модули и разделы разрешены. Что именно окажется в меню,
 * дальше решает ПОДПИСКА — неоплаченные модули отсекаются отдельной осью.
 * Субпользователям это не выдаётся: сотрудник без роли прав не получает.
 */
export function unrestrictedPermissions(moduleKeys = []) {
  const modules = {}
  for (const k of moduleKeys) modules[k] = ALLOW
  // Блоки именуются «модуль:блок» (`neuro-chatting:run`), а не просто «run»: право
  // выдаётся на блок КОНКРЕТНОГО модуля. Плоские ключи, выданные здесь поначалу, не
  // совпадали ни с чем — владелец видел «доступ к модулю есть, но не выдан ни один
  // блок» на пустой странице (прогон 18.08).
  const blocks = {}
  for (const m of moduleKeys) for (const b of BLOCKS) blocks[`${m}:${b.key}`] = ALLOW
  const sections = {}
  for (const s of SECTIONS) sections[s.key] = ALLOW
  return {
    modules,
    blocks,
    sections,
    resources: { accounts: {}, accountGroups: {}, folders: {}, channels: {}, folderChannels: {}, timers: ALLOW, searchTemplates: ALLOW, allTasks: ALLOW },
  }
}

export function mergePermissions(roles = []) {
  const resources = { accounts: {}, accountGroups: {}, folders: {}, channels: {}, folderChannels: {}, timers: DENY, searchTemplates: DENY, allTasks: DENY }
  const merged = { modules: {}, blocks: {}, sections: {}, resources }
  const wholeFolder = new Set() // папки, где хоть одна роль дала «все каналы»
  for (const role of roles) {
    const p = role?.permissions
    if (!p) continue
    const r = p.resources || {}
    for (const [k, v] of Object.entries(p.modules || {})) if (v === ALLOW) merged.modules[k] = ALLOW
    for (const [k, v] of Object.entries(p.blocks || {})) if (v === ALLOW) merged.blocks[k] = ALLOW
    for (const [k, v] of Object.entries(p.sections || {})) if (v === ALLOW) merged.sections[k] = ALLOW
    // §8.1: поэлементные ресурсы копируем ВМЕСТЕ С ЗАПРЕТАМИ. Раньше сюда проходил
    // только ALLOW, поэтому явный точечный deny терялся при объединении ролей и до
    // клиента не доезжал никогда — точечный запрет не работал в принципе
    // (прогон 21–22.07, тест 7.4). Приоритет разрешается ниже: deny сильнее allow.
    for (const [k, v] of Object.entries(r.accounts || {})) if (v === ALLOW || v === DENY) mergeItem(resources.accounts, k, v)
    for (const [k, v] of Object.entries(r.accountGroups || {})) if (v === ALLOW || v === DENY) mergeItem(resources.accountGroups, k, v) // §12
    for (const [k, v] of Object.entries(r.channels || {})) if (v === ALLOW || v === DENY) mergeItem(resources.channels, k, v)
    if (r.timers === ALLOW) resources.timers = ALLOW
    if (r.searchTemplates === ALLOW) resources.searchTemplates = ALLOW
    // Без этой строки право «чужие задачи» терялось при объединении ролей: сервер
    // читает роли напрямую и работал верно, а фронт получал права БЕЗ него и
    // молча отказывал — расхождение, которое видно только в интерфейсе.
    if (r.allTasks === ALLOW) resources.allTasks = ALLOW
    const fc = r.folderChannels || {}
    for (const [folderId, v] of Object.entries(r.folders || {})) {
      // Запрет на папку тоже должен доживать до клиента и побеждать разрешение другой
      // роли — иначе точечный запрет работает для аккаунтов и каналов, но молча
      // не работает для папок (найдено аудитом собственных правок 22.07, ср. тест 7.4).
      if (v === DENY) { mergeItem(resources.folders, folderId, DENY); continue }
      if (v !== ALLOW) continue
      if (resources.folders[folderId] === DENY) continue // запрет уже поставлен — allow не перебивает
      resources.folders[folderId] = ALLOW
      const list = fc[folderId]
      if (!Array.isArray(list) || list.length === 0) {
        wholeFolder.add(folderId)
      } else {
        const cur = resources.folderChannels[folderId] || []
        resources.folderChannels[folderId] = [...new Set([...cur, ...list.map(normTarget)])]
      }
    }
  }
  for (const folderId of wholeFolder) delete resources.folderChannels[folderId] // «вся папка» побеждает
  return merged
}
