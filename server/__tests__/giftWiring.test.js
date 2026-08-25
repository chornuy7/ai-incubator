/**
 * MR-189: подарок должен ДОЙТИ до кошелька, а не только правильно посчитаться.
 *
 * Живой прогон 25.08 показал, чего не увидел ни один юнит-тест: `userGifts.js` считал
 * подарок верно и был зелёным, а на реальной покупке подарок не начислялся ни разу.
 * Причина — в обработчике подписки: `changeCoins` объявлялся ВНУТРИ блока
 * `if (creditedTokens > 0)`, а блок подарка вызывал его снаружи, за пределами области
 * видимости. Падало ReferenceError прямо в пустой `catch {}` — ни начисления, ни строчки
 * в логах.
 *
 * Тест текстовый намеренно: логика живёт внутри express-обработчика, отдельно её не
 * вызвать, а сторожить нужно именно проводку — порядок объявления и непустой catch.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const source = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8')

/**
 * Кусок обработчика: от начисления за докупленные модули до отметки дня оплаты.
 * Комментарии срезаем — в них же и описан этот баг, а искать надо КОД, а не рассказ о нём.
 */
function creditBlock() {
  const from = source.indexOf('if (addedModules.length) {')
  assert.ok(from > 0, 'блок начисления за докупленные модули найден — иначе тест сторожит пустоту')
  const to = source.indexOf('const { markCredited, creditMonth }', from)
  assert.ok(to > from, 'конец блока найден')
  return source.slice(from, to).replace(/^\s*\/\/.*$/gm, '')
}

test('changeCoins объявлен ДО обоих начислений — иначе подарок падает в ReferenceError', () => {
  const block = creditBlock()
  const declared = block.indexOf("const { changeCoins } = await import('./balance.js')")
  const monthly = block.indexOf('if (creditedTokens > 0)')
  const gift = block.indexOf('pendingGift(')
  assert.ok(declared > -1, 'changeCoins импортируется в блоке начислений')
  assert.ok(declared < monthly, 'объявление раньше месячных токенов')
  assert.ok(declared < gift, 'объявление раньше подарка — иначе подарок не увидит функцию')
})

test('внутри `if (creditedTokens > 0)` своего changeCoins нет — он бы снова сузил область', () => {
  const block = creditBlock()
  const at = block.indexOf('if (creditedTokens > 0)')
  const inner = block.slice(at, block.indexOf('pendingGift('))
  assert.ok(
    !inner.includes("const { changeCoins }"),
    'повторное объявление внутри if вернёт ровно тот баг: подарок останется без функции',
  )
})

test('catch у подарка не пустой — молчаливый сбой прячет невыданные токены', () => {
  const block = creditBlock()
  assert.ok(!/\}\s*catch\s*\{\s*\/\*[^*]*\*\/\s*\}/.test(block.slice(block.indexOf('pendingGift('))),
    'пустой catch у подарка запрещён')
  assert.ok(block.includes('[gift]'), 'сбой начисления подарка обязан попадать в лог')
})

test('подарок отмечается выданным ТОЛЬКО после успешного начисления', () => {
  const block = creditBlock()
  const credit = block.indexOf('changeCoins(gift.coins')
  const mark = block.indexOf('markGifted(')
  assert.ok(credit > -1 && mark > credit, 'сначала начисляем, потом помечаем — иначе сбой начисления навсегда съест подарок')
})
