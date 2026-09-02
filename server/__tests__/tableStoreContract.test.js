/**
 * Контракт `mapStore` и `listStore`: чем они отличаются и почему на этом уже обожглись.
 *
 * Два соседних фабричных стора выглядят одинаково, но ждут от `fromRow` РАЗНОГО:
 * `listStore` — объект (он строит список), `mapStore` — пару [ключ, значение] (он строит
 * карту). В коде эта разница ничем не отмечена.
 *
 * `accountActivity` — единственный пользователь `mapStore` — возвращал объект. Чтение
 * падало на первой же строке с сообщением «fromRow is not a function or its return value
 * is not iterable». Где ошибку ловили (`.catch(() => ({}))`), приезжала пустая карта, и
 * усталость у всех аккаунтов выглядела пустой; где не ловили — падала задача, и оператор
 * видел эту строку в дашборде, не понимая ни при чём тут он.
 *
 * Проверяем два свойства: правильная форма работает, неправильная даёт сообщение, по
 * которому видно, что делать.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mapStore, listStore } from '../lib/tableStore.js'

/** Клиент, отдающий заданные строки. Достаточно для `readAll`. */
function fakeDb(rows) {
  return {
    from() {
      const q = {
        select() { return q },
        order() { return Promise.resolve({ data: rows, error: null }) },
        then(res) { return res({ data: rows, error: null }) },
      }
      return q
    },
  }
}

test('mapStore: пара [ключ, значение] раскладывается в карту', async () => {
  const store = mapStore({
    table: 'проба',
    file: () => 'нет-файла.json',
    keyCol: 'id',
    toRow: (k, v) => ({ id: k, ...v }),
    fromRow: (r) => [r.id, { имя: r.name }],
    sb: () => fakeDb([{ id: 'a', name: 'Аня' }, { id: 'b', name: 'Боря' }]),
  })
  assert.deepEqual(await store.readAll(), { a: { имя: 'Аня' }, b: { имя: 'Боря' } })
})

test('mapStore: объект вместо пары — понятная ошибка, а не «is not iterable»', async () => {
  /*
   * Ровно та ошибка, что стоила двух упавших задач. Сообщение обязано называть стор и
   * ожидаемую форму: по «fromRow is not a function or its return value is not iterable»
   * ни оператор, ни разработчик не поймут, что перепутаны два похожих стора.
   */
  const store = mapStore({
    table: 'проба',
    file: () => 'нет-файла.json',
    keyCol: 'id',
    toRow: (k, v) => ({ id: k, ...v }),
    fromRow: (r) => ({ имя: r.name }), // ← как было в accountActivity
    sb: () => fakeDb([{ id: 'a', name: 'Аня' }]),
  })
  await assert.rejects(() => store.readAll(), (e) => {
    assert.match(e.message, /проба/, 'в сообщении должно быть имя таблицы')
    assert.match(e.message, /пару \[ключ, значение\]/, 'должно быть сказано, какая форма ожидается')
    assert.match(e.message, /listStore/, 'должно быть сказано, чем пользоваться, если нужен список')
    return true
  })
})

test('listStore ждёт объект — и это ДРУГОЙ контракт', async () => {
  // Держим оба рядом в одном файле именно потому, что путают их друг с другом.
  const store = listStore({
    table: 'проба',
    file: () => 'нет-файла.json',
    toRow: (x) => ({ id: x.id, name: x.имя }),
    fromRow: (r) => ({ id: r.id, имя: r.name }),
    sb: () => fakeDb([{ id: 'a', name: 'Аня' }]),
  })
  assert.deepEqual(await store.readAll(), [{ id: 'a', имя: 'Аня' }])
})
