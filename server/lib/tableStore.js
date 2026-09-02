/**
 * §10.2: помощники «список/словарь поверх таблицы».
 *
 * Оставшиеся сторы (группы аккаунтов, расписания, агенты, усталость) исторически
 * работают со ВСЕЙ коллекцией: прочитал → изменил → записал. Переписывать их логику
 * на точечные запросы значило бы трогать бизнес-правила ради формы хранения, поэтому
 * здесь адаптер с той же семантикой, но поверх БД.
 *
 * Коллекции маленькие (единицы-десятки записей), пишутся редко — цена «перезаписать
 * всё» здесь пренебрежима, а риск сломать логику при переписывании — нет.
 *
 * Без DATA_BACKEND=supabase (тесты, локальный запуск) всё работает по файлам, как раньше.
 *
 * ─── ЧТО ИЗМЕНИЛОСЬ В MR-290 ───
 *
 * 1. ОШИБКА БД БОЛЬШЕ НЕ УХОДИТ В ФАЙЛ МОЛЧА. Раньше любая ошибка — нарушение внешнего
 *    ключа, отказ в правах, разрыв соединения — приводила к чтению и записи локального
 *    файла, и приложение вело себя так, будто всё сохранилось. Данные при этом расходились
 *    с базой без единой жалобы, а узнавали об этом от людей. Теперь в файл уходит РОВНО
 *    один случай — «таблицы ещё нет» (миграция не доехала), потому что окно между выкатом
 *    кода и накаткой миграций реально существует. Всё остальное — исключение наверх.
 *
 *    Это осознанно менее «мягкое» поведение: страница упадёт с ошибкой вместо того, чтобы
 *    показать устаревшие данные. Тихое расхождение базы и файла дороже видимой ошибки —
 *    вторую чинят в тот же день, первую находят через неделю по чужим жалобам.
 *
 * 2. УДАЛЯЕМ ТОЛЬКО ТО, ЧТО ПРОПАЛО ИЗ НАШЕГО СНИМКА. Прежний writeAll спрашивал у базы
 *    все id и сносил всё, чего нет в его копии коллекции. На одном процессе это работало,
 *    на двух — два сервера удаляли записи друг друга: каждый считал свою копию полной.
 *    Теперь mutate передаёт снимок, прочитанный перед правкой, и в delete попадает только
 *    разница «было в снимке → нет в результате». Чужая запись, появившаяся параллельно,
 *    в снимок не входила и потому переживает запись.
 */
import { getSupabase, supabaseEnabled, isMissingTable } from './supabase.js'
import { readJson, writeJson } from './jsonStore.js'

function sb() { return supabaseEnabled() ? getSupabase() : null }
const val = (f) => (typeof f === 'function' ? f() : f)

/**
 * Ошибка БД: либо «таблицы нет» — тогда работаем по файлу, либо всё остальное — тогда
 * падаем. Разделение вынесено в одно место, чтобы список/словарь не разъехались.
 * @param {string} table @param {{message?:string, code?:string}} error @param {string} op
 */
function fileFallbackOrThrow(table, error, op) {
  if (isMissingTable(error)) {
    console.warn(`[${table}] таблицы ещё нет (${error.message}) — ${op} по файлу. Примените миграции: npm run migrate`)
    return
  }
  throw new Error(`[${table}] ${op} не удалось: ${error.message || error}`)
}

/**
 * Цепочки сериализации по таблице — как в `mutateJson` для файлов.
 *
 * Без этого read-modify-write параллельных воркеров затирал бы друг друга: два
 * одновременных обновления усталости прочитали бы одно и то же состояние и записали
 * бы каждый своё. Именно от этой болезни и защищался файловый вариант.
 *
 * Защита действует В ПРЕДЕЛАХ ПРОЦЕССА. Между процессами её нет — там от потери правок
 * спасает только то, что удаляем мы теперь по разнице со снимком (см. шапку файла).
 */
