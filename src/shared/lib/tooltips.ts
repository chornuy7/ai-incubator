/**
 * Единый вид подсказок на всё приложение.
 *
 * Заказчик 01.09: «зроби щоб всюди підказки були як на 2 скріні» — то есть как тёмная
 * всплывашка `Tip`/`useTooltip` из `shared/ui`, а не как жёлто-серая плашка браузера.
 * Просьба звучит второй раз: 20.08 под неё уже сделали компонент `Tip`, но перевести на
 * него успели считаные места — в коде осталось больше четырёхсот нативных `title`.
 *
 * Почему слоем на DOM, а не заменой `title` на `<Tip>` по файлам.
 *
 * 1. Вёрстка. `Tip` — это лишний `inline-flex`-элемент вокруг цели. В кнопке внутри
 *    flex-строки или grid-ячейки такая обёртка меняет раскладку, и проверять пришлось бы
 *    каждое из четырёхсот мест. Слой не добавляет в дерево ничего.
 * 2. Вычисляемые подсказки. Сотня `title={...}` собирается из данных, и половина из них —
 *    условные (`title={x ? 'a' : undefined}`). Механически такое не переписать.
 * 3. Будущий код. Написанный завтра `title="…"` получит общий вид сам. Иначе просьба
 *    прозвучит в третий раз.
 *
 * Как работает: на наведении атрибут `title` снимается с элемента (иначе поверх нашей
 * подсказки браузер покажет ещё и свою) и переносится в `data-tip`. React при следующем
 * рендере вернёт `title` на место — поэтому переносим на КАЖДОМ наведении, а не однажды.
 *
 * Осознанное исключение — заблокированные (`disabled`) элементы: они вообще не порождают
 * событий мыши, поймать наведение на них нечем. У них `title` не снимается и остаётся
 * нативным. Это лучше, чем немая кнопка: подсказка «почему нельзя нажать» как раз там и
 * нужна.
 */

/** Один в один со стилем `useTooltip` — иначе «единый вид» разъедется на две ветки. */
const CLASS = 'pointer-events-none fixed z-[200] w-max max-w-[280px] whitespace-pre-line rounded-lg '
  + 'border border-line bg-surface px-2.5 py-1.5 text-left text-[11px] font-medium normal-case '
  + 'leading-snug text-fg shadow-xl'

/** Зазор между подсказкой и элементом и отступ от края экрана. */
const GAP = 8

let bubble: HTMLElement | null = null
let anchor: Element | null = null

function ensure(): HTMLElement {
  if (bubble && bubble.isConnected) return bubble
  bubble = document.createElement('span')
  bubble.setAttribute('role', 'tooltip')
  bubble.className = CLASS
  bubble.style.display = 'none'
  document.body.appendChild(bubble)
  return bubble
}

function hide() {
  anchor = null
  if (bubble) bubble.style.display = 'none'
}

/**
 * Текст подсказки элемента. Заодно гасит нативную: пока `title` висит на элементе,
 * браузер покажет свою плашку поверх нашей.
 *
 * Подпись для скринридера дублируем в `aria-label`, но только когда читать больше нечего:
 * у кнопки-иконки весь смысл и был в `title`, и, сняв его молча, мы сделали бы её немой.
 * У кнопки с текстом ничего не трогаем — свой текст важнее пояснения.
 */
function tipOf(el: Element): string {
  const own = el.getAttribute('title')
  if (own && own.trim()) {
    el.setAttribute('data-tip', own)
    el.removeAttribute('title')
    if (!el.getAttribute('aria-label') && !(el.textContent || '').trim()) el.setAttribute('aria-label', own)
  }
  return (el.getAttribute('data-tip') || '').trim()
}

function place(el: Element, text: string) {
  const b = ensure()
  b.textContent = text
  b.style.display = ''
  // Замер после записи текста: ширина зависит от него, а от неё — обе координаты.
  const r = el.getBoundingClientRect()
  const own = b.getBoundingClientRect()
  const сверху = r.top - own.height - GAP
  // Не влезло сверху — показываем снизу. Иначе подсказка у верхней кромки уезжает за экран.
  b.style.top = `${сверху >= GAP ? сверху : r.bottom + GAP}px`
  const x = r.left + r.width / 2 - own.width / 2
  b.style.left = `${Math.min(Math.max(GAP, x), Math.max(GAP, window.innerWidth - own.width - GAP))}px`
}

function show(e: Event) {
  const t = e.target as Element | null
  const el = t && typeof t.closest === 'function' ? t.closest('[title],[data-tip]') : null
  if (!el) { if (anchor) hide(); return }
  const text = tipOf(el)
  if (!text) { hide(); return }
  anchor = el
  place(el, text)
}

let installed = false

/** Включает общий вид подсказок. Вызывается один раз при старте приложения. */
export function installTooltips() {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener('pointerover', show, true)
  document.addEventListener('pointerout', (e) => {
    const to = (e as PointerEvent).relatedTarget as Node | null
    // Уход внутрь того же элемента (на иконку в кнопке) — не уход.
    if (anchor && to && anchor.contains(to)) return
    hide()
  }, true)
  // Клик, прокрутка и Esc убирают подсказку: элемент под ней успевает уехать или исчезнуть,
  // и «висящая» плашка осталась бы показывать пояснение к тому, чего уже нет.
  document.addEventListener('pointerdown', hide, true)
  document.addEventListener('scroll', hide, true)
  document.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Escape') hide() }, true)
  window.addEventListener('blur', hide)
  window.addEventListener('resize', hide)
}
