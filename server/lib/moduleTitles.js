/**
 * Человеческие названия модулей одним местом. Раньше карта жила внутри adminStats.js,
 * и второму потребителю (прайс) пришлось бы её копировать — а расхождение названий
 * между отчётом и витриной цен читается как разные вещи, хотя модуль один.
 *
 * Веб-конфиг `src/shared/config/modules.ts` тут не годится: в нём нет mailing и
 * autoposting (чужая дорожка), и в окне цен они показывались бы ключами.
 */
export const MODULE_TITLES = {
  mailing: 'Рассылка',
  autoposting: 'Автопостинг',
  'neuro-commenting': 'Нейрокомментинг',
  'neuro-chatting': 'Нейрочаттинг',
  'neuro-dialogs': 'НейроДиалоги',
  'mass-react': 'Массовые реакции',
  'mass-looking': 'Масслукинг',
  warming: 'Прогрев аккаунтов',
  parsing: 'Парсинг каналов',
  'parsing-groups': 'Парсер групп',
  'parsing-users': 'Парсер пользователей',
  'parsing-messages': 'Парсер сообщений',
  'parsing-comments': 'Парсер комментариев',
  ggr: 'AIR — AI Rating',
  'spam-unblock': 'Снятие спамблока',
}

/** @param {string} key */
export const moduleTitle = (key) => MODULE_TITLES[key] || key
