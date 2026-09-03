/**
 * §8 (MR-44): тикеты поддержки. Проверяем создание/список/переписку/статусы и то,
 * что клиент видит только свои, а поддержка — все.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import path from 'path'

process.env.TICKETS_FILE = path.join(os.tmpdir(), `tickets-${process.pid}-${Math.random().toString(36).slice(2)}.json`)

const { createTicket, listTickets, getTicket, addMessage, setStatus } = await import('../tickets.js')

test('создание: тема обязательна', async () => {
  await assert.rejects(() => createTicket({ userId: 'u1', subject: '  ' }))
})

test('создание с телом → тикет open + первое сообщение от клиента', async () => {
  const t = await createTicket({ userId: 'u1', subject: 'Не логинится', category: 'tech', body: 'Помогите' })
  assert.equal(t.status, 'open')
  assert.equal(t.userId, 'u1')
  assert.equal(t.messages.length, 1)
  assert.equal(t.messages[0].from, 'user')
  assert.equal(t.messages[0].text, 'Помогите')
})

test('список: клиент видит только свои, поддержка — все', async () => {
  await createTicket({ userId: 'u2', subject: 'Оплата' })
  const mine = await listTickets({ userId: 'u1' })
  const all = await listTickets({ all: true })
  assert.ok(mine.every((t) => t.userId === 'u1'))
  assert.ok(all.length >= 2)
  assert.ok(all.some((t) => t.userId === 'u2'))
})

test('ответ поддержки переводит open → progress', async () => {
  const t = await createTicket({ userId: 'u3', subject: 'Вопрос', body: 'Как?' })
  const upd = await addMessage(t.id, { from: 'support', authorId: 'admin', text: 'Вот так' })
  assert.equal(upd.status, 'progress')
  assert.equal(upd.messages.length, 2)
  assert.equal(upd.messages[1].from, 'support')
})

test('ответ клиента по закрытому тикету снова открывает его', async () => {
  const t = await createTicket({ userId: 'u4', subject: 'Тема', body: 'x' })
  await setStatus(t.id, 'closed')
  const upd = await addMessage(t.id, { from: 'user', authorId: 'u4', text: 'ещё вопрос' })
  assert.equal(upd.status, 'open')
})

test('setStatus проверяет допустимость', async () => {
  const t = await createTicket({ userId: 'u5', subject: 'S' })
  await assert.rejects(() => setStatus(t.id, 'нечто'))
  const upd = await setStatus(t.id, 'escalated')
  assert.equal(upd.status, 'escalated')
})

test('getTicket по несуществующему id → null', async () => {
  assert.equal(await getTicket('TK-000000'), null)
})

test('пустой ответ отклоняется', async () => {
  const t = await createTicket({ userId: 'u6', subject: 'S' })
  await assert.rejects(() => addMessage(t.id, { from: 'user', text: '   ' }))
})
