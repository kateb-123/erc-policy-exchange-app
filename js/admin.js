/* ============================================================
 * admin.js: the admin door's editor (Kate, Sep 23, 2026)
 * ============================================================
 * Loaded by app.js only in a browser that carries the admin hint cookie,
 * and it shows nothing until the server confirms the sign-in. It adds an
 * Edit button to every item, a strip with "Add to New & upcoming", the
 * hidden items and Sign out, and the dialogs behind them. Every change goes
 * through /api/admin/save, which checks the sign-in again and commits the
 * change to GitHub; the live site shows it after the next deploy (about a
 * minute). This page shows it at once.
 * ============================================================ */
const X = window.Exchange;

async function api(path, body) {
  lastRenew = Date.now(); // every call renews the sign-in on the server
  try {
    const res = await fetch(`/api/admin/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const data = await res.json().catch(() => null);
    return data || { ok: false, error: 'Something went wrong on our side. Try again in a minute.' };
  } catch {
    return { ok: false, error: "Couldn't reach the server. Check your connection and try again." };
  }
}

// The editor is for a laptop or desktop (Kate, Sep 24: no editing on a
// phone); at phone widths it doesn't load at all.
const PHONE = '(max-width: 780px)';
// Editing turns off after 10 minutes without use (Kate, Sep 24). A click or a
// key anywhere on the page is use; while there is use the sign-in is renewed
// at most once a minute, and after 10 quiet minutes the editor goes away and
// the sign-in ends.
const IDLE_MS = 10 * 60 * 1000;
let idleTimer = 0;
let lastRenew = 0;
let observer = null;

async function start() {
  if (matchMedia(PHONE).matches) return;
  const session = await api('session');
  if (!session.ok) {
    // An old hint with no sign-in behind it: forget it.
    document.cookie = 'exa_admin_on=; Path=/; Max-Age=0; SameSite=Strict';
    return;
  }
  buildBar();
  // The hero cards show their empty photo slots to an editor.
  document.documentElement.classList.add('admin-on');
  watch();
  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, stayAwake, true));
  stayAwake();
}

function stayAwake() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(goQuiet, IDLE_MS);
  if (Date.now() - lastRenew > 60 * 1000) {
    api('session').then((s) => {
      if (!s.ok) goQuiet();
    });
  }
}

function goQuiet() {
  clearTimeout(idleTimer);
  ['pointerdown', 'keydown'].forEach((ev) => document.removeEventListener(ev, stayAwake, true));
  if (observer) observer.disconnect();
  if (dialog && dialog.open) dialog.close();
  document.querySelectorAll('.admin-bar, .admin-edit').forEach((n) => n.remove());
  document.documentElement.classList.remove('admin-on');
  api('logout', {});
  toast('Editing turned off after 10 minutes without use. Sign in again to edit.');
}

/* ---------- Small helpers ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, text) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  if (text !== undefined) n.textContent = text;
  return n;
};
const addDays = (n) => {
  const [y, m, d] = X.TODAY.split('-').map(Number);
  const t = new Date(y, m - 1, d + n);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};
const findItem = (key) => X.state.allItems.find((it) => X.itemKey(it) === key);
const pinOf = (key) => X.state.featured.pins.find((p) => p.key === key);

let toastTimer = 0;
function toast(msg) {
  const t = $('.admin-toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, 6000);
}

/* ---------- The strip at the top ---------- */

function buildBar() {
  const bar = el('div', { class: 'admin-bar', role: 'region', 'aria-label': 'Admin' });
  bar.append(
    el('span', { class: 'admin-bar__on' }, 'Editing is on'),
    el('button', { type: 'button', 'data-admin': 'card' }, 'Add to New & Upcoming'),
    el('button', { type: 'button', 'data-admin': 'hidden' }, 'Hidden items'),
    el('button', { type: 'button', 'data-admin': 'out' }, 'Sign out')
  );
  bar.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-admin]');
    if (!b) return;
    if (b.dataset.admin === 'card') openCard();
    if (b.dataset.admin === 'hidden') openHidden();
    if (b.dataset.admin === 'out') {
      await api('logout', {});
      location.reload();
    }
  });
  document.body.prepend(bar);
  document.body.append(el('p', { class: 'admin-toast', role: 'status', hidden: true }));
}

/* ---------- Edit buttons on every item ---------- */

// Rows are redrawn all the time (filters, Show more, the list's walk), so a
// watcher adds the button to anything that doesn't have one yet.
function decorate() {
  document.querySelectorAll('#news-list .feed-item[data-key], #news-list .ncard[data-key], #wn-feat[data-key]').forEach((node) => {
    if ($(':scope > .admin-edit', node)) return;
    const key = node.dataset.key;
    if (key.startsWith('fixed:')) return; // the Share card has nothing to edit
    const title = key.startsWith('card:') ? 'this card' : (findItem(key) || {}).headline || 'this item';
    const b = el('button', { type: 'button', class: 'admin-edit', 'aria-label': `Edit: ${title}` }, 'Edit');
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (key.startsWith('card:')) openCard(key.slice(5));
      else openItem(key);
    });
    node.append(b);
  });
}
function watch() {
  decorate();
  // The observer already batches changes; adding a button triggers one more
  // pass, which finds nothing left to do.
  observer = new MutationObserver(decorate);
  ['#news-list', '#wn-split'].forEach((sel) => {
    const root = $(sel);
    if (root) observer.observe(root, { childList: true, subtree: true });
  });
}

/* ---------- The item editor ---------- */

// The sheet's columns in the order a person thinks about an item.
const FIELDS = [
  ['headline', 'Title', 'text'],
  ['link', 'Link', 'url'],
  ['type', 'Section', 'type'],
  ['subtype', 'Category', 'text', 'The tag on the item, for example Working Paper or Texas.'],
  ['source', 'Source', 'text'],
  ['date', 'Date', 'text', 'Written 2026-10-01. For an event, the day it happens.'],
  ['deadline', 'Deadline', 'text', 'Opportunities: 2026-10-01, or "rolling".'],
  ['time', 'Time', 'text', 'Events only.'],
  ['location', 'Location', 'text', 'Events only.'],
  ['authors', 'Authors', 'text', 'Research only.'],
  ['medium', 'Medium', 'text', 'Headlines only: radio, TV, newspaper, magazine.'],
  ['topic', 'Topic', 'text'],
  ['blurb', 'Summary', 'area'],
  ['infographic', 'Picture or infographic link', 'url', 'A direct link to a picture (ending .jpg or .png), or a Google Drive file. New & Upcoming shows pictures at 1200 x 500 pixels.'],
];
const SECTIONS = [
  ['research', 'Research'],
  ['event', 'Events'],
  ['opportunity', 'Opportunities'],
  ['headline', 'Headlines'],
];

let dialog = null;
function makeDialog() {
  if (dialog) return dialog;
  dialog = el('dialog', { class: 'admin-dlg', 'aria-labelledby': 'admin-dlg-h' });
  document.body.append(dialog);
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close(); // a click on the backdrop
  });
  return dialog;
}
function note(form, msg, kind) {
  const p = $('.admin-note', form);
  p.textContent = msg || '';
  p.className = `admin-note${kind ? ` admin-note--${kind}` : ''}`;
}
// A running count under a title: past 100 characters the New & Upcoming card
// sets the title smaller and leaves out the summary (Kate, Sep 24).
function titleCount(input, text) {
  const hint = el('p', { class: 'admin-hint', id: `${input.id}-count` });
  const say = () => {
    const n = input.value.trim().length;
    hint.textContent = text
      ? text(n)
      : `${n} characters. Aim for 100 or fewer: longer titles show smaller in New & Upcoming, with no summary.`;
  };
  input.addEventListener('input', say);
  say();
  input.setAttribute('aria-describedby', `${input.getAttribute('aria-describedby') || ''} ${hint.id}`.trim());
  return hint;
}
function fieldRow(id, label, control, hint) {
  const wrap = el('div', { class: 'admin-field' });
  wrap.append(el('label', { for: id }, label), control);
  if (hint) {
    const h = el('p', { class: 'admin-hint', id: `${id}-hint` }, hint);
    control.setAttribute('aria-describedby', h.id);
    wrap.append(h);
  }
  return wrap;
}

// A picture from her computer (Kate, Sep 30): read it, send it, and put the
// path it was saved under into the picture link box beside it.
function pictureUpload(linkInput) {
  const wrap = el('div', { class: 'admin-upload' });
  const input = el('input', { type: 'file', id: `${linkInput.id}-file`, accept: 'image/jpeg,image/png,image/webp' });
  const label = el('label', { for: input.id, class: 'btn-text admin-upload__btn' }, 'Or choose a picture from your computer');
  const say = el('span', { class: 'admin-hint', role: 'status' });
  input.addEventListener('change', async () => {
    const f = input.files[0];
    if (!f) return;
    if (f.size > 3 * 1024 * 1024) {
      say.textContent = 'That picture is over 3 MB. Make it smaller first.';
      input.value = '';
      return;
    }
    say.textContent = 'Saving the picture…';
    const data = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1] || '');
      r.onerror = rej;
      r.readAsDataURL(f);
    });
    const r = await api('save', { op: 'picture', name: f.name, type: f.type, data });
    input.value = '';
    if (!r.ok) return (say.textContent = r.error);
    linkInput.value = r.path;
    linkInput.dispatchEvent(new Event('input'));
    say.textContent = 'Picture saved. Now save this form to use it; the live site shows it after the next publish.';
  });
  wrap.append(input, label, say);
  return wrap;
}

function openItem(key) {
  const item = findItem(key);
  if (!item) return toast("That item isn't in the page any more. Reload the page.");
  const d = makeDialog();
  const form = el('form', { class: 'admin-form', novalidate: true });
  form.append(el('h2', { id: 'admin-dlg-h' }, 'Edit item'));
  const grid = el('div', { class: 'admin-grid' });
  for (const [name, label, kind, hint] of FIELDS) {
    const id = `a-${name}`;
    let control;
    if (kind === 'area') {
      control = el('textarea', { id, name, rows: '6' });
    } else if (kind === 'type') {
      control = el('select', { id, name });
      SECTIONS.forEach(([v, l]) => control.append(el('option', { value: v }, l)));
    } else {
      control = el('input', { id, name, type: kind === 'url' ? 'url' : 'text', autocomplete: 'off' });
    }
    control.value = item[name] || '';
    const row = fieldRow(id, label, control, hint);
    if (name === 'blurb' || name === 'headline' || name === 'infographic') row.classList.add('admin-field--wide');
    if (name === 'headline') row.append(titleCount(control));
    if (name === 'headline' || name === 'blurb') row.append(el('p', { class: 'admin-hint' }, 'Stars round a book or journal name, *like this*, show it in italics.'));
    if (name === 'infographic') row.append(pictureUpload(control));
    grid.append(row);
  }
  form.append(grid);

  const pin = pinOf(key);
  const pinBox = el('fieldset', { class: 'admin-pin' });
  pinBox.append(el('legend', {}, 'New & Upcoming'));
  const pinOn = el('input', { type: 'checkbox', id: 'a-pin' });
  pinOn.checked = !!pin;
  const pinUntil = el('input', { type: 'date', id: 'a-until', min: X.TODAY });
  pinUntil.value = pin ? pin.until : addDays(14);
  const onLabel = el('label', { class: 'admin-check', for: 'a-pin' });
  onLabel.append(pinOn, document.createTextNode(' Pin it to the front'));
  pinBox.append(onLabel, fieldRow('a-until', 'until', pinUntil));
  // The card it is drawn as there: Suggested (what fits what it has) first,
  // then the rest (Kate, Sep 24).
  const { auto, fits } = itemAuto(item);
  const autoName = ITEM_CARDS.find(([v]) => v === auto)[1];
  const heroWas = (X.state.featured.heroes || []).find((h) => h.key === key)?.hero || '';
  const tiles = heroTiles(heroWas, [
    ['Suggested', [['', 'Auto', `picks ${autoName} for this item`], ...ITEM_CARDS.filter(([v]) => fits.includes(v))]],
    ['The rest', ITEM_CARDS.filter(([v]) => !fits.includes(v))],
  ]);
  tiles.classList.add('admin-tiles--item');
  pinBox.append(tiles);
  form.append(pinBox);

  form.append(el('p', { class: 'admin-note', role: 'status' }));
  const actions = el('div', { class: 'admin-actions' });
  const save = el('button', { type: 'submit', class: 'btn' }, 'Save');
  const cancel = el('button', { type: 'button', class: 'btn-text' }, 'Cancel');
  const hide = el('button', { type: 'button', class: 'btn-text' }, 'Hide from the site');
  const del = el('button', { type: 'button', class: 'btn-text admin-danger' }, 'Delete…');
  actions.append(save, cancel, el('span', { class: 'admin-actions__gap' }), hide, del);
  form.append(actions);
  const confirmBox = el('div', { class: 'admin-confirm', hidden: true });
  const yes = el('button', { type: 'button', class: 'btn admin-danger-btn' }, 'Delete it');
  const no = el('button', { type: 'button', class: 'btn-text' }, 'Keep it');
  confirmBox.append(
    el('p', {}, 'Delete this item from the site? It stays in GitHub’s history, where it can be brought back.'),
    yes,
    no
  );
  form.append(confirmBox);

  const busy = (on) => [save, cancel, hide, del, yes, no].forEach((b) => (b.disabled = on));
  cancel.addEventListener('click', () => d.close());
  del.addEventListener('click', () => {
    confirmBox.hidden = false;
    no.focus();
  });
  no.addEventListener('click', () => {
    confirmBox.hidden = true;
    del.focus();
  });

  yes.addEventListener('click', async () => {
    busy(true);
    note(form, 'Deleting…', 'busy');
    const r = await api('save', { op: 'delete', original: { ...item } });
    busy(false);
    if (!r.ok) return note(form, r.error, 'error');
    X.state.allItems.splice(X.state.allItems.indexOf(item), 1);
    X.refresh();
    d.close();
    toast('Deleted. It leaves the live site in about a minute.');
  });

  hide.addEventListener('click', async () => {
    busy(true);
    note(form, 'Hiding…', 'busy');
    const r = await api('save', { op: 'hide', key });
    busy(false);
    if (!r.ok) return note(form, r.error, 'error');
    X.state.featured = r.featured;
    X.refresh();
    d.close();
    toast('Hidden. It leaves the live site in about a minute; "Hidden items" brings it back.');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fields = {};
    for (const [name] of FIELDS) {
      const v = form.elements[name].value.trim();
      if (v !== (item[name] || '')) fields[name] = v;
    }
    if ('headline' in fields && !fields.headline) return note(form, 'An item needs a title.', 'error');
    busy(true);
    note(form, 'Saving…', 'busy');
    let newKey = key;
    if (Object.keys(fields).length) {
      const r = await api('save', { op: 'edit', original: { ...item }, fields });
      if (!r.ok) {
        busy(false);
        return note(form, r.error, 'error');
      }
      Object.assign(item, r.row);
      if (r.featured) X.state.featured = r.featured;
      newKey = X.itemKey(item);
    }
    // The pin: add, move its date, or take it off.
    const had = pinOf(newKey);
    const want = pinOn.checked;
    if (want && (!had || had.until !== pinUntil.value)) {
      const r = await api('save', { op: 'pin', key: newKey, until: pinUntil.value });
      if (!r.ok) {
        busy(false);
        X.refresh();
        return note(form, `The item saved, but the pin didn't: ${r.error}`, 'error');
      }
      X.state.featured = r.featured;
    } else if (!want && had) {
      const r = await api('save', { op: 'unpin', key: newKey });
      if (!r.ok) {
        busy(false);
        X.refresh();
        return note(form, `The item saved, but the pin didn't come off: ${r.error}`, 'error');
      }
      X.state.featured = r.featured;
    }
    // The hero card, if she changed it.
    if (tiles.value !== heroWas) {
      const r = await api('save', { op: 'hero', key: newKey, hero: tiles.value });
      if (!r.ok) {
        busy(false);
        X.refresh();
        return note(form, `The item saved, but the card choice didn't: ${r.error}`, 'error');
      }
      X.state.featured = r.featured;
    }
    busy(false);
    X.refresh();
    d.close();
    toast('Saved. The live site shows it in about a minute.');
  });

  d.replaceChildren(form);
  d.showModal();
  form.elements.headline.focus();
}

