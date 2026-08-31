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
