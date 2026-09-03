-- MR-149 (строго БД-only, созвон 19.08: «здесь не должно быть вообще никаких цен, всё из БД»):
-- убираем код-фолбек цен. Для этого в БД должно лежать ВСЁ, что раньше подставлялось из кода.
--
-- 1) Месячная выдача токенов на модуль (MR-150) — в module_prices колонкой (реляционно, не JSON).
--    default 100 → существующие 14 строк получают 100 автоматически. Дальше правится из админки.
alter table module_prices add column if not exists month_tokens integer not null default 100;

-- 2) Пакеты монет — были константой COIN_PACKS в коде. Сидим текущие значения в price_overrides,
--    чтобы БД стала полным источником и код-фолбек можно было убрать. (coin_packs — существующая
--    JSONB-колонка конфига; доменные данные — реляционно, это лишь витринный конфиг.)
insert into price_overrides (id, coin_packs)
  values ('default', '[{"coins":50,"price":4.99},{"coins":200,"price":17.99,"best":true},{"coins":500,"price":39.99}]'::jsonb)
  on conflict (id) do update set coin_packs = excluded.coin_packs
  where price_overrides.coin_packs is null;
