// Petits utilitaires d'interface, sans dépendance.

const SVG_NS = 'http://www.w3.org/2000/svg'

export function h (tag, props = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'text') el.textContent = v
    else if (k === 'dataset') Object.assign(el.dataset, v)
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v)
    else if (typeof v !== 'string' && k in el) el[k] = v
    else el.setAttribute(k, v === true ? '' : v)
  }
  appendChildren(el, children)
  return el
}

export function appendChildren (el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue
    el.append(c instanceof Node ? c : String(c))
  }
  return el
}

export function clear (el) {
  while (el.firstChild) el.firstChild.remove()
  return el
}

export function classes (...parts) {
  const out = []
  for (const p of parts) {
    if (!p) continue
    if (typeof p === 'string') out.push(p)
    else for (const [k, v] of Object.entries(p)) if (v) out.push(k)
  }
  return out.join(' ')
}

// Icônes au trait (24×24).
const ICONS = {
  hash: ['M4 9h16', 'M4 15h16', 'M10 3 8 21', 'M16 3l-2 18'],
  volume: ['M11 5 6 9H2v6h4l5 4V5z', 'M15.5 8.5a5 5 0 0 1 0 7', 'M19 5a10 10 0 0 1 0 14'],
  mic: ['M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z', 'M19 10v2a7 7 0 0 1-14 0v-2', 'M12 19v3'],
  'mic-off': ['M9 9v3a3 3 0 0 0 5.1 2.1', 'M15 9.3V5a3 3 0 0 0-5.9-.6', 'M17 16.9A7 7 0 0 1 5 12v-2', 'M19 10v2a7 7 0 0 1-.1 1.2', 'M12 19v3', 'M3 3l18 18'],
  headphones: ['M3 18v-6a9 9 0 0 1 18 0v6', 'M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z', 'M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z'],
  'headphones-off': ['M3 18v-6a9 9 0 0 1 14.5-7.1', 'M21 12v6', 'M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z', 'M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z', 'M3 3l18 18'],
  video: ['M23 7l-7 5 7 5V7z', 'M3 5h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z'],
  'video-off': ['M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2', 'M10 5h4a2 2 0 0 1 2 2v3.3l1 1L23 7v10', 'M1 1l22 22'],
  monitor: ['M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M8 21h8', 'M12 17v4'],
  plus: ['M12 5v14', 'M5 12h14'],
  'plus-circle': ['M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20z', 'M12 8v8', 'M8 12h8'],
  settings: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
  'user-plus': ['M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', 'M8.5 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8z', 'M20 8v6', 'M23 11h-6'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
  copy: ['M9 9h11v11H9z', 'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1'],
  x: ['M18 6 6 18', 'M6 6l12 12'],
  file: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6'],
  edit: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
  'chevron-down': ['M6 9l6 6 6-6'],
  'log-out': ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  'phone-off': ['M2.5 13.5c5.2-5 13.8-5 19 0l-2.3 2.3a1 1 0 0 1-1.3.1l-2.4-1.7a1 1 0 0 1-.4-.8v-2a12 12 0 0 0-6.2 0v2a1 1 0 0 1-.4.8l-2.4 1.7a1 1 0 0 1-1.3-.1z'],
  users: ['M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', 'M9 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8z', 'M23 21v-2a4 4 0 0 0-3-3.9', 'M16 3.1a4 4 0 0 1 0 7.8'],
  maximize: ['M15 3h6v6', 'M9 21H3v-6', 'M21 3l-7 7', 'M3 21l7-7']
}

export function icon (name, size = 20) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', size)
  svg.setAttribute('height', size)
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('icon')
  for (const d of ICONS[name] || []) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

function hueFor (key) {
  return parseInt(String(key).slice(0, 6), 16) % 360 || 0
}

export function colorFor (key) {
  return `hsl(${hueFor(key)}, 55%, 46%)`
}

export function nameColorFor (key) {
  return `hsl(${hueFor(key)}, 70%, 74%)`
}

export function initials (name, max = 2) {
  const words = String(name || '?').trim().split(/\s+/).filter(Boolean)
  if (words.length === 1) return Array.from(words[0]).slice(0, max).join('').toUpperCase()
  return words.slice(0, max).map((w) => Array.from(w)[0]).join('').toUpperCase()
}

export function avatar (key, name, size = 40) {
  const el = h('div', { class: 'avatar', 'aria-hidden': 'true' }, initials(name, 1))
  el.style.background = colorFor(key)
  el.style.width = el.style.height = size + 'px'
  el.style.fontSize = Math.round(size * 0.44) + 'px'
  return el
}

export function formatTime (ts) {
  return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
}

export function dayKey (ts) {
  const d = new Date(ts)
  return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate()
}

export function formatDay (ts) {
  const now = new Date()
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (dayKey(ts) === dayKey(now.getTime())) return 'Aujourd’hui'
  if (dayKey(ts) === dayKey(yesterday.getTime())) return 'Hier'
  return new Date(ts).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

export function formatStamp (ts) {
  const day = formatDay(ts)
  const time = formatTime(ts)
  if (day === 'Aujourd’hui') return 'Aujourd’hui à ' + time
  if (day === 'Hier') return 'Hier à ' + time
  return new Date(ts).toLocaleDateString('fr-FR') + ' ' + time
}

export function formatSize (bytes) {
  if (bytes < 1024) return bytes + ' o'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1).replace('.', ',') + ' Ko'
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1).replace('.', ',') + ' Mo'
  return (bytes / 1024 / 1024 / 1024).toFixed(2).replace('.', ',') + ' Go'
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi

// Texte → nœuds DOM, avec liens cliquables (jamais d'innerHTML).
export function linkify (text, onOpen) {
  const frag = document.createDocumentFragment()
  let last = 0
  for (const match of text.matchAll(URL_RE)) {
    let url = match[0]
    const trailing = /[.,;:!?)\]}]+$/.exec(url)
    if (trailing) url = url.slice(0, -trailing[0].length)
    if (match.index > last) frag.append(text.slice(last, match.index))
    frag.append(h('a', { href: url, class: 'link', onclick: (e) => { e.preventDefault(); onOpen(url) } }, url))
    last = match.index + url.length
  }
  if (last < text.length) frag.append(text.slice(last))
  return frag
}