/* ---------- One-off cards for New & upcoming ---------- */

// The hero cards, each drawn small so she can tell them apart (Kate, Sep 24):
// Suggested first (what fits the item), then the rest.
const ART = {
  auto: '<svg viewBox="0 0 120 50" aria-hidden="true"><rect width="120" height="50" fill="#F6F6F6"/><rect x="0.5" y="0.5" width="119" height="49" fill="none" stroke="#D1D1D1"/><rect x="10" y="12" width="20" height="3" fill="#732F2F"/><rect x="10" y="20" width="70" height="5" fill="#500000"/><rect x="10" y="28" width="56" height="5" fill="#500000"/><rect x="10" y="38" width="36" height="3" fill="#3E3E3E"/><text x="96" y="34" font-family="Work Sans,sans-serif" font-size="22" font-weight="600" fill="#D1D1D1">?</text></svg>',
  erc: '<svg viewBox="0 0 120 50" aria-hidden="true"><rect width="120" height="50" fill="#500000"/><rect x="8" y="10" width="22" height="3" fill="#D6D3C4"/><rect x="8" y="18" width="60" height="5" fill="#fff"/><rect x="8" y="26" width="48" height="5" fill="#fff"/><rect x="8" y="37" width="34" height="3" fill="#D6D3C4"/><rect x="80" width="40" height="50" fill="#A7A7A7"/><circle cx="100" cy="19" r="7" fill="#F6F6F6"/><path d="M85 50 Q100 30 115 50Z" fill="#F6F6F6"/></svg>',
  date: '<svg viewBox="0 0 120 50" aria-hidden="true"><rect width="120" height="50" fill="#fff"/><rect x="0.5" y="0.5" width="119" height="49" fill="none" stroke="#D1D1D1"/><rect width="34" height="50" fill="#500000"/><rect x="11" y="10" width="12" height="2" fill="#D6D3C4"/><text x="17" y="36" text-anchor="middle" font-family="Work Sans,sans-serif" font-size="18" font-weight="600" fill="#fff">12</text><rect x="44" y="12" width="22" height="3" fill="#732F2F"/><rect x="44" y="20" width="62" height="5" fill="#500000"/><rect x="44" y="28" width="48" height="5" fill="#500000"/><rect x="44" y="38" width="36" height="3" fill="#3E3E3E"/></svg>',
  type: '<svg viewBox="0 0 120 50" aria-hidden="true"><rect width="120" height="50" fill="#500000"/><rect x="8" y="12" width="22" height="3" fill="#D6D3C4"/><rect x="8" y="20" width="72" height="6" fill="#fff"/><rect x="8" y="29" width="54" height="6" fill="#fff"/><rect x="8" y="40" width="34" height="3" fill="#D6D3C4"/><g fill="#732F2F"><circle cx="98" cy="8" r="1.4"/><circle cx="104" cy="8" r="1.4"/><circle cx="110" cy="8" r="1.4"/><circle cx="98" cy="14" r="1.4"/><circle cx="104" cy="14" r="1.4"/><circle cx="110" cy="14" r="1.4"/><circle cx="98" cy="20" r="1.4"/><circle cx="104" cy="20" r="1.4"/><circle cx="110" cy="20" r="1.4"/></g></svg>',
  band: '<svg viewBox="0 0 120 50" aria-hidden="true"><rect width="120" height="50" fill="#F6F6F6"/><rect width="120" height="2" fill="#500000"/><rect x="8" y="8" width="22" height="3" fill="#732F2F"/><rect x="8" y="14" width="70" height="5" fill="#500000"/><rect x="8" y="21" width="40" height="3" fill="#3E3E3E"/><rect y="28" width="120" height="22" fill="#A7A7A7"/></svg>',
  edit: '<svg viewBox="0 0 120 50" aria-hidden="true"><rect width="120" height="50" fill="#F6F6F6"/><rect x="8" y="10" width="62" height="6" fill="#500000"/><rect x="8" y="19" width="48" height="6" fill="#500000"/><rect x="8" y="29" width="14" height="2" fill="#500000"/><rect x="8" y="34" width="56" height="4" fill="#3E3E3E"/><rect x="8" y="41" width="40" height="3" fill="#535353"/><rect x="80" width="40" height="50" fill="#A7A7A7"/><circle cx="100" cy="19" r="7" fill="#F6F6F6"/><path d="M85 50 Q100 30 115 50Z" fill="#F6F6F6"/></svg>',
  poster: '<svg viewBox="0 0 120 50" aria-hidden="true"><rect width="120" height="50" fill="#A7A7A7"/><rect width="72" height="50" fill="#500000"/><rect x="8" y="12" width="52" height="6" fill="#fff"/><rect x="8" y="21" width="40" height="6" fill="#fff"/><rect x="8" y="32" width="48" height="3" fill="#D6D3C4"/><rect x="8" y="38" width="36" height="3" fill="#D6D3C4"/></svg>',
  plainr: '<svg viewBox="0 0 120 50" aria-hidden="true"><rect width="120" height="50" fill="#fff"/><rect x="0.5" y="0.5" width="119" height="49" fill="none" stroke="#D1D1D1"/><rect x="8" y="10" width="70" height="6" fill="#3E3E3E"/><rect x="8" y="19" width="52" height="6" fill="#3E3E3E"/><rect x="8" y="29" width="60" height="4" fill="#500000"/><rect x="8" y="39" width="104" height="1.5" fill="#500000"/><rect x="8" y="43" width="44" height="3" fill="#535353"/></svg>',
  beside: '<svg viewBox="0 0 120 50" aria-hidden="true"><rect width="120" height="50" fill="#F6F6F6"/><rect x="0.5" y="0.5" width="119" height="49" fill="none" stroke="#D1D1D1"/><rect x="8" y="12" width="22" height="3" fill="#732F2F"/><rect x="8" y="19" width="56" height="5" fill="#500000"/><rect x="8" y="27" width="44" height="5" fill="#500000"/><rect x="8" y="37" width="36" height="3" fill="#3E3E3E"/><rect x="72" y="10" width="40" height="30" fill="#A7A7A7" stroke="#D1D1D1"/></svg>',
  photo: '<svg viewBox="0 0 120 50" aria-hidden="true"><rect width="120" height="50" fill="#D1D1D1"/><rect y="22" width="78" height="28" fill="#500000"/><rect x="6" y="28" width="24" height="3" fill="#D6D3C4"/><rect x="6" y="34" width="60" height="4" fill="#fff"/><rect x="6" y="41" width="44" height="4" fill="#fff"/></svg>',
  quote: '<svg viewBox="0 0 120 50" aria-hidden="true"><rect width="120" height="50" fill="#F6F6F6"/><rect x="0.5" y="0.5" width="119" height="49" fill="none" stroke="#D1D1D1"/><text x="6" y="20" font-family="Georgia,serif" font-size="22" font-weight="700" fill="#732F2F">“</text><rect x="7" y="22" width="62" height="3.5" fill="#500000"/><rect x="7" y="28" width="66" height="3.5" fill="#500000"/><rect x="7" y="34" width="40" height="3.5" fill="#500000"/><rect x="7" y="42" width="22" height="3" fill="#500000"/><rect x="80" width="40" height="50" fill="#A7A7A7"/><circle cx="100" cy="19" r="7" fill="#F6F6F6"/><path d="M85 50 Q100 30 115 50Z" fill="#F6F6F6"/></svg>',
};
// value, name, what it needs (in words)
const ITEM_CARDS = [
  ['edit', 'Editorial', 'the byline large; a portrait at the right, or the words fill the card'],
  ['poster', 'Poster', 'a maroon panel over the wide photo, or all maroon'],
  ['plainr', 'Plain research', 'white, outlined, the source at the foot'],
  ['erc', 'ERC event', 'the words at the left, a portrait at the right'],
  ['date', 'Date panel', 'the day in a maroon panel, the words beside it'],
  ['type', 'Plain', 'the words on maroon, no picture'],
  ['band', 'Wide picture', 'the words over a wide strip of picture (research), or under it'],
  ['beside', 'Picture beside', 'the words at the left, a 440 x 300 picture at the right'],
  ['photo', 'Photo', 'the picture behind, the words in a maroon block'],
];
const ONEOFF_CARDS = [['quote', 'Quote', 'the words, who said them, a portrait']];
const isPic = (url) => /\.(jpe?g|png|webp|gif|avif)$/i.test((url || '').trim());

