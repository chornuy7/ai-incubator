/**
 * MR-186: сторы переезжают из файлов в общую базу. Здесь сверяются ДВЕ стороны переезда.
 *
 * Обычные тесты сторов гоняют файловый режим — в нём опечатка в имени колонки не видна
 * вовсе, всё зелено. А цена такой опечатки высокая: на боевой запись молча не проходит.
 * Клиент отправил обращение и остался без поддержки; оператор отметил выход, а смена
 * не закрылась. Узнаём об этом от людей, а не от тестов.
 *
 * Поэтому проверяем:
 *   • всё, к чему код обращается по имени, есть в миграции;
 *   • всё, что миграция требует обязательно, код действительно заполняет.
 *
 * Новый переезд — добавьте строку в STORES ниже, больше ничего писать не надо.
 * Если тест покраснел — схему поменяли в одном месте из двух.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

/** @type {Array<{name:string, sql:string, code:string, tables:string[], notColumns?:string[]}>} */
const STORES = [
  {
    name: 'обращения в поддержку',
    sql: ['2026-08-27-tickets.sql', '2026-08-31-mr257-ticket-owner.sql'],
    code: 'tickets.js',
    tables: ['tickets', 'ticket_messages'],
    // Имя второй таблицы встречается в коде как строка — колонкой оно не является.
    notColumns: ['ticket_messages', 'schema cache'],
  },
  {
    name: 'учёт рабочего времени',
    sql: '2026-08-27-work-log.sql',
    code: 'workLog.js',
    tables: ['work_log'],
    notColumns: ['work_log', 'schema cache'],
  },
  {
    name: 'база знаний',
    sql: '2026-08-27-knowledge-base.sql',
    code: 'knowledgeBase.js',
    tables: ['knowledge_base'],
    notColumns: ['knowledge_base', 'schema cache'],
  },
  {
    name: 'вложения базы знаний',
    sql: '2026-08-27-knowledge-base.sql',
    code: 'kbFiles.js',
    tables: ['kb_files'],
    notColumns: ['kb_files', 'schema cache'],
  },
  {
    name: 'папки целей',
    sql: '2026-08-27-target-folders.sql',
    code: 'targetFolders.js',
    tables: ['target_folders', 'target_folder_targets'],
    notColumns: ['target_folders', 'target_folder_targets', 'schema cache'],
  },
  {
    name: 'автоматизация',
    sql: '2026-08-27-automation.sql',
    code: 'automation/store.js',
    tables: ['automation_rules', 'automation_rule_accounts'],
    notColumns: ['automation_rules', 'automation_rule_accounts', 'schema cache'],
  },
  {
    name: 'счётчик переходов',
    sql: '2026-08-27-link-tracker.sql',
    code: 'linkTracker.js',
    tables: ['tracked_links', 'link_hits'],
    notColumns: ['tracked_links', 'link_hits', 'schema cache'],
  },
  {
    name: 'состав групп аккаунтов',
    sql: ['2026-07-30-remaining-stores.sql', '2026-07-30-owner-stores.sql', '2026-09-01-mr290-group-members.sql'],
    code: 'accountGroups.js',
    tables: ['account_groups', 'account_group_members'],
    notColumns: ['account_group_members', 'account_groups', 'schema cache'],
  },
]

/**
 * Схема таблицы — это НЕ один файл: базовая миграция плюс поздние `alter table`. Колонку,
 * добавленную отдельной миграцией (так и надо: применённый файл менять нельзя), тест иначе
 * считал бы несуществующей и краснел на верном коде.
 */
const readSql = async (f) => {
  const файлы = Array.isArray(f) ? f : [f]
  const куски = await Promise.all(файлы.map((x) => fs.readFile(new URL(`../../supabase/migrations/${x}`, import.meta.url), 'utf8')))
  return куски.join('\n')
}
const readCode = (f) => fs.readFile(new URL(`../${f}`, import.meta.url), 'utf8')

/**
 * Схлопнуть пробелы и переводы строк — чтобы сверять по тексту, а не регуляркой.
 *
 * Проверки здесь ищут куски SQL и кода со скобками. В регулярке их пришлось бы
 * экранировать, и ОДНА пропущенная обратная косая молча превращает проверку в «ничего не
 * нашлось» — то есть в зелёный тест, который ничего не проверяет. Это уже случалось в
 * этом файле дважды. Со схлопнутым текстом и `includes` экранировать нечего.
 */
const flatten = (s) => s.replace(/\s+/g, ' ')

