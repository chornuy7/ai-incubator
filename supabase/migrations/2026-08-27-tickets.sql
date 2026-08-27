-- Обращения в поддержку переезжают из файла в общую базу.
--
-- Находка 27.08 (MR-186): `server/tickets.js` писал ВСЁ в server/data/tickets.json —
-- ветки Supabase у стора не было. Последствия конкретные:
--   • переписка клиента с поддержкой живёт на диске одной машины: пропал диск —
--     пропали все обращения и ответы, восстановить неоткуда;
--   • при втором инстансе платформы клиент создаёт тикет на одном сервере, а поддержка
--     смотрит на другом и его не видит — половина обращений просто теряется;
--   • это прямое нарушение правила «никаких локальных хранилищ, только общая база».
--
-- Переписку кладём ОТДЕЛЬНЫМИ СТРОКАМИ, а не полем-JSON: сообщение — самостоятельная
-- запись со своим автором, стороной и временем, по ней считают непрочитанное и сортируют.
-- Такое складывать в JSON нельзя (правило владельца «JSON в базе = ошибка»).
create table if not exists tickets (
  id          text primary key,
  -- Автор обращения. Отдельной колонкой, а не в общем поле: по нему выбирают
  -- «мои обращения» в кабинете — это фильтр, а не описание.
  user_id     text not null,
  subject     text not null,
  category    text not null default 'tech',
  status      text not null default 'open',
  created_at  bigint not null,
  updated_at  bigint not null,
  -- Метки «прочитано до» по сторонам, в миллисекундах. Две отдельные колонки, потому
  -- что счётчик непрочитанного у клиента и у поддержки считается независимо.
  read_user    bigint not null default 0,
  read_support bigint not null default 0,
  constraint tickets_status_chk check (status in ('open','progress','waiting','escalated','closed'))
);

create table if not exists ticket_messages (
  id         text primary key,
  ticket_id  text not null references tickets(id) on delete cascade,
  -- Кто написал: клиент или поддержка. От этого зависит и вид реплики, и непрочитанное.
  side       text not null,
  -- Автора денормализуем в момент отправки: в переписке должно быть видно КТО написал —
  -- имя и почта человека на тот момент, а не текущая роль. Человек может уволиться или
  -- сменить роль, а история переписки обязана остаться такой, какой была.
  author_id    text,
  author_name  text,
  author_email text,
  text       text not null,
  ts         bigint not null,
  constraint ticket_messages_side_chk check (side in ('user','support'))
);

create index if not exists tickets_user_idx        on tickets (user_id);
create index if not exists tickets_updated_idx     on tickets (updated_at desc);
create index if not exists ticket_messages_tid_idx on ticket_messages (ticket_id, ts);

-- Доступ только у бэкенда (сервисный ключ обходит RLS). Публичной политики нет намеренно:
-- в переписке поддержки лежат почты и содержимое обращений чужих людей.
alter table tickets         enable row level security;
alter table ticket_messages enable row level security;

comment on table tickets is 'Обращения в поддержку. Переехали из server/data/tickets.json (27.08, MR-186): файл жил на одной машине, второй инстанс не видел половину обращений.';
comment on table ticket_messages is 'Переписка по обращению, по строке на сообщение. Отдельная таблица, а не поле-JSON: по сообщениям считают непрочитанное и сортируют — это данные, а не снимок.';
comment on column ticket_messages.author_name is 'Имя автора НА МОМЕНТ ОТПРАВКИ. Денормализовано намеренно: история переписки не должна меняться, когда человек сменил роль или ушёл.';
