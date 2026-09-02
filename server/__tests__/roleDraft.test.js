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

test('«создайте роль» РАСКРЫВАЕТ раздел ролей, а не только листает к нему', () => {
  /*
   * Баг приёмки 01.09: «создайте роль почему не нажимается кнопка».
   *
   * Нажималась. Форма закрывалась, роль заводилась, страница даже прокручивалась — но
   * раздел ролей внутри страницы людей свёрнут по умолчанию (решение 21.08), а редактор
   * живёт под этой шторкой. Человек видел ровно то же, что до нажатия, и делал
   * единственно возможный вывод: кнопка мёртвая.
   */
  const roles = читать('src/pages/RolesPage.tsx')
  const эффект = roles.slice(roles.indexOf('onNewRoleRequest(() => {'), roles.indexOf('// ── сеттеры прав'))
  assert.match(эффект, /setOpenSection\(true\)/, 'раздел остаётся свёрнутым — нажатие снова будет выглядеть пустым')
  assert.match(эффект, /addRole\(\)/)
  assert.match(эффект, /scrollIntoView/)
  // Два кадра: сначала React дорисует раскрытый раздел, и только потом у него появится место.
  assert.match(эффект, /requestAnimationFrame\(\(\) => requestAnimationFrame\(/)
  // Состояние объявлено ДО эффекта — иначе это чтение переменной до её создания.
  assert.ok(roles.indexOf('const [openSection') < roles.indexOf('onNewRoleRequest(() => {'),
    'openSection объявлен ниже своего использования')
})

test('с НУЛЯ ролей редактор черновика виден — иначе первую роль не завести вовсе', () => {
  /*
   * Приёмка 02.09: «создайте роль должна сразу создаваться роль, а не просто открывать
   * создание роли». На деле не открывалось и оно: условие показа смотрело только на длину
   * списка — `roles.length === 0` рисовало заглушку «Ролей пока нет», и черновик,
   * заведённый addRole(), прятался ПОД ней.
   *
   * Следствие шире исходного бага: пока у владельца нет ни одной роли, завести первую было
   * нельзя ни из формы пользователя, ни со страницы ролей — обе кнопки зовут addRole() и
   * обе давали один и тот же невидимый результат.
   */
  const roles = читать('src/pages/RolesPage.tsx')
  assert.match(roles, /roles\.length === 0 && !isDraft \? \(/,
    'заглушка обязана уступать место редактору, когда открыт черновик')
  // И заглушка по-прежнему на месте для честно пустого состояния — без черновика.
  assert.match(roles, /title=\{'Ролей пока нет'\}/)
})