/** Колонки таблицы из `create table` в миграции: имя → остаток строки с типом и флагами. */
function columnsOf(sql, table) {
  const at = sql.indexOf(`create table if not exists ${table} (`)
  assert.ok(at > 0, `в миграции нет таблицы ${table}`)
  // Колонки, добавленные позже отдельной миграцией, — такая же часть схемы.
  const добавленные = [...sql.matchAll(new RegExp(String.raw`alter table (?:public\.)?${table}\s+add column if not exists ([a-z0-9_]+)`, 'gi'))].map((m) => m[1])
  const rest = sql.slice(at)
  const body = rest.slice(rest.indexOf('(') + 1, rest.indexOf('\n);'))
  const cols = new Map()
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('--') || line.startsWith('constraint')) continue
    const m = line.match(/^([a-z][a-z0-9_]*)\s+(.+?),?$/)
    if (m) cols.set(m[1], m[2])
  }
  assert.ok(cols.size, `у таблицы ${table} не разобрана ни одна колонка`)
  for (const c of добавленные) if (!cols.has(c)) cols.set(c, 'text')
  return cols
}

/**
 * Имена колонок, которыми оперирует код: ключи объектов вида `user_id:`, строковые
 * литералы `'read_support'` и короткие имена в фильтрах `.eq('id', …)`.
 * Локальные имена в проекте camelCase, поэтому всё подчёркнутое в позиции ключа —
 * это обращение к базе, а не к своей переменной.
 */
