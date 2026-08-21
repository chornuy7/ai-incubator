-- MR-149/MR-150: максимальная стоимость действия должна учитывать и картинку.
--
-- Созвон 12.08: «цена за действие должна высчитываться с МАКСИМАЛЬНОЙ цены за одно
-- действие… включая написание текста плюс картинки. Напишет он "Привет" или 5000
-- символов — мне побоку, я всегда чарджу за 5000».
--
-- Считали только текст: прочитать пост + сгенерировать ответ. Но когда модуль разбирает
-- изображение, к этому добавляется ОТДЕЛЬНЫЙ vision-вызов — и максимум был занижен.
--
-- Лимиты vision: картинку шлём detail:'low' (у OpenAI это фиксированные 85 токенов),
-- плюс промпт; ответ ограничен max_tokens: 120. Держим в БД, как и остальные лимиты.
alter table price_overrides add column if not exists vision_input_tokens integer;
alter table price_overrides add column if not exists vision_output_tokens integer;

update price_overrides
   set vision_input_tokens  = coalesce(vision_input_tokens, 135),  -- 85 картинка (detail:low) + ~50 промпт
       vision_output_tokens = coalesce(vision_output_tokens, 120)  -- max_tokens описания
 where id = 'default';