// What Auto picks for an item, and which cards fit what it has.
function itemAuto(item) {
  const kind = (item.type || '').toLowerCase();
  const img = isPic(item.infographic);
  const date = /^\d{4}-\d{2}-\d{2}$/.test((item.date || '').trim());
  const auto =
    kind === 'event' ? (img ? 'erc' : date ? 'date' : 'type') : kind === 'research' ? 'edit' : kind === 'opportunity' ? 'type' : img ? 'photo' : 'type';
  const research = ['edit', 'poster', 'plainr'];
  const fits = ITEM_CARDS.filter(([v]) =>
    kind === 'research' ? research.includes(v) : v === 'type' || (v === 'date' ? date : !research.includes(v) && img)
  ).map(([v]) => v);
  return { auto, fits };
}

function heroTiles(current, groups) {
  const box = el('fieldset', { class: 'admin-tiles', id: 'c-hero' });
  box.append(el('legend', {}, 'Hero card'));
  groups.forEach(([title, cards]) => {
    if (!cards.length) return;
    const g = el('div', { class: 'admin-tiles__group' });
    if (title) g.append(el('span', { class: 'admin-tiles__h' }, title));
    const grid = el('div', { class: 'admin-tiles__grid' });
    cards.forEach(([v, name, desc, art]) => {
      const tile = el('label', { class: 'admin-tile' });
      const r = el('input', { type: 'radio', name: 'c-hero', value: v });
      r.checked = v === current;
      const pic = el('span', { class: 'admin-tile__art' });
      pic.innerHTML = art || ART[v || 'auto'];
      tile.append(r, pic, el('span', { class: 'admin-tile__name' }, name), el('small', {}, desc));
      grid.append(tile);
    });
    g.append(grid);
    box.append(g);
  });
  // Reads and sets like a select, so the form treats it as one.
  Object.defineProperty(box, 'value', {
    get: () => ($('input:checked', box) || {}).value || '',
    set: (v) => {
      const r = $(`input[value="${v}"]`, box);
      if (r) r.checked = true;
    },
  });
  return box;
}

