-- MR-290, шаг 19: суточные счётчики и кэш доверия начинают работать.
--
-- Обе таблицы существуют, обе пусты, и это не совпадение: `server/lib/dailyActions.js` и
-- `server/lib/trustCache.js` НИКОГДА в них не заглядывали — оба читают и пишут файл.
-- Таблицы завели руками через SQL Editor (см. 2026-09-01-mr290-drift.sql), а код к ним
-- так и не подключили.
--
-- Это не «неиспользованная таблица», а две работающие мимо базы вещи:
--
--   • СУТОЧНЫЕ ПОТОЛКИ. `incAction` делает «прочитать файл — увеличить — записать файл».
--     Два воркера, увеличивающие счётчик одновременно, читают одно значение и пишут
--     каждый своё: одно из действий не посчитано. Потолок — это защита аккаунта от бана,
--     и «иногда считает на единицу меньше» здесь означает «иногда даёт превысить».
--     Функция `bump_daily_action` для того и написана, чтобы инкремент был одним
--     запросом, — она есть в базе с самого начала и ни разу не вызывалась.
--   • КЭШ ДОВЕРИЯ. Порог trust < 40 закрывает боевые модули. В файле он у каждого
--     процесса свой, и на втором инстансе аккаунт может быть допущен там, где первый его
--     не пустил.
--
-- Здесь — только внешние ключи и права; подключение кода идёт тем же коммитом.

-- Счётчики удалённого аккаунта не нужны никому: аккаунта нет, лимит считать не для кого.
-- До этой миграции ключа не было вовсе — как и данных, так что чистить нечего.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'daily_actions_account_fkey') then
    alter table daily_actions add constraint daily_actions_account_fkey
      foreign key (account_id) references accounts_meta(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'trust_cache_account_fkey') then
    alter table trust_cache add constraint trust_cache_account_fkey
      foreign key (account_id) references accounts_meta(id) on delete cascade;
  end if;
end $$;

-- Счётчик не может быть отрицательным, а доверие живёт по шкале 0–100. Оба ограничения
-- дешёвые и оба ловят ровно ту ошибку, которая иначе тихо закрыла бы аккаунту работу.
alter table daily_actions add constraint daily_actions_count_chk check (count >= 0) not valid;
alter table trust_cache   add constraint trust_cache_score_chk   check (score between 0 and 100) not valid;
alter table daily_actions validate constraint daily_actions_count_chk;
alter table trust_cache   validate constraint trust_cache_score_chk;

comment on column trust_cache.band is
  'Словесная оценка доверия рядом с числом — её показывают в списке аккаунтов.';

grant select, insert, update, delete on daily_actions to service_role;
grant select, insert, update, delete on trust_cache   to service_role;
grant execute on function bump_daily_action(text, text, text) to service_role;