const _chains = new Map()
function serialize(table, fn) {
  const prev = _chains.get(table) || Promise.resolve()
  const run = prev.then(fn)
  // В цепочке держим версию, которая не реджектит: одна ошибка не должна
  // заблокировать все последующие операции над таблицей.
  _chains.set(table, run.catch(() => {}))
  return run
}

/**
 * Коллекция-СПИСОК поверх таблицы с текстовым `id`.
 *
 * `enrich` и `afterWrite` — точки для полей, которые живут не в самой строке, а в
 * таблице связи (состав группы аккаунтов, права суб-пользователя и т.п.). Появились в
 * MR-290, когда jsonb-массивы поехали в нормальные таблицы: без них пришлось бы или
 * писать связи ВНЕ сериализованной секции (гонка), или собирать состав отдельным
 * запросом на каждом вызове (N+1). `afterWrite` вызывается ПОСЛЕ записи самих строк —
 * иначе внешний ключ связи упёрся бы в ещё не созданного родителя.
 *
 * @param {{table:string, file:string|(()=>string), toRow:(o:any)=>any, fromRow:(r:any)=>any,
 *          order?:string, enrich?:(rows:any[], db:any)=>Promise<any[]>,
 *          afterWrite?:(rows:any[], db:any)=>Promise<void>}} cfg
 */
export function listStore(cfg) {
  /*
   * `sb` в настройках — шов для проверок: подставить клиент можно только так, модульный
   * читается из окружения. Тот же приём, что в `moduleIds`. По умолчанию — обычный.
   */
  const { table, file, toRow, fromRow, order = 'created_at', enrich, afterWrite, sb: клиент = sb } = cfg

  async function readAll() {
    const db = клиент()
    if (!db) return readJson(val(file), [])
    const { data, error } = await db.from(table).select('*').order(order, { ascending: false })
    if (error) {
      fileFallbackOrThrow(table, error, 'чтение')
      return readJson(val(file), [])
    }
    const rows = (data || []).map(fromRow)
    return enrich ? enrich(rows, db) : rows
  }

  /**
   * @param {any[]} all новое состояние коллекции
   * @param {{prevIds?: Set<string>}} [opts] снимок id ДО правки — из него берётся,
   *   что удалять. Без него удаляем по разнице с текущим содержимым таблицы (прежнее
   *   поведение): так ходят прямые вызовы writeAll, которые сами прочитали коллекцию.
   */
  async function writeAll(all, opts = {}) {
    const db = клиент()
    if (!db) return writeJson(val(file), all)
    const rows = (all || []).map(toRow)
    if (rows.length) {
      const { error } = await db.from(table).upsert(rows, { onConflict: 'id' })
      if (error) {
        fileFallbackOrThrow(table, error, 'запись')
        return writeJson(val(file), all)
      }
    }
    const keep = new Set(rows.map((r) => r.id))
    let candidates = opts.prevIds
    if (!candidates) {
      const { data: existing, error } = await db.from(table).select('id')
      if (error) {
        fileFallbackOrThrow(table, error, 'сверка удалённых')
        return writeJson(val(file), all)
      }
      candidates = new Set((existing || []).map((r) => r.id))
    }
    const gone = [...candidates].filter((id) => !keep.has(id))
    if (gone.length) {
      const { error } = await db.from(table).delete().in('id', gone)
      if (error) {
        fileFallbackOrThrow(table, error, 'удаление')
        return writeJson(val(file), all)
      }
    }
    return all
  }

  /** Прочитать → применить мутатор → записать. Сериализовано по таблице. */
  function mutate(fn) {
    return serialize(table, async () => {
      const all = await readAll()
      const prevIds = new Set((all || []).map((o) => toRow(o).id))
      const next = await fn(all)
      if (next === undefined) return all // мутатор отказался менять — не трогаем хранилище
      await writeAll(next, { prevIds })
      const db = клиент()
      if (afterWrite && db) await afterWrite(next, db)
      return next
    })
  }

  return { readAll, writeAll, mutate }
}