export function openModal ({ title, body, actions = [], className = '', dismissible = true, onClose = null }) {
  const root = document.getElementById('modal-root')
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    overlay.remove()
    document.removeEventListener('keydown', onKey, true)
    if (onClose) onClose()
  }
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissible && root.lastElementChild === overlay) {
      e.stopPropagation()
      close()
    }
  }
  const submit = actions.find((a) => a.submit)
  const buttons = actions.map((a) => {
    const btn = h('button', { class: 'btn ' + (a.kind || 'secondary'), type: a.submit ? 'submit' : 'button' }, a.label)
    if (!a.submit) btn.addEventListener('click', () => a.onClick ? a.onClick(close) : close())
    return btn
  })
  const form = h('form', {
    class: 'modal ' + className,
    onsubmit: async (e) => {
      e.preventDefault()
      if (!submit) return
      const btn = form.querySelector('button[type=submit]')
      if (btn) btn.disabled = true
      try {
        await submit.onClick(close)
      } finally {
        if (btn) btn.disabled = false
      }
    }
  },
  h('header', { class: 'modal-header' },
    h('h2', {}, title),
    dismissible ? h('button', { class: 'icon-btn', type: 'button', title: 'Fermer', onclick: close }, icon('x', 20)) : null
  ),
  h('div', { class: 'modal-body' }, body),
  buttons.length ? h('footer', { class: 'modal-actions' }, buttons) : null
  )
  const overlay = h('div', { class: 'modal-overlay', onmousedown: (e) => { if (dismissible && e.target === overlay) close() } }, form)
  root.append(overlay)
  document.addEventListener('keydown', onKey, true)
  setTimeout(() => {
    const target = form.querySelector('[autofocus]') || form.querySelector('input, textarea, select')
    if (target) target.focus()
  })
  return close
}

export function toast (message, kind = 'info') {
  const root = document.getElementById('toast-root')
  const el = h('div', { class: 'toast ' + kind, role: 'status' }, message)
  root.append(el)
  setTimeout(() => el.classList.add('leaving'), 4200)
  setTimeout(() => el.remove(), 4600)
}

export function popupMenu (anchor, items) {
  document.querySelectorAll('.popup-menu').forEach((m) => m.remove())
  const menu = h('div', { class: 'popup-menu', role: 'menu' },
    items.map((it) => h('button', {
      class: classes('popup-item', { danger: it.danger }),
      type: 'button',
      onclick: () => {
        menu.remove()
        it.onClick()
      }
    }, h('span', {}, it.label), it.icon ? icon(it.icon, 18) : null))
  )
  const rect = anchor.getBoundingClientRect()
  menu.style.top = rect.bottom + 6 + 'px'
  menu.style.left = rect.left + 8 + 'px'
  menu.style.width = rect.width - 16 + 'px'
  document.body.append(menu)
  const away = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove()
      document.removeEventListener('mousedown', away, true)
    }
  }
  setTimeout(() => document.addEventListener('mousedown', away, true))
}

export function storageGet (key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function storageSet (key, value) {
  try {
    if (value === null || value === undefined || value === '') localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {}
}
