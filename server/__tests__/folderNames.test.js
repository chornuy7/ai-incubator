/**
 * MR-246: одинаковые названия групп запрещены, кнопок стало меньше.
 *
 * Владелец 30.08: «Зачем нам три кнопки, которые делают одно и то же? Давай сделаем
 * управление и загрузить одной кнопочкой. И у нас есть папки с одинаковым названием —
 * может, запретить?»
 *
 * Две группы «Крипта» в одном выпадающем списке различить нечем: человек грузит не ту и
 * узнаёт об этом по чужим каналам в уже запущенной задаче.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const файл = path.join(os.tmpdir(), `mr246-folders-${process.pid}.json`)
process.env.TARGET_FOLDERS_FILE = файл
process.env.DATA_DIR = os.tmpdir()

const { createFolder, updateFolder, listFolders } = await import('../targetFolders.js')

test.after(() => { try { fs.unlinkSync(файл) } catch { /* нечего убирать */ } })

test('вторая группа с тем же названием не создаётся', async () => {
  await createFolder('Крипта', ['@a'], 'owner_1')
  await assert.rejects(() => createFolder('Крипта', ['@b'], 'owner_1'), /уже есть/)
})

test('регистр и лишние пробелы — то же самое имя', async () => {
  // «Крипта» и «крипта » человек читает как одно имя, значит и путаница та же.
  await assert.rejects(() => createFolder('  крипта ', ['@c'], 'owner_1'), /уже есть/)
})

test('у другого владельца такое же имя разрешено', async () => {
  // У каждого клиента может быть своя «Крипта» — это не путаница, это разные пространства.
  const чужая = await createFolder('Крипта', ['@d'], 'owner_2')
  assert.equal(чужая.name, 'Крипта')
})

test('переименование в занятое имя тоже отклоняется', async () => {
  const f = await createFolder('Новости', ['@e'], 'owner_1')
  await assert.rejects(() => updateFolder(f.id, { name: 'Крипта' }, 'owner_1'), /уже есть/)
  // Своё же имя не считается занятым — иначе нельзя было бы поправить регистр.
  const ok = await updateFolder(f.id, { name: 'новости' }, 'owner_1')
  assert.equal(ok.name, 'новости')
})

test('дозапись целей именем не занимается', async () => {
  const все = await listFolders()
  const f = все.find((x) => x.userId === 'owner_1')
  const upd = await updateFolder(f.id, { targets: ['@x', '@y'] }, 'owner_1')
  assert.equal(upd.targets.length, 2)
})