/**
 * Коллекция-СЛОВАРЬ (ключ → объект) поверх таблицы с колонкой-ключом.
 *
 * `afterRead` / `afterWrite` — для того, что не помещается в одну строку: связанные
 * таблицы. Зовутся ТОЛЬКО в режиме базы и только после успешной основной операции —
 * в файловом режиме связанных таблиц нет, а после неудачной записи дочерние строки
 * относились бы к тому, чего не сохранилось. Пара к тем же хукам у `listStore`.
 * @param {{table:string, file:string|(()=>string), keyCol:string,
 *   toRow:(k:string,o:any)=>any, fromRow:(r:any)=>[string,any],
 *   afterRead?:(all:any, db:any)=>Promise<void>, afterWrite?:(all:any, db:any)=>Promise<void>}} cfg
 */
export function mapStore(cfg) {
  const { table, file, keyCol, toRow, fromRow, afterRead, afterWrite, sb: клиент = sb } = cfg

  async function readAll() {
    const db = клиент()
    if (!db) return readJson(val(file), {})
    const { data, error } = await db.from(table).select('*')
    if (error) {
      fileFallbackOrThrow(table, error, 'чтение')
      return readJson(val(file), {})
    }
    const out = {}
    for (const r of data || []) {
      /*
       * Контракт проверяем явно.
       *
       * `mapStore` ждёт от `fromRow` ПАРУ [ключ, значение], а соседний `listStore` —
       * объект. Разница нигде не видна, и один стор действительно вернул объект: чтение
       * падало с «fromRow is not a function or its return value is not iterable». Где
       * ошибку ловили — молча приезжала пустая карта, где нет — падала задача, и оператор
       * видел в дашборде именно эту строку, по которой понять ничего нельзя.
       *
       * Сообщение должно называть стор и ожидаемую форму, а не деталь реализации
       * деструктуризации.
       */
      const пара = fromRow(r)
      if (!Array.isArray(пара) || пара.length !== 2) {
        throw new Error(`[${table}] fromRow обязана вернуть пару [ключ, значение] — mapStore строит карту, а не список. Если нужен список, это listStore.`)
      }
      out[пара[0]] = пара[1]
    }
    if (afterRead) await afterRead(out, db)
    return out
  }

  /** @param {Record<string, any>} all @param {{prevKeys?: Set<string>}} [opts] см. listStore.writeAll */
  async function writeAll(all, opts = {}) {
    const db = клиент()
    if (!db) return writeJson(val(file), all)
    const rows = Object.entries(all || {}).map(([k, v]) => toRow(k, v))
    if (rows.length) {
      const { error } = await db.from(table).upsert(rows, { onConflict: keyCol })
      if (error) {
        fileFallbackOrThrow(table, error, 'запись')
        return writeJson(val(file), all)
      }
    }
    const keep = new Set(rows.map((r) => r[keyCol]))
    let candidates = opts.prevKeys
    if (!candidates) {
      const { data: existing, error } = await db.from(table).select(keyCol)
      if (error) {
        fileFallbackOrThrow(table, error, 'сверка удалённых')
        return writeJson(val(file), all)
      }
      candidates = new Set((existing || []).map((r) => r[keyCol]))
    }
    const gone = [...candidates].filter((k) => !keep.has(k))
    if (gone.length) {
      const { error } = await db.from(table).delete().in(keyCol, gone)
      if (error) {
        fileFallbackOrThrow(table, error, 'удаление')
        return writeJson(val(file), all)
      }
    }
    if (afterWrite) await afterWrite(all, db)
    return all
  }

  function mutate(fn) {
    return serialize(table, async () => {
      const all = await readAll()
      const prevKeys = new Set(Object.keys(all || {}))
      const next = await fn(all)
      if (next === undefined) return all
      await writeAll(next, { prevKeys })
      return next
    })
  }

  return { readAll, writeAll, mutate }
}
