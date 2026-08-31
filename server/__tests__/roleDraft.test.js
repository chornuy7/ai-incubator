/**
 * MR-245: «Создать роль» открывает черновик, а не заводит пустую роль.
 *
 * Владелец 30.08: «Когда ты в новом пользователе нажимаешь „создать роль“, создаётся новая
 * роль. По-хорошему она должна не создаться, а закрыться эта херь и начаться создание
 * роли». Пустая «Новая роль 7» появлялась в базе сразу; если человек передумывал — она
 * оставалась там навсегда и предлагалась в выпадающих списках у пользователей.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const читать = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')
const roles = читать('src/pages/RolesPage.tsx')
const users = читать('src/pages/UsersPage.tsx')

test('кнопка «Новая роль» ничего не создаёт на сервере', () => {
  const addRole = roles.slice(roles.indexOf('function addRole()'), roles.indexOf('function cancelDraft()'))
  assert.doesNotMatch(addRole, /createRole/, 'роль по-прежнему создаётся сразу')
  assert.match(addRole, /setSelId\(DRAFT_ID\)/)
})

test('роль появляется только при сохранении черновика', () => {
  const save = roles.slice(roles.indexOf('async function save()'), roles.indexOf('// Просьба «создать роль»'))
  assert.match(save, /if \(isDraft\) \{/)
  assert.match(save, /const created = await createRole\(\{ name: name\.trim\(\)/)
  // И об этом узнаёт форма пользователя, из которой создание могли начать.
  assert.match(save, /notifyRoleCreated\(created\)/)
})

test('от черновика можно отказаться, ничего не оставив', () => {
  assert.match(roles, /function cancelDraft\(\)/)
  assert.match(roles, /\{isDraft && \(\s*\n\s*<button onClick=\{cancelDraft\}/)
  // Пока не сохранён — он не в списке, и об этом сказано словами.
  assert.match(roles, /Новая роль ещё не создана/)
})

test('из формы пользователя: форма закрывается, начинается создание роли', () => {
  // Раньше это была ссылка-якорь: страница прокручивалась ПОД открытой модалкой, и с
  // точки зрения человека нажатие не делало ничего.
  assert.match(users, /onCreateRole=\{\(\) => \{ setOpen\(false\); requestNewRole\(\) \}\}/)
  assert.doesNotMatch(users, /TEMPLATES_ANCHOR/, 'якорь остался — значит прокрутка под модалкой вернулась')
})

test('после создания роли форма возвращается с уже применённой ролью', () => {
  const эффект = users.slice(users.indexOf('useEffect(() => onRoleCreated('), users.indexOf('}), [catalog])'))
  assert.match(эффект, /setNewAccess\(accessFromRole\(role/)
  assert.match(эффект, /setAppliedTpl\(role\.name\)/)
  assert.match(эффект, /setOpen\(true\)/)
})

test('сигналы разведены: «начать создание» и «роль создана» — разные', () => {
  const api = читать('src/api/rolesApi.ts')
  for (const имя of ['requestNewRole', 'onNewRoleRequest', 'notifyRoleCreated', 'onRoleCreated']) {
    assert.match(api, new RegExp(`export function ${имя}`), `нет ${имя}`)
  }
})