function columnsUsedInCode(code) {
  const used = new Set()
  for (const m of code.matchAll(/(?:^|[{,(\s])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*:/gm)) used.add(m[1])
  for (const m of code.matchAll(/'([a-z][a-z0-9]*(?:_[a-z0-9]+)+)'/g)) used.add(m[1])
  for (const m of code.matchAll(/\.(?:eq|neq|order|like|ilike|in|is|gt|gte|lt|lte)\('([a-z_]+)'/g)) used.add(m[1])
  return used
}

for (const store of STORES) {
  test(`${store.name}: код не обращается к колонкам, которых нет в миграции`, async () => {
    const sql = await readSql(store.sql)
    const code = await readCode(store.code)
    const known = new Set(store.tables.flatMap((t) => [...columnsOf(sql, t).keys()]))
    const skip = new Set(store.notColumns || [])
    const unknown = [...columnsUsedInCode(code)].filter((c) => !known.has(c) && !skip.has(c))
    assert.deepEqual(unknown, [], [
      `В ${store.code} есть колонки, которых нет в ${store.sql}.`,
      'На боевой это тихая ошибка записи — данные не сохранятся, и никто не узнает.',
      'Лишние:', ...unknown.map((c) => '  · ' + c),
    ].join('\n'))
  })

  test(`${store.name}: обязательные колонки где-то заполняются`, async () => {
    const sql = await readSql(store.sql)
    const code = await readCode(store.code)
    const missing = []
    for (const table of store.tables) {
      for (const [col, def] of columnsOf(sql, table)) {
        // Колонку с DEFAULT база заполнит сама; остальные обязана заполнить запись.
        if (!/not null/i.test(def) || /default/i.test(def)) continue
        // `username: x`, но и сокращённая запись `{ folder_id, username, position }` —
        // иначе тест ругается на код, который колонку как раз заполняет.
        if (!new RegExp(`\\b${col}\\s*[:,}]`).test(code)) missing.push(`${table}.${col}`)
      }
    }
    assert.deepEqual(missing, [], [
      `${store.code} не заполняет обязательные колонки: ${missing.join(', ')}`,
      'База отвергнет такую вставку целиком.',
    ].join('\n'))
  })
}

test('обращения: статусы совпадают в коде и в ограничении базы', async () => {
  const sql = await readSql('2026-08-27-tickets.sql')
  const code = await readCode('tickets.js')
  const chk = sql.match(/tickets_status_chk check \(status in \(([^)]+)\)\)/)
  assert.ok(chk, 'в миграции нет проверки статусов')
  const inSql = chk[1].split(',').map((s) => s.trim().replace(/'/g, '')).sort()
  const inCode = code.match(/export const TICKET_STATUSES = \[([^\]]+)\]/)[1]
    .split(',').map((s) => s.trim().replace(/'/g, '')).sort()
  assert.deepEqual(inSql, inCode, [
    'Список статусов разошёлся. База отвергнет статус, которого нет в её проверке,',
    'и перевод обращения молча не сохранится.',
  ].join('\n'))
})

test('обращения: переписка лежит строками, а не полем-JSON', async () => {
  // Правило владельца с созвона 24.08: «JSON в базе = ошибка». Сообщение — это данные
  // со своим автором и временем, по ним считают непрочитанное; складывать их в одно
  // поле значит лишить базу возможности их различать.
  const sql = await readSql('2026-08-27-tickets.sql')
  assert.ok(/create table if not exists ticket_messages/.test(sql), 'переписка должна быть отдельной таблицей')
  assert.ok(!/jsonb/i.test(sql), 'в схеме обращений не должно быть jsonb-полей')
  const messages = columnsOf(sql, 'ticket_messages')
  assert.ok(messages.has('side') && messages.has('ts') && messages.has('author_name'),
    'у сообщения должны быть своя сторона, время и автор на момент отправки')
})

test('мета аккаунта: каждая колонка из карты есть в миграции', async () => {
  // Мета собиралась из одного jsonb, а типизированные колонки рядом не читались никем —
  // типы стояли, но не работали. Теперь отображение объявлено списком COLUMNS в
  // accountsMeta.js, и список обязан совпадать со схемой: колонка, которой нет в базе,
  // даёт тихую ошибку записи — строка не сохранится, и никто не узнает (MR-290).
  const code = await readCode('accountsMeta.js')
  const block = code.match(/const COLUMNS = \[([\s\S]*?)\n\]/)
  assert.ok(block, 'в accountsMeta.js нет карты COLUMNS')
  const mapped = [...block[1].matchAll(/'[a-zA-Z]+',\s*'([a-z_]+)'/g)].map((m) => m[1])
  assert.ok(mapped.length > 25, `карта подозрительно короткая: ${mapped.length}`)

  // Колонки берутся из трёх мест: исходная таблица, владелец из owner-миграции и
  // 25 новых. Схема таблицы — это вся её история, а не один файл.
  const sql = await readSql([
    '2026-07-30-owner-and-types.sql',
    '2026-09-01-mr290-account-secrets.sql',
    '2026-09-01-mr290-accounts-meta-columns.sql',
    '2026-09-01-mr290-proxies-rework.sql',
  ])
  const known = new Set([
    // Колонки из schema.sql — он снимок, а не миграция, поэтому перечислены здесь.
    'id', 'name', 'username', 'phone', 'status', 'proxy', 'country', 'in_trash', 'updated_at',
    ...[...sql.matchAll(/add column if not exists ([a-z_]+)/gi)].map((m) => m[1]),
  ])
  const missing = mapped.filter((c) => !known.has(c))
  assert.deepEqual(missing, [], `в схеме нет колонок: ${missing.join(', ')}`)
})

test('мета аккаунта: владелец лежит в колонке с внешним ключом, а не в json', async () => {
  // Самый показательный случай задачи: колонка user_id со ссылкой на профиль существует
  // с июля и была ПУСТА на всех 63 строках, пока доступ резался по data.ownerId.
  const sql = await readSql('2026-09-01-mr290-accounts-meta-columns.sql')
  assert.match(sql, /update accounts_meta\s+set user_id = nullif\(data->>'ownerId',''\)/,
    'владелец должен переехать из json в колонку')
  const code = await readCode('accountsMeta.js')
  assert.match(code, /\['ownerId',\s+'user_id',\s+'text'\]/,
    'карта обязана связывать ownerId с колонкой user_id — иначе колонка снова останется пустой')
})

test('выдачи субу: права лежат строками со ссылками, а не массивами text[]', async () => {
  // profiles.account_ids и account_group_ids — это ВЫДАННЫЕ ПРАВА. Массив база проверить
  // не может, и в боевых данных нашлось право на аккаунт acc_9 и группу grp_1, которых
  // не существует: интерфейс выдачу показывал, проверка доступа молча её не находила.
  // Право, ведущее в никуда, — худший вид ошибки в доступах: он не виден ни с одной
  // стороны (MR-290).
  const sql = await readSql('2026-09-01-mr290-subuser-grants.sql')
  for (const [table, col, parent] of [
    ['profile_account_grants', 'account_id', 'accounts_meta'],
    ['profile_group_grants', 'group_id', 'account_groups'],
  ]) {
    // Сверяем по тексту со схлопнутыми пробелами, а не регуляркой: в regexp пришлось бы
    // экранировать скобки, и одна лишняя обратная косая молча превратила бы проверку в
    // «ничего не нашлось» — то есть в зелёный тест, который ничего не проверяет.
    const flat = sql.replace(/\s+/g, ' ')
    const cols = columnsOf(sql, table)
    assert.ok(cols.has('profile_id') && cols.has(col), `${table}: выдача — это пара «профиль + объект»`)
    assert.ok(flat.includes(`references ${parent}(id) on delete cascade`),
      `${table}: объект удалён — выданные на него права уходят с ним`)
    assert.ok(flat.includes(`primary key (profile_id, ${col})`),
      `${table}: одно и то же право нельзя выдать дважды`)
  }

  // Код больше не пишет выдачи в профиль: два источника одних и тех же прав однажды
  // разойдутся, и доступ станет зависеть от того, какой из них прочитали.
  const code = await readCode('users.js')
  assert.ok(!/account_ids:\s/.test(code) || !/update\(\{[^}]*account_ids/.test(code),
    'выдачи в profiles.account_ids больше не пишутся')
})

test('прокси: аккаунт связан ссылкой на каталог, а не строкой подключения', async () => {
  /*
   * Ровно тот случай, ради которого затевалась вся задача. Связь «аккаунт ↔ прокси» была
   * СТРОКОЙ: в accounts_meta.proxy лежал собранный URL, а сравнение шло по совпадению
   * этой строки с URL, собранным из каталога. На боевой она потерялась целиком — у 55
   * аккаунтов остался proxyId в json, а строка обнулилась, и все они ходили в Telegram
   * напрямую с адреса сервера. Ни интерфейс, ни счётчик занятости этого не показывали.
   */
  const sql = await readSql('2026-09-01-mr290-proxies-rework.sql')
  const flat = sql.replace(/\s+/g, ' ')
  assert.ok(flat.includes('foreign key (proxy_id) references proxies(id) on delete set null'),
    'связь должна быть внешним ключом: удалили прокси — аккаунт остаётся, но без прокси и это видно')
  assert.ok(flat.includes("update accounts_meta set proxy_id = nullif(data->>'proxyId','')"),
    'потерянная связь восстанавливается из json')

  // Строку подключения больше не хранят: два источника одной связи однажды разойдутся.
  const meta = await readCode('accountsMeta.js')
  assert.match(meta, /\['proxyId',\s+'proxy_id',\s+'text'\]/, 'в карте колонок должна быть ссылка')
  assert.match(meta, /delete rest\.proxy/, 'собранная строка в базу не пишется')

  // Счёт занятости и пометка статуса — по идентификатору, а не по совпадению строк.
  const px = await readCode('proxies.js')
  assert.match(px, /const id = meta\?\.proxyId/, 'занятость считается по ссылке')
  assert.match(px, /export async function markProxyStatus\(proxyId, status\)/,
    'статус ставится прокси по идентификатору, а не по разбору URL')
  assert.match(px, /hasPassword: !!stored/, 'каталог наружу отдаётся без паролей')
})

test('деньги: служебные владельцы объявлены в справочнике, а не только в коде', async () => {
  // `__default` и `workspace` — не мусор и не сироты, а понятия предметной области:
  // системный кошелёк платформы и общая подписка пространства. Пока они были строкой в
  // коде, база не могла отличить их от опечатки, и внешний ключ на деньги поставить было
  // нельзя. Теперь они строки wallet_owners — и списки обязаны совпадать: разойдутся —
  // запись под забытым ключом упрётся во внешний ключ уже на боевой (MR-290).
  const sql = await readSql('2026-09-01-mr290-wallet-owners.sql')
  const block = sql.match(/insert into wallet_owners \(id, kind, note\) values([\s\S]*?)on conflict/)
  assert.ok(block, 'в миграции нет вставки служебных владельцев')
  const inSql = [...block[1].matchAll(/\('([^']+)',\s*'(system|workspace)'/g)].map((m) => m[1]).sort()

  for (const file of ['tokenCredit.js', 'subscriptionBilling.js']) {
    const code = await readCode(file)
    const skip = code.match(/const SKIP = new Set\(\[([^\]]+)\]\)/)
    assert.ok(skip, `в ${file} нет списка служебных владельцев SKIP`)
    const inCode = skip[1].split(',').map((s) => s.trim().replace(/'/g, '')).sort()
    assert.deepEqual(inCode, inSql, [
      `Служебные владельцы кошелька разошлись: ${file} против миграции wallet-owners.`,
      'Ключ, которого нет в справочнике, отвергнет внешний ключ — списание не пройдёт.',
    ].join('\n'))
  }
})

test('деньги: тестовые записи помечены, а не удалены', async () => {
  // Решение владельца 01.09: 27 строк оплат и 12 строк кошелька, записанных прогонами
  // тестов прямо в боевую базу, помечаются видом `test` и остаются на месте. Удалить их
  // значило бы порвать историю, которая уже посчитана в отчётах.
  const sql = await readSql('2026-09-01-mr290-wallet-owners.sql')
  assert.match(sql, /kind in \('user', 'system', 'workspace', 'test'\)/,
    'у владельца кошелька должен быть отдельный вид для тестовых записей')
  assert.ok(!/delete from (payments|wallet_log|coin_balance)/i.test(sql),
    'денежные строки эта миграция удалять не должна — только помечать владельца')
})

test('группы аккаунтов: состав лежит строками со ссылками, а не JSON-массивом', async () => {
  // То же правило («JSON в базе = ошибка»), но цена выше: на группы выдаются права.
  // Массив идентификаторов база проверить не может, поэтому в группе спокойно оставался
  // удалённый аккаунт — право на него просто переставало действовать, молча. Теперь это
  // таблица связи с двумя внешними ключами: несуществующий аккаунт в неё не положить,
  // а удалённый уходит из всех групп сам (MR-290).
  const sql = await readSql('2026-09-01-mr290-group-members.sql')
  const cols = columnsOf(sql, 'account_group_members')
  assert.ok(cols.has('group_id') && cols.has('account_id'), 'состав — это пара «группа + аккаунт»')
  assert.ok(cols.has('position'), 'порядок аккаунтов в группе был свойством массива — в таблице его надо хранить явно')
  assert.match(sql, /references account_groups\(id\)\s+on delete cascade/i, 'группа удалена — состав уходит с ней')
  assert.match(sql, /references accounts_meta\(id\)\s+on delete cascade/i, 'аккаунт удалён — он уходит из всех групп сам')
  assert.match(sql, /primary key \(group_id, account_id\)/i, 'один аккаунт нельзя добавить в группу дважды')

  // И код больше не пишет состав в jsonb-колонку: два источника состава однажды разойдутся,
  // и права начнут зависеть от того, какой из них прочитали.
  const code = await readCode('accountGroups.js')
  assert.ok(!/account_ids\s*:/.test(code), 'account_ids больше не пишется — состав живёт в account_group_members')
})

test('учёт времени: открытая смена отличима от закрытой', async () => {
  // На этом держится и «человек на смене прямо сейчас», и закрытие выхода: без NULL
  // пришлось бы городить признак-флаг и следить, чтобы он не разошёлся с временем.
  const sql = await readSql('2026-08-27-work-log.sql')
  const cols = columnsOf(sql, 'work_log')
  assert.ok(cols.has('end_at'), 'нужна колонка окончания смены')
  assert.ok(!/not null/i.test(cols.get('end_at')), 'открытая смена — это end_at IS NULL, колонка обязана допускать NULL')
})

test('база знаний: вложения лежат в базе, а не на диске сервера', async () => {
  // Суть переезда: файл на диске одного инстанса для второго не существует — запись
  // базы знаний есть, ссылка есть, а вложение не открывается.
  const sql = await readSql('2026-08-27-knowledge-base.sql')
  const cols = columnsOf(sql, 'kb_files')
  assert.ok(/bytea/i.test(cols.get('data') || ''), 'содержимое файла должно храниться колонкой bytea')
  const code = await readCode('kbFiles.js')
  assert.ok(/supabaseEnabled\(\)/.test(code), 'у стора вложений должна быть ветка базы, а не только диск')
})

test('база знаний: вид записи ограничен и в коде, и в базе', async () => {
  const sql = await readSql('2026-08-27-knowledge-base.sql')
  const chk = sql.match(/knowledge_base_kind_chk check \(kind in \(([^)]+)\)\)/)
  assert.ok(chk, 'в миграции нет проверки вида записи')
  const inSql = chk[1].split(',').map((s) => s.trim().replace(/'/g, '')).sort()
  const code = await readCode('knowledgeBase.js')
  const inCode = code.match(/\['text', 'file', 'image', 'link'\]/)
  assert.ok(inCode, 'список видов в normalizeKb не найден')
  assert.deepEqual(inSql, ['file', 'image', 'link', 'text'], 'база отвергнет вид, которого нет в её проверке')
})

test('папки целей: один канал нельзя завести в папку дважды', async () => {
  // Дубли вида nuancesprog + NUANCESPROG приводили к тому, что кампания отрабатывала
  // по каналу ДВАЖДЫ одним аккаунтом, а повторные действия в один чат читаются как
  // сигнатура бота. Раньше это держалось только на normalizeTargets в коде.
  const sql = await readSql('2026-08-27-target-folders.sql')
  assert.ok(/primary key \(folder_id, username\)/.test(sql),
    'ключ (папка, канал) обязан быть первичным — иначе дубль запишется')
  assert.ok(!/jsonb/i.test(sql), 'цели папки — строки, а не список в одном поле')
  const code = await readCode('targetFolders.js')
  assert.ok(/toLowerCase\(\)/.test(code), 'перед записью цели приводятся к нижнему регистру')
})

test('автоматизация: расписание разложено по колонкам, а не спрятано в JSON', async () => {
  // Типов расписания три и полей у них по одному. Спрятать их в одно поле значило бы
  // спрятать от базы и проверку типа, и поиск «чему пора запускаться».
  const sql = await readSql('2026-08-27-automation.sql')
  const cols = columnsOf(sql, 'automation_rules')
  for (const c of ['schedule_type', 'schedule_at', 'schedule_interval_minutes', 'schedule_time']) {
    assert.ok(cols.has(c), `нужна колонка ${c}`)
  }
  const chk = sql.match(/automation_rules_schedule_chk check \(schedule_type in \(([^)]+)\)\)/)
  assert.ok(chk, 'тип расписания должен быть ограничен базой')
  const inSql = chk[1].split(',').map((s) => s.trim().replace(/'/g, '')).sort()
  assert.deepEqual(inSql, ['daily', 'interval', 'once'])
  const code = await readCode('automation/store.js')
  assert.ok(/\['once', 'interval', 'daily'\]/.test(code), 'список типов в sanitizeSchedule не найден')
})

test('автоматизация: один аккаунт нельзя записать в правило дважды', async () => {
  // Дубль означал бы двойную норму действий по аккаунту — прямой путь к ограничениям.
  const sql = await readSql('2026-08-27-automation.sql')
  assert.ok(/primary key \(rule_id, account_id\)/.test(sql), 'ключ (правило, аккаунт) обязан быть первичным')
})

test('автоматизация: массовой перезаписи правил больше нет', async () => {
  // В режиме базы она затёрла бы правила, заведённые на другом инстансе между
  // чтением и записью. Экспортирована была, но не вызывалась ниоткуда.
  const code = await readCode('automation/store.js')
  assert.ok(!/export async function replaceRules/.test(code), 'replaceRules не должна возвращаться')
})

test('счётчик переходов: уникальность ищется по индексу, а не чтением всего журнала', async () => {
  // Была главная тормозная точка: на каждый клик читался ВЕСЬ файл переходов, и с
  // ростом кликов чтение только росло. Индекс (code, fp) делает это одним запросом.
  const sql = await readSql('2026-08-27-link-tracker.sql')
  assert.ok(/create index if not exists link_hits_unique_idx on link_hits \(code, fp\)/.test(sql),
    'нужен индекс (code, fp) — по нему проверяется «был ли уже такой посетитель»')
  assert.ok(/code\s+text not null unique/.test(sql), 'код ссылки обязан быть уникальным: по нему находят редирект')
})

test('счётчик переходов: сырые адреса посетителей не хранятся', async () => {
  const sql = await readSql('2026-08-27-link-tracker.sql')
  const cols = columnsOf(sql, 'link_hits')
  assert.ok(cols.has('fp'), 'переход опознаётся отпечатком')
  assert.ok(!cols.has('ip') && !cols.has('user_agent'), 'ради счётчика адреса посетителей держать незачем')
  const code = await readCode('linkTracker.js')
  assert.ok(/createHash\('sha256'\)/.test(code), 'отпечаток обязан быть хешем')
})

test('массивы text[]: роли и модули переехали в таблицы связей', async () => {
  // Массив идентификаторов — это внешний ключ, который база не проверяет: роль удалили,
  // а её id остался лежать в profiles.role_ids. Плюс невозможность спросить «кому выдана
  // роль X» иначе, чем развернув массивы у всех профилей.
  const sql = await readSql('2026-09-02-mr290-arrays-to-links.sql')
  const flat = flatten(sql)
  for (const [table, col, parent] of [
    ['profile_roles', 'role_id', 'roles(id)'],
    ['user_roles', 'role_id', 'roles(id)'],
    ['wallet_log_modules', 'module_id', 'modules(id)'],
  ]) {
    assert.ok(flat.includes('create table if not exists ' + table), table + ': таблицы нет');
    assert.ok(flat.includes(col + ' text not null references ' + parent) || flat.includes(col + ' bigint not null references ' + parent),
      table + '.' + col + ': нужна ссылка на ' + parent)
    assert.ok(new RegExp('create table if not exists ' + table + '[^;]*position').test(flat),
      table + ': нужна колонка position — порядок в массиве был значащим')
  }
  // Кампании: таблица существовала как проекция, порядок в ней не хранился.
  assert.ok(flat.includes('alter table campaign_modules add column if not exists position'),
    'campaign_modules: порядок модулей должен храниться, а не восстанавливаться наугад')
})

test('состав подписки в журнале кошелька нельзя стереть удалением модуля', async () => {
  // Журнал — деньги: запись обязана объяснять, за что списали, и через год. Каскад стёр
  // бы состав подписки вместе с модулем, оставив сумму без основания. Отсюда restrict,
  // хотя у ролей рядом стоит cascade: это не разнобой, а разные требования.
  const flat = flatten(await readSql('2026-09-02-mr290-arrays-to-links.sql'))
  assert.ok(flat.includes('module_id bigint not null references modules(id) on delete restrict'),
    'состав подписки в журнале должен держать модуль, а не исчезать вместе с ним')
})

test('строка журнала кошелька и её состав пишутся одной транзакцией', async () => {
  // Через PostgREST это два запроса, и между ними процесс может умереть — в базе
  // останется списание без основания. Для денег половинчатая запись хуже отказа.
  const sql = await readSql('2026-09-02-mr290-arrays-to-links.sql')
  assert.match(sql, /create or replace function wallet_log_append/, 'нужна функция, а не два запроса из кода')
  const тело = sql.slice(sql.indexOf('create or replace function wallet_log_append'))
  assert.ok(тело.includes('insert into wallet_log (') && тело.includes('insert into wallet_log_modules'),
    'обе вставки обязаны быть внутри одной функции')
  assert.match(тело, /raise exception/, 'неизвестный модуль обязан отменять запись, а не пропускаться молча')

  const code = await readCode('balance.js')
  assert.ok(code.includes(String.raw`db.rpc('wallet_log_append'`), 'журнал должен писаться через функцию')
})

test('роли профиля читаются из связей, а порядок первой роли сохраняется', async () => {
  // roleId пользователя — это role_ids[0], «первичная» роль: ею подписаны карточки в
  // админке. Множество строк без position потеряло бы это различие молча.
  const code = await readCode('users.js')
  assert.ok(flatten(code).includes("roles: { table: 'profile_roles', column: 'role_id', ordered: true }"),
    'роли обязаны читаться из таблицы связей')
  assert.ok(code.includes(String.raw`order('position'`), 'порядок ролей должен приходить отсортированным из базы')
})

test('модули кампании — источник в таблице связей, а не проекция', async () => {
  // Таблица была проекцией: писали в массив, связи догонял syncModuleLinks следом.
  // Проекция расходится с источником при любой записи мимо неё — а мимо неё пишет весь
  // campaigns.js.
  const code = await readCode('campaigns.js')
  assert.ok(code.includes(String.raw`writeModuleLinks(db, 'campaign_modules'`), 'кампания обязана писать связи сама')
  assert.ok(code.includes(String.raw`readModuleLinks(db, 'campaign_modules'`), 'и читать их же')
})

test('карточка канала: каждое поле карты имеет колонку в схеме', async () => {
  // Мешок channels.data назывался «всё остальное», но остального там не было: 13 полей,
  // и каждое лежало у всех 85 каналов. Опечатка в имени колонки здесь — тихая потеря
  // данных: запись пройдёт, поле не сохранится, и узнаем мы об этом от людей.
  const code = await readCode('channels.js')
  const block = code.match(/const COLUMNS = \[([\s\S]*?)\n\]/)
  assert.ok(block, 'в channels.js нет карты COLUMNS')
  const columns = [...block[1].matchAll(/'[a-zA-Z]+',\s*'([a-z_]+)'/g)].map((m) => m[1])
  assert.ok(columns.length > 15, `карта подозрительно короткая: ${columns.length}`)

  const sql = await readSql(['2026-07-30-remaining-stores.sql', '2026-09-02-mr290-channels-columns.sql'])
  const known = new Set([
    ...columnsOf(sql, 'channels').keys(),
    ...[...sql.matchAll(/alter table channels add column if not exists ([a-z_]+)/gi)].map((m) => m[1]),
    'user_id', // приезжает owner-миграцией
  ])
  const missing = columns.filter((c) => !known.has(c))
  assert.deepEqual(missing, [], `в схеме нет колонок: ${missing.join(', ')}`)
})

test('источники канала: список строками, и в мешок он не дублируется', async () => {
  // По sources режется ДОСТУП: channelsForRequest показывает оператору только каналы,
  // которые нашли его задачи. Канал с пустым списком источников не виден никому —
  // значит два источника правды тут означали бы «канал то видно, то нет».
  const flat = flatten(await readSql('2026-09-02-mr290-channels-columns.sql'))
  assert.ok(flat.includes('create table if not exists channel_sources'), 'нет таблицы источников')
  assert.ok(flat.includes('channel_id text not null references channels(id) on delete cascade'),
    'источник обязан ссылаться на канал')

  const code = flatten(await readCode('channels.js'))
  assert.ok(code.includes("{ field: 'sources', table: 'channel_sources'"), 'источники должны читаться из таблицы')
  assert.ok(code.includes("key === 'sources' || key === 'categoriesExtra'"),
    'списки не должны попадать в мешок data даже временно — иначе два источника правды разойдутся')
})

test('источники канала намеренно без внешнего ключа на задачи', async () => {
  // Ключ напрашивается, но задачи переезжают в базу отдельным скриптом при выкате, и до
  // его прогона половина идентификаторов ни на что не сошлётся. Внешний ключ в этот
  // момент выбросил бы такие строки — и каналы исчезли бы из интерфейса у владельцев.
  // Тест держит это решение объяснённым: следующий, кто захочет «дочинить» схему,
  // увидит причину, а не догадку.
  const sql = await readSql('2026-09-02-mr290-channels-columns.sql')
  const блок = sql.slice(sql.indexOf('create table if not exists channel_sources'))
  assert.ok(!/task_id\s+text\s+not null\s+references/i.test(блок),
    'ключ на tasks добавляется отдельной миграцией — ПОСЛЕ переезда задач в базу')
  assert.match(sql, /Внешнего ключа на `tasks` здесь СОЗНАТЕЛЬНО НЕТ/,
    'решение обязано быть объяснено в самой миграции')
})

test('усталость: две формы восстановления сведены к одной колонке', async () => {
  // В боевых данных одна и та же величина записана двумя способами: у восьми аккаунтов
  // recoveryPerHour (единиц в час), у пяти recoveryEveryMs (за сколько уходит единица).
  // Приложение сводит их на чтении, но пока обе лежат рядом, отчёт мимо приложения
  // посчитает неправильно, а вторую форму однажды забудут обновить.
  const sql = await readSql('2026-09-02-mr290-json-bags.sql')
  assert.match(sql, /recovery_every_ms bigint/, 'нужна одна колонка на обе формы')
  assert.match(sql, /round\(3600000 \/ \(data #>> '\{profile,recoveryPerHour\}'\)::numeric\)/,
    'старая форма обязана пересчитываться в новую, а не теряться')

  const code = await readCode('accountActivity.js')
  assert.ok(code.includes('delete out.profile.recoveryPerHour'),
    'после чтения из колонки старая форма обязана исчезнуть — иначе две формы снова разойдутся')
})

test('распорядок дня: час и вероятность проверяет база, а не приложение', async () => {
  // В мешке ни час 25, ни вероятность 5 никто бы не отверг.
  const flat = flatten(await readSql('2026-09-02-mr290-json-bags.sql'))
  assert.ok(flat.includes('hour int not null check (hour between 0 and 23)'), 'час обязан быть ограничен')
  assert.ok(flat.includes('probability numeric not null check (probability >= 0 and probability <= 1)'),
    'вероятность обязана быть долей, а не любым числом')
  assert.ok(flat.includes('account_id text not null references accounts_meta(id) on delete cascade'),
    'распорядок удалённого аккаунта не должен оставаться висеть')
})

test('цены: каталоги стали таблицами с проверками, а не тремя json-ячейками', async () => {
  // Это ЦЕНЫ — то, по чему выставляют счета. Скидка 500%, пакет на минус сто монет и
  // правка цены у несуществующего модуля записались бы в json молча.
  const flat = flatten(await readSql('2026-09-02-mr290-json-bags.sql'))
  assert.ok(flat.includes('coins numeric not null check (coins > 0)'), 'пакет на ноль монет — не пакет')
  assert.ok(flat.includes("unit text not null check (unit in ('week', 'month', 'year'))"), 'единица периода из белого списка')
  assert.ok(flat.includes('discount numeric not null default 0 check (discount >= 0 and discount <= 0.9)'),
    'скидка обязана быть ограничена сверху')
  assert.ok(flat.includes('module_id bigint primary key references modules(id) on delete cascade'),
    'правка цены обязана ссылаться на существующий модуль')

  const code = await readCode('priceStore.js')
  assert.ok(code.includes("{ field: 'coinPacks', table: 'coin_packs'"), 'пакеты монет должны читаться из таблицы')
  assert.ok(code.includes("{ field: 'periods', table: 'subscription_periods'"), 'периоды должны читаться из таблицы')
})

test('цель: статус и режим периода ограничены базой', async () => {
  // Статус ограничен белым списком в коде, а в базе им мог оказаться любой текст.
  const flat = flatten(await readSql('2026-09-02-mr290-json-bags.sql'))
  assert.ok(flat.includes("check (status is null or status in ('active', 'paused', 'done', 'archived'))"),
    'статус цели обязан быть ограничен')
  assert.ok(flat.includes("check (period_mode is null or period_mode in ('all', 'from'))"),
    'режим периода обязан быть ограничен')

  const code = await readCode('goals.js')
  const block = code.match(/const COLUMNS = \[([\s\S]*?)\n\]/)
  assert.ok(block, 'в goals.js нет карты COLUMNS')
  const columns = [...block[1].matchAll(/\],\s*'([a-z_]+)'/g)].map((m) => m[1])
  const sql = await readSql('2026-09-02-mr290-json-bags.sql')
  const known = new Set([...sql.matchAll(/alter table goals add column if not exists ([a-z_]+)/gi)].map((m) => m[1]))
  const missing = columns.filter((c) => !known.has(c))
  assert.deepEqual(missing, [], `в схеме нет колонок цели: ${missing.join(', ')}`)
})