test('в интерфейсе одна кнопка выбора вместо «Загрузить» и «Управление»', () => {
  const ui = fs.readFileSync(new URL('../../src/features/modules/shared/FolderPicker.tsx', import.meta.url), 'utf8')
  assert.match(ui, /Выбрать группу/)
  assert.doesNotMatch(ui, /Загрузить группу/, 'вторая кнопка вернулась')
  assert.doesNotMatch(ui, /FolderLoadModal/, 'вернулось второе окно с тем же списком')
  // «Сохранить в группу» осталось отдельно: это другое действие — оно пишет, а не читает.
  assert.match(ui, /Сохранить в группу/)
  // Управление внутри окна показывается только тому, кому оно разрешено.
  assert.match(ui, /\{canManage && <>/)
})

/*
 * MR-246 (правка заказчика 01.09): «було фул редагування папки з групами в управлінні,
 * тепер немає». Проверка исходная не покрывала состав вовсе — управление сводилось к имени,
 * и потеря не всплывала.
 */
test('состав группы правится в том же окне: убрать цель, добавить, сохранить', () => {
  const стр = fs.readFileSync(new URL('../../src/features/modules/shared/FolderPicker.tsx', import.meta.url), 'utf8')
  assert.ok(/Состав группы: добавить или убрать цели/.test(стр), 'нужна кнопка входа в состав группы')
  assert.ok(/setDraft\(draft\.filter\(\(x\) => x !== t\)\)/.test(стр), 'каждую цель можно убрать по отдельности')
  assert.ok(/const addTargets/.test(стр), 'цели можно добавлять, не выходя из окна')
  assert.ok(/updateFolder\(f\.id, \{ targets: draft \}\)/.test(стр), 'состав уходит на сервер целиком одним сохранением')
})

test('состав сохраняется черновиком, а не по каждому крестику', () => {
  /*
   * Список отправляется целиком: правка «на лету» превратила бы каждый крестик в отдельную
   * запись на сервер, и сеть, отвалившаяся посреди чистки, оставила бы половину группы.
   */
  const стр = fs.readFileSync(new URL('../../src/features/modules/shared/FolderPicker.tsx', import.meta.url), 'utf8')
  const at = стр.indexOf('const saveTargets')
  assert.ok(at > 0, 'сохранение состава не найдено')
  assert.ok(/disabled=\{savingId === f\.id \|\| !draft\.length \|\| !изменён\}/.test(стр),
    'пустой и нетронутый состав сохранять нечего — кнопка должна гаснуть')
})

test('состав правит только тот, кому разрешено управление', async () => {
  // Иначе сотрудник без прав на управление вычистил бы чужую группу целиком.
  const стр = fs.readFileSync(new URL('../../src/features/modules/shared/FolderPicker.tsx', import.meta.url), 'utf8')
  assert.ok(/\{canEdit && открыт && \(/.test(стр), 'редактор состава открывается тем же правом, что и кнопка')
  assert.ok(/openEditor\(f\)/.test(стр) && стр.indexOf('openEditor(f)') > стр.indexOf('{canEdit && <>'),
    'кнопка состава стоит внутри блока правки')
})

test('права кнопок в окне совпадают с тем, что разрешает сервер', () => {
  /*
   * Правка заказчика 01.09: «було фул редагування папки з групами в управлінні, тепер немає».
   * В MR-246 я закрыл под админа ВЕСЬ блок кнопок разом. Но сервер (featureRoutes.js) режет
   * по-разному: переименование и удаление — только админу, а проверку на мёртвые и правку
   * целей — всем, кому группа видна. Заодно снова про то же: кнопка, которой сервер ответит
   * 403, хуже отсутствующей — человек жмёт и получает отказ вместо действия.
   */
  const стр = fs.readFileSync(new URL('../../src/features/modules/shared/FolderPicker.tsx', import.meta.url), 'utf8')
  const мод = fs.readFileSync(new URL('../featureRoutes.js', import.meta.url), 'utf8')

  const put = мод.slice(мод.indexOf("featureRouter.put('/target-folders/:id'"), мод.indexOf("featureRouter.delete('/target-folders/:id'"))
  assert.ok(/typeof patch\.name === 'string' && !\(await isAdminRequest\(req\)\)/.test(put),
    'сервер: переименование только админу — если это изменилось, права в окне надо пересобрать')
  assert.ok(!/isAdminRequest/.test(put.slice(put.indexOf('patch.targets !== undefined'))),
    'сервер: правка целей админа не требует')

  const где = (кнопка) => {
    const at = стр.indexOf(кнопка)
    assert.ok(at > 0, `не нашёл кнопку ${кнопка}`)
    const edit = стр.lastIndexOf('{canEdit && <>', at)
    const manage = стр.lastIndexOf('{canManage && <>', at)
    return edit > manage ? 'canEdit' : 'canManage'
  }
  assert.equal(где('title="Состав группы: добавить или убрать цели"'), 'canEdit', 'состав правит любой, кому группа видна')
  assert.equal(где('title="Проверить и удалить мёртвые"'), 'canEdit', 'проверку сервер админом не ограничивает')
  assert.equal(где('title="Переименовать"'), 'canManage', 'переименование — только админ')
  assert.equal(где('title="Удалить"'), 'canManage', 'удаление — только админ')

  const строка = стр.split(/\r?\n/).find((l) => /const canManage =/.test(l))
  assert.ok(/user\.isAdmin/.test(строка), 'управление сверяется с ролью администратора, как на сервере')
})
