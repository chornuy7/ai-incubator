/**
 * Папки целей — списки каналов, которые клиент собрался обрабатывать.
 *
 * С 27.08 (MR-186) хранятся в ОБЩЕЙ БАЗЕ (`target_folders` + `target_folder_targets`).
 * До этого стор писал в data/target-folders.json, ветки Supabase не было, а env для пути
 * не было вовсе — то есть даже тесты писали туда же, куда боевой сервер. В папках лежит
 * наработка клиента: пропал диск — восстановить её неоткуда.
 *
 * Файловый режим оставлен для локального запуска и тестов.
 */
import crypto from 'crypto'
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'
import { getSupabase, supabaseEnabled } from './lib/supabase.js'

/** Путь ленивый и с env — раньше его не было, и тесты писали в боевой файл. */
const foldersFile = () => process.env.TARGET_FOLDERS_FILE || dataPath('target-folders.json')
function sb() { return supabaseEnabled() ? getSupabase() : null }

/** Таблиц ещё нет (миграция не накатана) — отдаём пустой список, а не роняем страницу. */
const isMissingTable = (error) =>
  !!error && /target_folders|target_folder_targets|schema cache|does not exist|relation .* does not exist/i.test(String(error.message || ''))

function newId() {
  return `fld_${crypto.randomUUID().slice(0, 8)}`
}

/**
 * Цели папки: без `@`, без пробелов, без дублей — и в НИЖНЕМ регистре.
 *
 * Регистр критичен: юзернеймы Telegram регистронезависимы, `@nuancesprog` и
 * `@NUANCESPROG` — один канал. Без `toLowerCase()` они ложились в папку двумя
 * записями, и кампания отрабатывала по такому каналу ДВАЖДЫ одним аккаунтом —
 * повторные действия в один чат читаются как сигнатура бота (прогон 21–22.07,
 * тест 11.7: отправили 15 строк, сохранилось 13 вместо 12).
 *
 * С переездом в базу это же правило закреплено первичным ключом (папка, канал):
 * даже если сюда что-то просочится мимо, дубль не запишется.
 * @param {*} targets
 */
export function normalizeTargets(targets) {
  const arr = Array.isArray(targets) ? targets : []
  const clean = arr
    .map((t) => String(t || '').trim().replace(/^@/, '').toLowerCase())
    .filter(Boolean)
  return [...new Set(clean)]
}

/** Миграция регистра выполняется один раз за процесс — чтобы не писать файл на каждом чтении. */
let migrated = false

const rowToFolder = (r, targets = []) => ({
  id: r.id,
  name: r.name,
  targets,
  ...(r.user_id ? { userId: r.user_id } : {}),
  createdAt: Number(r.created_at) || 0,
  updatedAt: Number(r.updated_at) || 0,
})

/** Записать цели папки: сначала убрать прежние, потом положить новые в их порядке. */
async function saveTargets(db, folderId, targets) {
  const { error: delErr } = await db.from('target_folder_targets').delete().eq('folder_id', folderId)
  if (delErr && !isMissingTable(delErr)) throw new Error(`Не удалось обновить цели папки: ${delErr.message}`)
  if (!targets.length) return
  const rows = targets.map((username, position) => ({ folder_id: folderId, username, position }))
  const { error } = await db.from('target_folder_targets').insert(rows)
  if (error && !isMissingTable(error)) throw new Error(`Не удалось сохранить цели папки: ${error.message}`)
}

/** @returns {Promise<Array<{id:string,name:string,targets:string[],createdAt:number,updatedAt:number}>>} */
export async function listFolders() {
  const db = sb()
  if (db) {
    const { data, error } = await db.from('target_folders').select('*').order('created_at', { ascending: false })
    if (error) {
      if (isMissingTable(error)) return []
      throw new Error(`Не удалось прочитать папки: ${error.message}`)
    }
    const rows = data || []
    if (!rows.length) return []
    // Цели дочитываем ОДНИМ запросом на все папки, а не запросом на папку: список папок
    // открывается на каждом заходе в раздел, и цикл запросов растянул бы его.
    const { data: tRows, error: tErr } = await db
      .from('target_folder_targets')
      .select('*')
      .in('folder_id', rows.map((r) => r.id))
      .order('position', { ascending: true })
    if (tErr && !isMissingTable(tErr)) throw new Error(`Не удалось прочитать цели папок: ${tErr.message}`)
    const byFolder = new Map()
    for (const t of tRows || []) {
      if (!byFolder.has(t.folder_id)) byFolder.set(t.folder_id, [])
      byFolder.get(t.folder_id).push(t.username)
    }
    return rows.map((r) => rowToFolder(r, byFolder.get(r.id) || []))
  }

  const data = await readJson(foldersFile(), { folders: [] })
  const folders = Array.isArray(data?.folders) ? data.folders : []
  // Папки, сохранённые до фикса регистра, содержат дубли вида nuancesprog + NUANCESPROG.
  // Сами они не исчезнут, поэтому схлопываем их при первом чтении и сохраняем результат.
  const fixed = folders.map((f) => ({ ...f, targets: normalizeTargets(f.targets) }))
  const changed = fixed.some((f, i) => f.targets.length !== (folders[i].targets?.length ?? 0))
  if (changed && !migrated) {
    migrated = true
    await saveFolders(fixed).catch(() => {})
  }
  return fixed
}

async function saveFolders(folders) {
  await writeJson(foldersFile(), { folders, updatedAt: Date.now() })
}