function openCard(id) {
  const existing = id ? X.state.featured.cards.find((c) => c.id === id) : null;
  const d = makeDialog();
  const form = el('form', { class: 'admin-form', novalidate: true });
  form.append(el('h2', { id: 'admin-dlg-h' }, existing ? 'Edit card' : 'Add to New & Upcoming'));
  form.append(
    el('p', { class: 'admin-hint' }, 'A card that shows only in New & Upcoming, first in line, until the day you pick. To put an item that is already on the site there, open it with Edit and pin it.')
  );
  const grid = el('div', { class: 'admin-grid' });
  const inputs = {
    hero: heroTiles(existing ? existing.hero || '' : '', [
      ['Suggested', [['', 'Auto', 'your picture with the title, or the plain card', ART.photo], ...ONEOFF_CARDS]],
    ]),
    headline: el('input', { id: 'c-headline', type: 'text', autocomplete: 'off' }),
    link: el('input', { id: 'c-link', type: 'url', autocomplete: 'off' }),
    label: el('input', { id: 'c-label', type: 'text', autocomplete: 'off', maxlength: '40' }),
    until: el('input', { id: 'c-until', type: 'date', min: X.TODAY }),
    blurb: el('textarea', { id: 'c-blurb', rows: '4' }),
    image: el('input', { id: 'c-image', type: 'url', autocomplete: 'off' }),
    who: el('input', { id: 'c-who', type: 'text', autocomplete: 'off', maxlength: '120' }),
    role: el('input', { id: 'c-role', type: 'text', autocomplete: 'off', maxlength: '200' }),
  };
  inputs.headline.value = existing ? existing.headline : '';
  inputs.link.value = existing ? existing.link : '';
  inputs.label.value = existing ? existing.label : 'ERC';
  inputs.until.value = existing ? existing.until : addDays(14);
  inputs.blurb.value = existing ? existing.blurb : '';
  inputs.image.value = existing ? existing.image : '';
  inputs.who.value = existing ? existing.who || '' : '';
  inputs.role.value = existing ? existing.role || '' : '';
  const isQuote = () => inputs.hero.value === 'quote';
  const heroRow = el('div', { class: 'admin-field' });
  heroRow.append(inputs.hero, el('p', { class: 'admin-hint' }, 'How the card is drawn in New & Upcoming on laptops.'));
  const rows = [
    heroRow,
    fieldRow('c-headline', 'Title', inputs.headline),
    fieldRow('c-link', 'Link', inputs.link, 'Optional. Where the card goes when clicked.'),
    fieldRow('c-label', 'Label', inputs.label, 'The small word over the title, for example ERC or Announcement.'),
    fieldRow('c-until', 'Show until', inputs.until),
    fieldRow('c-blurb', 'Summary', inputs.blurb),
    fieldRow('c-image', 'Picture link', inputs.image, PICTURE_HINTS.auto),
    fieldRow('c-who', 'Who said it', inputs.who),
    fieldRow('c-role', 'Their title and organization', inputs.role),
  ];
  rows[0].classList.add('admin-field--wide');
  rows[1].classList.add('admin-field--wide');
  rows[1].append(el('p', { class: 'admin-hint' }, 'Stars round a book or journal name, *like this*, show it in italics.'));
  rows[1].append(
    titleCount(inputs.headline, (n) =>
      isQuote()
        ? `${n} characters. Aim for 120 or fewer: longer quotes show smaller in New & Upcoming.`
        : `${n} characters. Aim for 100 or fewer: longer titles show smaller in New & Upcoming, with no summary.`
    )
  );
  rows[5].classList.add('admin-field--wide');
  rows[6].classList.add('admin-field--wide');
  rows[6].append(pictureUpload(inputs.image));
  grid.append(...rows);
  // Each template shows only its own fields.
  const shape = () => {
    const q = isQuote();
    $('label', rows[1]).textContent = q ? 'The quote' : 'Title';
    rows[3].hidden = q;
    rows[5].hidden = q;
    rows[7].hidden = !q;
    rows[8].hidden = !q;
    $('#c-image-hint', rows[6]).textContent = q ? PICTURE_HINTS.quote : PICTURE_HINTS.auto;
    inputs.headline.dispatchEvent(new Event('input'));
  };
  inputs.hero.addEventListener('change', shape);
  shape();
  form.append(grid, el('p', { class: 'admin-note', role: 'status' }));

  const actions = el('div', { class: 'admin-actions' });
  const save = el('button', { type: 'submit', class: 'btn' }, existing ? 'Save' : 'Add card');
  const cancel = el('button', { type: 'button', class: 'btn-text' }, 'Cancel');
  actions.append(save, cancel);
  let remove = null;
  if (existing) {
    remove = el('button', { type: 'button', class: 'btn-text admin-danger' }, 'Remove card');
    actions.append(el('span', { class: 'admin-actions__gap' }), remove);
  }
  form.append(actions);

  // The cards now showing, each with a way to take it down.
  const live = X.state.featured.cards.filter((c) => !existing || c.id !== existing.id);
  if (live.length) {
    const box = el('div', { class: 'admin-list' });
    box.append(el('h3', {}, 'Cards now in New & Upcoming'));
    const ul = el('ul');
    live.forEach((c) => {
      const li = el('li');
      li.append(el('span', {}, `${c.headline} (until ${c.until})`));
      const rm = el('button', { type: 'button', class: 'btn-text' }, 'Remove');
      rm.addEventListener('click', async () => {
        rm.disabled = true;
        const r = await api('save', { op: 'uncard', id: c.id });
        if (!r.ok) {
          rm.disabled = false;
          return note(form, r.error, 'error');
        }
        X.state.featured = r.featured;
        X.refresh();
        li.remove();
        toast('Card removed. It leaves the live site in about a minute.');
      });
      li.append(rm);
      ul.append(li);
    });
    box.append(ul);
    form.append(box);
  }

  cancel.addEventListener('click', () => d.close());
  if (remove) {
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      note(form, 'Removing…', 'busy');
      const r = await api('save', { op: 'uncard', id: existing.id });
      remove.disabled = false;
      if (!r.ok) return note(form, r.error, 'error');
      X.state.featured = r.featured;
      X.refresh();
      d.close();
      toast('Card removed. It leaves the live site in about a minute.');
    });
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const card = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value.trim()]));
    // A hidden field's words don't ride along.
    if (!isQuote()) card.who = card.role = '';
    else card.label = card.blurb = '';
    if (!card.headline) return note(form, isQuote() ? 'A card needs the quote.' : 'A card needs a title.', 'error');
    if (!card.until) return note(form, 'Pick the last day to show the card.', 'error');
    save.disabled = true;
    note(form, 'Saving…', 'busy');
    // A changed card replaces the old one in one checked save.
    const r = await api('save', { op: 'card', card, replace: existing ? existing.id : '' });
    save.disabled = false;
    if (!r.ok) return note(form, r.error, 'error');
    X.state.featured = r.featured;
    X.refresh();
    d.close();
    toast(existing ? 'Card saved. The live site shows it in about a minute.' : 'Card added. The live site shows it in about a minute.');
  });

  d.replaceChildren(form);
  d.showModal();
  inputs.headline.focus();
}

