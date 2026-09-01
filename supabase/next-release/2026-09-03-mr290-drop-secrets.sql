-- MR-290: снос открытых секретов. УСЛОВИЕ ДРУГОЕ, чем у соседнего файла.
--
-- ⚠️ ЭТОТ ФАЙЛ ПРИМЕНЯЕТСЯ РУКАМИ И ТОЛЬКО ПОСЛЕ ПЕРЕНОСА СЕКРЕТОВ.
--
-- Соседний drop-legacy.sql ждёт всего лишь следующего выпуска. Здесь условие не «прошёл
-- выпуск», а «человек запустил перенос и убедился, что он отработал»:
--
--   node --env-file=.env server/scripts/encrypt-secrets.mjs --dry
--   node --env-file=.env server/scripts/encrypt-secrets.mjs
--   node --env-file=.env server/scripts/encrypt-proxy-passwords.mjs --dry
--   node --env-file=.env server/scripts/encrypt-proxy-passwords.mjs
--
-- Разница принципиальная. Облачный пароль 2FA нельзя прочитать в Telegram и неоткуда
-- восстановить: снос до переноса — не «откатимся из бэкапа», а потеря доступа к
-- аккаунтам. Пароль прокси восстановим у поставщика, но это тоже разбор на полдня.
--
-- Проверки ниже не дадут снести неперенесённое: если найдётся хоть один открытый
-- секрет, миграция откажет целиком.

do $$
declare осталось bigint;
begin
  select count(*) into осталось from accounts_meta
   where nullif(data->>'twoFA', '') is not null and two_fa_enc is null;
  if осталось > 0 then
    raise exception 'MR-290: у % аккаунтов пароль 2FA ещё открытым текстом и не зашифрован — сначала encrypt-secrets.mjs', осталось;
  end if;

  select count(*) into осталось from proxies
   where nullif(password, '') is not null and password_enc is null;
  if осталось > 0 then
    raise exception 'MR-290: у % прокси пароль ещё открытым текстом — сначала encrypt-proxy-passwords.mjs', осталось;
  end if;
end $$;

-- Открытый пароль прокси. Зашифрованный лежит в password_enc.
alter table proxies drop column if exists password;

-- Открытый пароль 2FA внутри мешка. Зашифрованный лежит в accounts_meta.two_fa_enc.
-- Мешок целиком не сносим: у аккаунта в нём остаются поля, которые ещё не разложены.
update accounts_meta set data = data - 'twoFA' where data ? 'twoFA';

comment on column accounts_meta.two_fa_enc is
  'Облачный пароль (2FA), зашифрованный ключом из окружения. Открытая копия в data.twoFA снесена (MR-290). Потеря SECRETS_KEY означает потерю пароля: восстановить его неоткуда.';
