-- MR-149: МАКСИМАЛЬНАЯ стоимость одного ИИ-действия — чтобы видеть, покрывает ли её цена.
--
-- Логика заказчика: ИИ читает пост (максимум N символов) и генерирует ответ (максимум M
-- символов). Это худший случай — от него ставим цену, добавляя свои расходы и маржу.
-- Рядом смотрим ФАКТИЧЕСКИЙ расход: по максимуму работают не все.
--
-- Лимиты держим в БД, а не в коде: раньше это были константы MAX_TEXT_CHARS/CHARS_PER_TOKEN,
-- и заказчик отдельно указывал, что статичных значений по прайсам в коде быть не должно.
alter table price_overrides add column if not exists max_input_chars integer;   -- сколько максимум читает (4096 — лимит поста в Telegram)
alter table price_overrides add column if not exists max_output_chars integer;  -- сколько максимум генерирует
alter table price_overrides add column if not exists chars_per_token numeric;   -- символов на 1 токен модели (у GPT ≈ 4)

update price_overrides
   set max_input_chars  = coalesce(max_input_chars, 4096),
       max_output_chars = coalesce(max_output_chars, 4096),
       chars_per_token  = coalesce(chars_per_token, 4)
 where id = 'default';
