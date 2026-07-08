import type { ParseResult } from '@/shared/types'
import { pick } from '@/shared/lib/utils'

const CH_NAMES = ['Crypto Daily', 'SMM Лаборатория', 'NFT Mint News', 'Трейдинг Про', 'Airdrop Hunter', 'DeFi Инсайды', 'P2P Обмен', 'Web3 Дайджест', 'Маркетинг 360', 'Growth Hacks']
const GR_NAMES = ['SMM Чат', 'Крипто Трейдеры', 'NFT Коллекторы', 'Стартап Тусовка', 'Арбитраж Трафика', 'Таргет Мастер', 'P2P Флудилка', 'DeFi Обсуждения', 'Продвижение TG', 'Комьюнити Билдинг']
const USER_FIRST = ['Alex', 'Marta', 'Denis', 'Olena', 'Ivan', 'Sofia', 'Roman', 'Yulia', 'Nikita', 'Karina']
const LANGS = ['ru', 'ua', 'en']

/** Детерминированные мок-строки результата парсинга. */
export function makeResults(kind: 'channel' | 'group' | 'user', count: number): ParseResult[] {
  return Array.from({ length: count }, (_, i) => {
    if (kind === 'user') {
      const first = pick(USER_FIRST, i + 1)
      return {
        id: `u${i}`,
        title: `${first} ${String.fromCharCode(65 + (i % 26))}.`,
        username: `${first.toLowerCase()}_${100 + i}`,
        members: 0,
        kind: 'user',
        premium: i % 3 === 0,
        lang: pick(LANGS, i + 3),
      }
    }
    const names = kind === 'channel' ? CH_NAMES : GR_NAMES
    return {
      id: `${kind}${i}`,
      title: pick(names, i),
      username: (kind === 'channel' ? 'ch_' : 'grp_') + (1000 + i),
      members: 800 + Math.floor(pick([1, 2, 3, 5, 8, 13, 21], i) * 4200),
      kind: kind === 'channel' ? 'channel' : 'group',
      verified: i % 7 === 0,
      lang: pick(LANGS, i),
    }
  })
}
