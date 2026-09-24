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
  ['infographic', 'Picture or infographic link', 'url', 'A direct link to a picture (ending .jpg or .png), or a Google Drive file.'],
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
function titleCount(input) {
  const hint = el('p', { class: 'admin-hint', id: `${input.id}-count` });
  const say = () => {
    const n = input.value.trim().length;
    hint.textContent = `${n} characters. Aim for 100 or fewer: longer titles show smaller in New & Upcoming, with no summary.`;
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
    headline: el('input', { id: 'c-headline', type: 'text', autocomplete: 'off' }),
    link: el('input', { id: 'c-link', type: 'url', autocomplete: 'off' }),
    label: el('input', { id: 'c-label', type: 'text', autocomplete: 'off', maxlength: '40' }),
    until: el('input', { id: 'c-until', type: 'date', min: X.TODAY }),
    blurb: el('textarea', { id: 'c-blurb', rows: '4' }),
    image: el('input', { id: 'c-image', type: 'url', autocomplete: 'off' }),
  };
  inputs.headline.value = existing ? existing.headline : '';
  inputs.link.value = existing ? existing.link : '';
  inputs.label.value = existing ? existing.label : 'ERC';
  inputs.until.value = existing ? existing.until : addDays(14);
  inputs.blurb.value = existing ? existing.blurb : '';
  inputs.image.value = existing ? existing.image : '';
  const rows = [
    fieldRow('c-headline', 'Title', inputs.headline),
    fieldRow('c-link', 'Link', inputs.link, 'Optional. Where the card goes when clicked.'),
    fieldRow('c-label', 'Label', inputs.label, 'The small word over the title, for example ERC or Announcement.'),
    fieldRow('c-until', 'Show until', inputs.until),
    fieldRow('c-blurb', 'Summary', inputs.blurb),
    fieldRow('c-image', 'Picture link', inputs.image, 'Optional. A direct link to a picture ending .jpg or .png.'),
  ];
  rows[0].classList.add('admin-field--wide');
  rows[0].append(titleCount(inputs.headline));
  rows[4].classList.add('admin-field--wide');
  rows[5].classList.add('admin-field--wide');
  grid.append(...rows);
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
    if (!card.headline) return note(form, 'A card needs a title.', 'error');
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