/**
 * Владелец папки (`userId`).
 *
 * До 21.08 у папки владельца не было вообще, а `GET /api/target-folders` резал список
 * только ролью — и обычная роль клиента раздела `folders` не содержит, то есть не режет
 * ничего. На практике это значило, что база каналов (кого именно клиент собрался
 * обрабатывать — его ниша и его наработка) уходила любому другому клиенту платформы.
 *
 * Папки, заведённые ДО этого поля, остаются без владельца: угадать задним числом, чьи
 * они, нельзя. По общему правилу (`ownedForRequest`) их видит только админ.
 *
 * @param {string} name @param {string[]} targets @param {string} [userId] владелец пространства
 */
/**
 * MR-246: название группы уникально в пределах ВЛАДЕЛЬЦА.
 *
 * Владелец 30.08: «у нас есть папки с одинаковым названием — может, запретить?» Две группы
 * «Крипта» в одном выпадающем списке различить нечем: человек грузит не ту и узнаёт об этом
 * по чужим каналам в задаче. Сравниваем без регистра и лишних пробелов — «Крипта» и
 * «крипта » для человека одно и то же имя, а значит и путаница та же.
 *
 * Чужие группы в счёт не идут: у разных клиентов «Крипта» может быть у каждого своя.
 */
const ключИмени = (n) => String(n || '').trim().toLowerCase().replace(/\s+/g, ' ')

async function имяЗанято(name, userId, exceptId) {
  const key = ключИмени(name)
  if (!key) return false
  const мои = (await listFolders()).filter((f) => (f.userId || '') === (String(userId || '').trim() || ''))
  return мои.some((f) => f.id !== exceptId && ключИмени(f.name) === key)
}

export async function createFolder(name, targets, userId) {
  if (await имяЗанято(name, userId)) {
    throw new Error(`Группа «${String(name).trim()}» уже есть — выберите другое название`)
  }
  const folder = {
    id: newId(),
    name: String(name || '').trim() || 'Без названия',
    targets: normalizeTargets(targets),
    userId: String(userId || '').trim() || undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  const db = sb()
  if (db) {
    const { error } = await db.from('target_folders').insert({
      id: folder.id,
      user_id: folder.userId || null,
      name: folder.name,
      created_at: folder.createdAt,
      updated_at: folder.updatedAt,
    })
    if (error) {
      if (isMissingTable(error)) throw new Error('Папки временно недоступны: не применена миграция базы')
      throw new Error(`Не удалось создать папку: ${error.message}`)
    }
    await saveTargets(db, folder.id, folder.targets)
    return folder
  }
  const folders = await listFolders()
  folders.unshift(folder)
  // Потолок в 200 нужен только файлу: он переписывается целиком. В базе папки сверх
  // потолка не выбрасываются — раньше самые старые молча удалялись при добавлении новой.
  await saveFolders(folders.slice(0, 200))
  return folder
}

/**
 * @param {string} id @param {{ name?: string, targets?: string[] }} patch
 * @param {string} [userId] владелец — нужен, чтобы проверить имя на повтор (MR-246)
 */
export async function updateFolder(id, patch, userId) {
  if (typeof patch?.name === 'string' && patch.name.trim() && await имяЗанято(patch.name, userId, id)) {
    throw new Error(`Группа «${patch.name.trim()}» уже есть — выберите другое название`)
  }
  const db = sb()
  if (db) {
    const { data, error } = await db.from('target_folders').select('*').eq('id', id).limit(1)
    if (error && !isMissingTable(error)) throw new Error(`Не удалось прочитать папку: ${error.message}`)
    if (!data?.length) return null
    const now = Date.now()
    const name = typeof patch?.name === 'string' && patch.name.trim() ? patch.name.trim() : data[0].name
    const { error: updErr } = await db.from('target_folders').update({ name, updated_at: now }).eq('id', id)
    if (updErr && !isMissingTable(updErr)) throw new Error(`Не удалось изменить папку: ${updErr.message}`)

    let targets
    if (patch?.targets !== undefined) {
      targets = normalizeTargets(patch.targets)
      await saveTargets(db, id, targets)
    } else {
      const { data: tRows } = await db.from('target_folder_targets').select('username').eq('folder_id', id).order('position', { ascending: true })
      targets = (tRows || []).map((t) => t.username)
    }
    return rowToFolder({ ...data[0], name, updated_at: now }, targets)
  }

  const folders = await listFolders()
  const idx = folders.findIndex((f) => f.id === id)
  if (idx === -1) return null
  const cur = folders[idx]
  folders[idx] = {
    ...cur,
    ...(typeof patch?.name === 'string' && patch.name.trim() ? { name: patch.name.trim() } : {}),
    ...(patch?.targets !== undefined ? { targets: normalizeTargets(patch.targets) } : {}),
    updatedAt: Date.now(),
  }
  await saveFolders(folders)
  return folders[idx]
}

/** @param {string} id */
export async function deleteFolder(id) {
  const db = sb()
  if (db) {
    // Цели уходят сами: внешний ключ объявлен с `on delete cascade`.
    const { data, error } = await db.from('target_folders').delete().eq('id', id).select('id')
    if (error) {
      if (isMissingTable(error)) return false
      throw new Error(`Не удалось удалить папку: ${error.message}`)
    }
    return (data || []).length > 0
  }
  const folders = await listFolders()
  const next = folders.filter((f) => f.id !== id)
  if (next.length === folders.length) return false
  await saveFolders(next)
  return true
}