/* ---------- Hidden items ---------- */

function openHidden() {
  const d = makeDialog();
  const box = el('div', { class: 'admin-form' });
  box.append(el('h2', { id: 'admin-dlg-h' }, 'Hidden items'));
  const hidden = X.state.featured.hidden;
  if (!hidden.length) {
    box.append(el('p', {}, 'Nothing is hidden. "Hide from the site" in an item’s editor puts it here.'));
  } else {
    box.append(el('p', { class: 'admin-hint' }, 'These are off the site’s pages but still in its data file, which anyone can download. Use Delete for anything that must not be public.'));
    const ul = el('ul', { class: 'admin-list' });
    hidden.forEach((key) => {
      const it = findItem(key);
      const li = el('li');
      li.append(el('span', {}, it ? it.headline : key));
      const show = el('button', { type: 'button', class: 'btn-text' }, 'Show again');
      show.addEventListener('click', async () => {
        show.disabled = true;
        const r = await api('save', { op: 'unhide', key });
        if (!r.ok) {
          show.disabled = false;
          return toast(r.error);
        }
        X.state.featured = r.featured;
        X.refresh();
        li.remove();
        toast('Back on the site. The live site shows it in about a minute.');
      });
      li.append(show);
      ul.append(li);
    });
    box.append(ul);
  }
  const close = el('button', { type: 'button', class: 'btn-text' }, 'Close');
  close.addEventListener('click', () => d.close());
  box.append(el('div', { class: 'admin-actions' }, undefined));
  box.lastChild.append(close);
  d.replaceChildren(box);
  d.showModal();
  close.focus();
}

// Start last, once everything above is defined.
if (X) start();
