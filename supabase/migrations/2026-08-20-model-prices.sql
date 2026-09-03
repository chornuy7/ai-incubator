-- MR-149 (созвон 19.08): цены МОДЕЛЕЙ (то, что мы платим OpenAI) — в БД, не в коде.
-- «В коде не должно быть статичных значений, особенно по прайсам» + «нужна вкладка, чтобы
-- это видеть глазами и проще редактировать, чем через код».
--
-- Это НЕ цена для клиента: клиент платит фикс-цену действия в наших ⚡. Здесь — себестоимость
-- у поставщика: $ за 1 млн токенов МОДЕЛИ (input/output), как их публикует OpenAI.
create table if not exists model_prices (
  model text primary key,                    -- 'gpt-4o-mini' (совпадение по префиксу)
  input_per_1m numeric not null default 0,   -- $ за 1M входящих токенов
  output_per_1m numeric not null default 0,  -- $ за 1M исходящих
  updated_at timestamptz not null default now()
);

insert into model_prices (model, input_per_1m, output_per_1m) values
  ('gpt-4o-mini', 0.15, 0.60),
  ('gpt-4o',      2.50, 10.00),
  ('gpt-4.1-mini',0.40, 1.60),
  ('gpt-4.1',     2.00, 8.00),
  ('o4-mini',     1.10, 4.40)
on conflict (model) do nothing;

-- Доля input в запросе. Раньше была константой INPUT_SHARE=0.75 «на глаз». Теперь: значение
-- лежит здесь как ДЕФОЛТ, но если в журнале расхода есть реальные записи, доля считается по
-- ним (prompt_tokens / total) — то есть по факту, а не по догадке.
alter table price_overrides add column if not exists input_share numeric;
update price_overrides set input_share = 0.75 where id = 'default' and input_share is null;

alter table model_prices enable row level security;
drop policy if exists model_prices_read on model_prices;
create policy model_prices_read on model_prices for select using (true);
