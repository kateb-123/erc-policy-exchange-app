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
    // The status rides along, so a form can tell a lapsed sign-in (401) apart.
    return data ? { status: res.status, ...data } : { ok: false, status: res.status, error: 'Something went wrong on our side. Try again in a minute.' };
  } catch {
    return { ok: false, error: "Couldn't reach the server. Check your connection and try again." };
  }
}

// The picture upload goes the old way, so it can report how far along it
// is; the answer looks like api()'s.
function uploadPicture(body, onProgress) {
  lastRenew = Date.now();
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/admin/save');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)));
    };
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      resolve(data ? { status: xhr.status, ...data } : { ok: false, status: xhr.status, error: 'Something went wrong on our side. Try again in a minute.' });
    };
    xhr.onerror = () => resolve({ ok: false, status: 0, error: "Couldn't reach the server. Check your connection and try again." });
    // A stalled upload gives up after a minute, so Save comes back (Oct 7
    // audit F110).
    xhr.timeout = 60 * 1000;
    xhr.ontimeout = () => resolve({ ok: false, status: 0, error: 'The picture took too long to send. Check your connection and try again.' });
    xhr.send(JSON.stringify(body));
  });
}

// The editor is for a laptop or desktop (Kate, Sep 24: no editing on a
// phone); at phone widths it doesn't load at all.
const PHONE = '(max-width: 780px)';
// Editing turns off after 10 minutes without use (Kate, Sep 24). A click or a
// key anywhere on the page is use; while there is use the sign-in is renewed
// at most once a minute, and after 10 quiet minutes the editor goes away and
// the sign-in ends. The server's sign-in lasts 11 minutes, so a click in the
// last minute always finds it on (Oct 7 audit F89).
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
  document.addEventListener('wheel', wheelAwake, { capture: true, passive: true });
  stayAwake();
}

// The door: the page with the password box. Only an editor's own screens
// link to it (the strip's warning, the sign-out toast, a form whose sign-in
// ran out), never the public pages.
const DOOR = '/2ujhtc8daz/';
let warnTimer = 0;
function stayAwake() {
  clearTimeout(idleTimer);
  clearTimeout(warnTimer);
  idleTimer = setTimeout(goQuiet, IDLE_MS);
  warnTimer = setTimeout(warnQuiet, IDLE_MS - 60 * 1000);
  const w = $('.admin-bar__warn');
  if (w) w.hidden = true;
  const t = $('.admin-toast');
  if (t && t.dataset.kind === 'warn') t.hidden = true;
  if (Date.now() - lastRenew > 60 * 1000) {
    api('session').then((s) => {
      if (!s.ok) goQuiet();
    });
  }
}
// Scrolling with the wheel or the trackpad is use too, looked at once a
// second at most; the sign-in is still renewed at most once a minute (Oct 7
// audit F111). Not the scroll event: the New & Upcoming list scrolls itself,
// which would keep editing on for good.
let lastWheel = 0;
function wheelAwake() {
  if (Date.now() - lastWheel < 1000) return;
  lastWheel = Date.now();
  stayAwake();
}
// A minute before the editor turns off, the strip says so (audit F35), and
// so does the message box at the foot, which stays in view when the strip
// has scrolled away (Oct 7 audit F111); any click or key keeps it on.
const WARN = 'Editing turns off in 1 minute. Click anywhere to keep editing.';
// An Undo on show is never covered: the strip still warns (review of F111).
const undoShowing = () => !!$('.admin-toast:not([hidden]) .admin-toast__undo');
function warnQuiet() {
  const w = $('.admin-bar__warn');
  if (w) w.hidden = false;
  if (!undoShowing()) toast(WARN, { stay: true, kind: 'warn' });
}

function goQuiet() {
  clearTimeout(idleTimer);
  clearTimeout(warnTimer);
  ['pointerdown', 'keydown'].forEach((ev) => document.removeEventListener(ev, stayAwake, true));
  document.removeEventListener('wheel', wheelAwake, { capture: true });
  if (observer) observer.disconnect();
  // A form with changes in it stays open, with a way to sign in beside it
  // (audit F35); an untouched one closes.
  const keep = dialog && dialog.open && $('.admin-confirm[data-guard]', dialog)?.dirty;
  if (dialog && dialog.open && !keep) dialog.close();
  document.querySelectorAll('.admin-bar, .admin-edit').forEach((n) => n.remove());
  document.documentElement.classList.remove('admin-on');
  api('logout', {});
  if (keep) {
    const form = $('form', dialog);
    if (form) noteSignIn(form);
  }
  // An Undo on show stays: its retry says how to sign in again.
  if (!undoShowing()) toast('Editing turned off after 10 minutes without use.', { link: DOOR, linkText: 'Sign in again' });
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
// A toast goes after 6 seconds; one with a link or a button (Undo, Oct 7
// audit F90, F108) stays until it is dismissed or the next one comes, and
// one marked stay until the next one.
function toast(msg, { link, linkText, action, actionText, stay, kind, focus } = {}) {
  const t = $('.admin-toast');
  t.textContent = msg;
  t.hidden = false;
  t.dataset.kind = kind || '';
  clearTimeout(toastTimer);
  if (link) t.append(' ', el('a', { href: link, target: '_blank', rel: 'noopener' }, linkText));
  if (action) {
    // focus: the Undo takes the keyboard after a dialog closed (returnFocus
    // looks for it), and once pressed the focus goes on to the next Undo or
    // the strip, never to the page's start (review of F90, F108).
    const b = el('button', { type: 'button', class: 'admin-toast__undo', ...(focus ? { 'data-focus': true } : {}) }, actionText);
    b.addEventListener('click', async () => {
      b.disabled = true;
      await action();
      if (document.activeElement === document.body || !document.activeElement) {
        const next = $('.admin-toast:not([hidden]) .admin-toast__undo') || $('.admin-bar button');
        if (next) next.focus();
      }
    });
    t.append(' ', b);
    if (focus) b.focus();
  }
  if (link || action) {
    const x = el('button', { type: 'button', class: 'admin-toast__x', 'aria-label': 'Close' }, '×');
    x.addEventListener('click', () => (t.hidden = true));
    t.append(' ', x);
    return;
  }
  if (stay) return;
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, 6000);
}

/* ---------- The strip at the top ---------- */

function buildBar() {
  const bar = el('div', { class: 'admin-bar', role: 'region', 'aria-label': 'Editing' });
  bar.append(
    el('span', { class: 'admin-bar__on' }, 'Editing is on'),
    el('button', { type: 'button', 'data-admin': 'card' }, 'Add to New & Upcoming'),
    el('button', { type: 'button', 'data-admin': 'hidden' }, 'Hidden items'),
    el('button', { type: 'button', 'data-admin': 'out' }, 'Sign out'),
    // Not a live region: the message box says it aloud (Oct 7 audit F111).
    el('span', { class: 'admin-bar__warn', hidden: true }, WARN)
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
    const title = key.startsWith('card:') ? 'card' : (findItem(key) || {}).headline || 'item';
    const b = el('button', { type: 'button', class: 'admin-edit', 'aria-label': `Edit ${title}` }, 'Edit');
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
  ['subtype', 'Category', 'text', 'For example Working Paper or Texas.'],
  ['source', 'Source', 'text'],
  ['date', 'Date', 'day', 'For an event, the day it happens.'],
  ['deadline', 'Deadline', 'text', '2026-10-01, or "rolling".'],
  ['time', 'Time', 'text'],
  ['location', 'Location', 'text', 'The room, or Online; a room plus "and Zoom" or "and online" shows as both.'],
  ['authors', 'Authors', 'text'],
  ['medium', 'Medium', 'text', 'Radio, TV, newspaper, magazine.'],
  ['topic', 'Topic', 'text'],
  ['blurb', 'Summary', 'area'],
  ['infographic', 'Picture link', 'url', 'A direct link to a picture (ending .jpg, .png or .webp), or a Google Drive file.'],
];
// Which fields belong to which section; the rest stay out of the way
// (Kate, Sep 30: "why do we have authors for things that don't have authors?").
const ONLY_FOR = { deadline: ['opportunity'], time: ['event'], location: ['event'], authors: ['research', 'event'], medium: ['headline'] };
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
  // Every way out that is not Save goes through the open form's guard, which
  // asks first when something was typed (audit F34). A click on the backdrop
  // counts only when the press started there too, so a drag that ends on the
  // grey margin does not close the form.
  dialog.tryClose = () => (dialog.guard ? dialog.guard() : dialog.close());
  let downOnBackdrop = false;
  dialog.addEventListener('pointerdown', (e) => {
    downOnBackdrop = e.target === dialog;
  });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog && downOnBackdrop) dialog.tryClose();
  });
  // Escape: caught on the key itself, because the browser skips the dialog's
  // own cancel event when nothing has been clicked or typed since it opened.
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    dialog.tryClose();
  });
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    dialog.tryClose();
  });
  dialog.addEventListener('close', () => {
    dialog.guard = null;
  });
  return dialog;
}
// The guard for one open form: closes at once while nothing changed, and
// asks once something did. Returns the box the form has to append.
function closeGuard(d, form, extraButtons = []) {
  let dirty = false;
  const mark = () => (dirty = true);
  form.addEventListener('input', mark);
  form.addEventListener('change', mark);
  const box = el('div', { class: 'admin-confirm', 'data-guard': true, hidden: true });
  const go = el('button', { type: 'button', class: 'btn admin-danger-btn' }, 'Close without saving');
  const stay = el('button', { type: 'button', class: 'btn-text' }, 'Keep editing');
  box.append(el('p', {}, 'What you changed here will be lost.'), go, stay);
  go.addEventListener('click', () => d.close());
  stay.addEventListener('click', () => {
    box.hidden = true;
    (form.querySelector('input:not([type=hidden]):not([type=file]), textarea, select') || form).focus();
  });
  d.guard = () => {
    if (!dirty) return d.close();
    box.hidden = false;
    go.focus();
  };
  Object.defineProperty(box, 'dirty', { get: () => dirty });
  return box;
}
function note(form, msg, kind, link) {
  const p = $('.admin-note', form);
  p.textContent = msg || '';
  if (link) p.append(' ', el('a', { href: link.href, target: '_blank', rel: 'noopener' }, link.text));
  p.className = `admin-note${kind ? ` admin-note--${kind}` : ''}`;
  // An error is announced at once; a status line waits its turn.
  p.setAttribute('role', kind === 'error' ? 'alert' : 'status');
}
// A sign-in that ran out mid-edit: the form keeps everything typed and
// offers the door in a new tab; once signed in there, Save works here again
// (audit F35). then: what to click once signed in.
function noteSignIn(form, then = 'Save') {
  note(form, 'Your sign-in ran out.', 'error', { href: DOOR, text: `Sign in again in a new tab, then ${then}.` });
}
// A failed call: the sign-in case gets its link, the rest their message.
function fail(form, r, then) {
  if (r.status === 401) return noteSignIn(form, then);
  return note(form, r.error, 'error');
}
// An Undo that didn't go through says why and keeps its button, so it can
// be tried again (Oct 7 audit F90, F108).
function undoFailed(r, retry) {
  if (r.status === 401) {
    return toast('Your sign-in ran out.', { link: DOOR, linkText: 'Sign in again in a new tab, then Undo.', action: retry, actionText: 'Undo' });
  }
  toast(r.error, { action: retry, actionText: 'Undo' });
}
// A running count under a box. The house rule (Kate, Sep 30, the desk's
// rewrite prompt): titles 80 characters, summaries 180, so they fit every
// card; past 100 the card sets the title smaller and leaves out the summary.
const TITLE_MAX = 80;
const SUMMARY_MAX = 180;
function titleCount(input, text) {
  const hint = el('p', { class: 'admin-hint', id: `${input.id}-count` });
  const say = () => {
    const n = input.value.trim().length;
    hint.textContent = text
      ? text(n)
      : `${n} characters. Aim for ${TITLE_MAX} or fewer.`;
  };
  input.addEventListener('input', say);
  say();
  input.setAttribute('aria-describedby', `${input.getAttribute('aria-describedby') || ''} ${hint.id}`.trim());
  return hint;
}
// The checks a form can make before the save, the same rules the server
// keeps (audit F38). A failing field wears the error colour and says why
// under itself; Save waits until the marked fields are fixed.
const RULES = {
  link: (v) => (v && !/^https?:\/\/\S+$/i.test(v) ? 'The link needs to start with http:// or https://.' : ''),
  picture: (v) =>
    v && !(/^https?:\/\/\S+$/i.test(v) || /^assets\/pictures\/[a-z0-9-]+\.(jpe?g|png|webp)$/.test(v))
      ? 'The picture link needs to start with http:// or https://, or be a picture saved from your computer.'
      : '',
  date: (v) => (v && !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(v) ? 'Write the date as 2026-10-01, 2026-10 or 2026.' : ''),
};
// pairs: [input, rule, { onSave }]. Returns a function that checks them all,
// focuses the first one that fails, and says whether the form may be sent.
// An onSave rule (an empty title) is not checked when the box is left, only
// on Save, so a new card's empty Title is not marked before it is typed in.
function fieldChecks(pairs) {
  const check = (input, rule) => {
    const msg = rule(input.value.trim());
    let p = input.parentElement.querySelector('.admin-field__error');
    if (!p) {
      p = el('p', { class: 'admin-field__error', id: `${input.id}-err`, hidden: true });
      input.after(p);
    }
    p.textContent = msg;
    p.hidden = !msg;
    const desc = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter((x) => x && x !== p.id);
    if (msg) {
      input.setAttribute('aria-invalid', 'true');
      desc.unshift(p.id);
    } else {
      input.removeAttribute('aria-invalid');
    }
    input.setAttribute('aria-describedby', desc.join(' '));
    return !msg;
  };
  pairs.forEach(([input, rule, opt]) => {
    if (!opt?.onSave) input.addEventListener('blur', () => check(input, rule));
    // Once marked, the mark goes as soon as the value is right.
    input.addEventListener('input', () => input.getAttribute('aria-invalid') && check(input, rule));
  });
  return () => {
    const bad = pairs.filter(([input, rule]) => !check(input, rule)).map(([input]) => input);
    if (bad.length) bad[0].focus();
    return !bad.length;
  };
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

// A picture goes at most 1200 px on its long side, as WebP (Oct 7 audit
// F92): no card draws one wider. One already that small and lighter than
// its WebP goes as it is, and so does any picture in a browser that can't
// write WebP.
const PICTURE_SIDE = 1200;
async function shrinkPicture(f) {
  const img = await createImageBitmap(f);
  const scale = Math.min(1, PICTURE_SIDE / Math.max(img.width, img.height));
  const canvas = el('canvas', { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  img.close();
  const webp = await new Promise((res) => canvas.toBlob(res, 'image/webp', 0.82));
  if (!webp || webp.type !== 'image/webp' || (scale === 1 && f.size <= webp.size)) return { blob: f, name: f.name };
  return { blob: webp, name: f.name.replace(/\.[^.]+$/, '') + '.webp' };
}
const readBase64 = (blob) =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });

// A picture from her computer (Kate, Sep 30): read it, send it, and put the
// path it was saved under into the picture link box beside it.
function pictureUpload(linkInput) {
  const wrap = el('div', { class: 'admin-upload' });
  const input = el('input', { type: 'file', id: `${linkInput.id}-file`, accept: 'image/jpeg,image/png,image/webp' });
  const label = el('label', { for: input.id, class: 'btn-text admin-upload__btn' }, 'Or choose a picture from your computer');
  const say = el('span', { class: 'admin-hint', role: 'status' });
  // What the upload says: a percentage while it runs, red when it fails
  // (audit F39). The form's Save waits until it is done.
  const tell = (msg, bad) => {
    say.textContent = msg;
    say.classList.toggle('admin-note--error', !!bad);
  };
  const saveBtn = () => linkInput.form && linkInput.form.querySelector('button[type="submit"]');
  input.addEventListener('change', async () => {
    const f = input.files[0];
    if (!f) return;
    tell('Saving the picture… 0%');
    const btn = saveBtn();
    if (btn) btn.disabled = true;
    // However it ends, Save comes back and the same file can be picked
    // again (Oct 7 audit F110).
    const end = (msg, bad) => {
      input.value = '';
      if (btn) btn.disabled = false;
      tell(msg, bad);
    };
    let pic;
    try {
      // One that can't be drawn goes as it is; one that can't be read fails.
      pic = await shrinkPicture(f).catch(() => ({ blob: f, name: f.name }));
      pic.data = await readBase64(pic.blob);
    } catch {
      return end("Couldn't read that picture. Download it from Drive first, or pick another.", true);
    }
    // The 3 MB line is for what is sent, after the shrink.
    if (pic.blob.size > 3 * 1024 * 1024) return end('That picture is over 3 MB. Make it smaller first.', true);
    const r = await uploadPicture({ op: 'picture', name: pic.name, type: pic.blob.type, data: pic.data }, (pct) => tell(`Saving the picture… ${pct}%`));
    if (!r.ok) return end(r.status === 401 ? 'Your sign-in ran out. Sign in again in a new tab, then pick the picture again.' : r.error, true);
    linkInput.value = r.path;
    linkInput.dispatchEvent(new Event('input', { bubbles: true }));
    end('Picture saved. Save this form to use it.');
  });
  wrap.append(input, label, say);
  return wrap;
}

// When a dialog closes, focus goes back to the button that opened it, or to
// the Edit sticker of the item just saved (the rows are redrawn on save, so
// the old sticker is gone), or to the strip (audit F42).
function returnFocus(d, opener, where) {
  d.addEventListener(
    'close',
    () =>
      setTimeout(() => {
        const t = $('.admin-toast:not([hidden]) .admin-toast__undo[data-focus]') || (where && where()) || (opener && opener.isConnected && opener) || $('.admin-bar button');
        if (t) t.focus();
      }, 60),
    { once: true }
  );
}
const stickerFor = (key) => document.querySelector(`[data-key="${CSS.escape(key)}"] .admin-edit`);

function openItem(key) {
  const item = findItem(key);
  if (!item) return toast("That item isn't in the page any more. Reload the page.");
  const d = makeDialog();
  let focusKey = key;
  returnFocus(d, document.activeElement, () => stickerFor(focusKey));
  const form = el('form', { class: 'admin-form admin-form--live', novalidate: true });
  form.append(el('h2', { id: 'admin-dlg-h' }, 'Edit item'));
  // The card itself, drawn live from the form (Kate, Sep 30: "always have a
  // wireframe on the cards, it is interactive"). Its id lets the site's own
  // card styles draw it; the real card comes first in the page, so the
  // site's lookups still find the real one.
  // Inert: the card's title is a real link, and it must not take the Tab
  // key or an Enter mid-edit (audit F37).
  // It is drawn at its real laptop size and shrunk as a whole, so every line
  // breaks where it does on the home page; "See it full size" shows it at
  // that size over the form (audit F74, Kate's pick D, Oct 7).
  const preview = el('div', { class: 'admin-preview' });
  const previewFrame = el('div', { class: 'admin-preview__frame' });
  const previewCard = el('div', { id: 'wn-feat', class: 'feat no-art admin-preview__card', inert: true });
  const fullBtn = el('button', { type: 'button', class: 'btn-text admin-preview__full' }, 'See it full size');
  // While it is full size the rest of the form is inert, so neither Tab nor
  // a click can reach a field under the card (review of audit F74).
  const showFull = (on) => {
    preview.classList.toggle('is-full', on);
    fullBtn.textContent = on ? 'Back to the form' : 'See it full size';
    for (const n of form.children) if (n !== preview) n.inert = on;
  };
  fullBtn.addEventListener('click', () => showFull(!preview.classList.contains('is-full')));
  // A click on the dimmed form, or Escape, goes back to the form, not out of it.
  preview.addEventListener('click', (e) => {
    if (e.target === preview) showFull(false);
  });
  // The dialog is reused, so this listener leaves with the form.
  const backOnEscape = (e) => {
    if (e.key !== 'Escape' || !preview.classList.contains('is-full')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    showFull(false);
  };
  d.addEventListener('keydown', backOnEscape, true);
  d.addEventListener('close', () => d.removeEventListener('keydown', backOnEscape, true), { once: true });
  previewFrame.append(previewCard);
  preview.append(previewFrame, fullBtn);
  form.append(preview);
  const grid = el('div', { class: 'admin-grid' });
  for (const [name, label, kind, hint] of FIELDS) {
    const id = `a-${name}`;
    let control;
    if (kind === 'area') {
      control = el('textarea', { id, name, rows: '6' });
    } else if (kind === 'type') {
      control = el('select', { id, name });
      SECTIONS.forEach(([v, l]) => control.append(el('option', { value: v }, l)));
    } else if (kind === 'day' && /^(\d{4}-\d{2}-\d{2})?$/.test(item[name] || '')) {
      // A date picker, like the pin's "until" (audit F41). A row that carries
      // only a year or a month keeps a text box, so that value is not lost.
      control = el('input', { id, name, type: 'date' });
    } else {
      control = el('input', { id, name, type: kind === 'url' ? 'url' : 'text', autocomplete: 'off' });
    }
    control.value = item[name] || '';
    const row = fieldRow(id, label, control, kind === 'day' && control.type === 'text' ? `Written 2026-10-01, or a year or month on its own. ${hint}` : hint);
    if (name === 'blurb' || name === 'headline' || name === 'infographic') row.classList.add('admin-field--wide');
    if (name === 'headline') row.append(titleCount(control));
    if (name === 'blurb') row.append(titleCount(control, (n) => `${n} characters. Aim for ${SUMMARY_MAX} or fewer.`));
    // The stars hint once, under Summary; it holds for the title too (audit F55).
    if (name === 'blurb') row.append(el('p', { class: 'admin-hint' }, 'Stars round a book or journal name, *like this*, show it in italics, in the title too.'));
    if (name === 'infographic') row.append(pictureUpload(control));
    if (ONLY_FOR[name]) row.dataset.onlyFor = ONLY_FOR[name].join(' ');
    grid.append(row);
  }
  form.append(grid);
  // An empty title is marked under its own box like the others (Oct 7
  // audit F114: it used to be reported by Save, a screen below).
  const checkAll = fieldChecks([
    [form.elements.headline, (v) => (v ? '' : 'An item needs a title.'), { onSave: true }],
    [form.elements.link, RULES.link],
    [form.elements.infographic, RULES.picture],
    [form.elements.date, RULES.date],
  ]);
  // An event's authors are its speakers, shown on the date panel card as
  // "With ..." (Kate, Oct 6).
  const authors = form.elements.authors;
  const authorsLabel = authors.closest('.admin-field').querySelector('label');
  const authorsHint = el('p', { class: 'admin-hint', id: 'a-authors-hint' });
  authors.closest('.admin-field').append(authorsHint);
  // The fields for this section only.
  const showFields = () => {
    const t = form.elements.type.value;
    grid.querySelectorAll('[data-only-for]').forEach((row) => (row.hidden = !row.dataset.onlyFor.split(' ').includes(t)));
    const speakers = t === 'event';
    authorsLabel.textContent = speakers ? 'Speakers' : 'Authors';
    authorsHint.textContent = speakers ? 'For example: Bob Pianta (UVA), Jinfa Cai (Texas A&M); moderated by Lori Taylor.' : '';
    authorsHint.hidden = !speakers;
    speakers ? authors.setAttribute('aria-describedby', authorsHint.id) : authors.removeAttribute('aria-describedby');
  };
  form.elements.type.addEventListener('change', showFields);
  showFields();

  const pin = pinOf(key);
  const pinBox = el('fieldset', { class: 'admin-pin' });
  pinBox.append(el('legend', {}, 'New & Upcoming'));
  const pinOn = el('input', { type: 'checkbox', id: 'a-pin' });
  pinOn.checked = !!pin;
  const pinUntil = el('input', { type: 'date', id: 'a-until', min: X.TODAY });
  pinUntil.value = pin ? pin.until : addDays(14);
  const onLabel = el('label', { class: 'admin-check', for: 'a-pin' });
  onLabel.append(pinOn, document.createTextNode(' Pin it'));
  pinBox.append(onLabel, fieldRow('a-until', 'Until', pinUntil));
  // The date only matters while the pin is on (audit F55).
  pinUntil.disabled = !pinOn.checked;
  pinOn.addEventListener('change', () => (pinUntil.disabled = !pinOn.checked));
  // The card it is drawn as there: Suggested (what fits what it has) first,
  // then the rest (Kate, Sep 24).
  // The card: two switches (Kate, Sep 30: "a checkbox for photo, a checkbox
  // for light/dark"). The picture's place is the section's own.
  const heroRow = (X.state.featured.heroes || []).find((h) => h.key === key) || {};
  const heroWas = heroRow.hero || '';
  const darkWas = !!heroRow.dark || heroWas === 'poster' || heroWas === 'wordsdark';
  const picWas = !(heroWas === 'words' || heroWas === 'wordsdark');
  const picOn = el('input', { type: 'checkbox', id: 'a-pic' });
  picOn.checked = picWas;
  const darkOn = el('input', { type: 'checkbox', id: 'a-dark' });
  darkOn.checked = darkWas;
  const picLabel = el('label', { class: 'admin-check', for: 'a-pic' });
  picLabel.append(picOn, document.createTextNode(' Show the picture'));
  const darkLabel = el('label', { class: 'admin-check', for: 'a-dark' });
  darkLabel.append(darkOn, document.createTextNode(' Dark card'));
  // With the picture on, where it goes and the size to make it (Kate, Sep 30).
  let places = picturePlaces((item.type || '').toLowerCase(), heroWas);
  places.hidden = !picOn.checked;
  picOn.addEventListener('change', () => (places.hidden = !picOn.checked));
  // The card's own words (Kate, Oct 6): a summary only this card shows.
  const summaryWas = heroRow.summary || '';
  const cardSum = el('textarea', { id: 'a-cardsum', rows: '3', maxlength: '600' });
  cardSum.value = summaryWas;
  // A pick from the desk's Highlight page may carry its own words and photo,
  // which the card shows first (Oct 23); the hint says so, so a change here is never a mystery.
  const deskWords = pin && (pin.title || pin.summary || pin.image);
  const cardSumRow = fieldRow('a-cardsum', 'Card summary', cardSum, deskWords
    ? "The desk's Highlight page set this card's words or photo; the card shows those first. Change them there."
    : 'Only the New & Upcoming card shows it, in place of the Summary.');
  cardSumRow.classList.add('admin-field--wide');
  cardSumRow.append(titleCount(cardSum, (n) => `${n} characters. Aim for 280 or fewer.`));
  // A headline's card shows no summary, so the box is not offered there.
  const sumFor = () => (cardSumRow.hidden = form.elements.type.value === 'headline');
  form.elements.type.addEventListener('change', sumFor);
  sumFor();
  pinBox.append(picLabel, darkLabel, places, cardSumRow);
  // A new section has its own places; the box is drawn again (audit F54).
  form.elements.type.addEventListener('change', () => {
    const fresh = picturePlaces(form.elements.type.value, places.value);
    fresh.hidden = places.hidden;
    places.replaceWith(fresh);
    places = fresh;
  });
  const tiles = {
    get value() {
      if (!picOn.checked) return 'words';
      return places.value;
    },
    get dark() {
      return darkOn.checked;
    },
  };
  const paint = () => {
    const it = { ...item };
    for (const [name] of FIELDS) it[name] = form.elements[name].value;
    const tab = X.NEWS_TABS.find((t) => t.value === (it.type || '').toLowerCase()) || { value: '', nav: 'ERC' };
    // The preview is the card as the site draws it: the desk's pin words first (js/pins.js).
    const pinned = pin && window.withPin ? window.withPin(it, pin) : { it, summary: '' };
    previewCard.innerHTML = X.heroCardHTML({ it: pinned.it, tab, hero: tiles.value, dark: tiles.dark, summary: pinned.summary || cardSum.value.trim() });
    previewCard.dataset.len = previewCard.querySelector('.hc')?.dataset.len || '';
  };
  form.addEventListener('input', paint);
  form.addEventListener('change', paint);
  paint();
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
  // "For good" sets it apart from Hide beside it (Oct 7 audit F108).
  confirmBox.append(
    el('p', {}, 'Delete this item for good? Its pin and card go with it. To take it off the site for now, use Hide.'),
    yes,
    no
  );
  form.append(confirmBox);
  // Hide sends none of what was typed, so with changes in the form it asks
  // first; an untouched form hides at once (Oct 7 audit F91).
  const hideBox = el('div', { class: 'admin-confirm', hidden: true });
  const hideYes = el('button', { type: 'button', class: 'btn admin-danger-btn' }, 'Hide it');
  const hideNo = el('button', { type: 'button', class: 'btn-text' }, 'Keep editing');
  hideBox.append(el('p', {}, 'Hide without saving your changes?'), hideYes, hideNo);
  form.append(hideBox);
  const guardBox = closeGuard(d, form);
  form.append(guardBox);

  const busy = (on) => [save, cancel, hide, del, yes, no, hideYes, hideNo].forEach((b) => (b.disabled = on));
  cancel.addEventListener('click', () => d.tryClose());
  del.addEventListener('click', () => {
    hideBox.hidden = true;
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
    if (!r.ok) return fail(form, r);
    const at = X.state.allItems.indexOf(item);
    X.state.allItems.splice(at, 1);
    if (r.featured) X.state.featured = r.featured;
    X.refresh();
    d.close();
    // Undo puts the row back, with its pin and card (Oct 7 audit F108).
    const undo = async () => {
      const back = await api('save', { op: 'restore', restore: r.restore });
      if (!back.ok) return undoFailed(back, undo);
      X.state.allItems.splice(Math.min(at, X.state.allItems.length), 0, item);
      if (back.featured) X.state.featured = back.featured;
      X.refresh();
      toast(
        back.lost
          ? "It's back on the site, but its pin and card didn't come back. Set them again with Edit."
          : 'Back on the site. The live site shows it in about a minute.'
      );
    };
    toast('Deleted. It leaves the live site in about a minute.', r.restore ? { action: undo, actionText: 'Undo', focus: true } : {});
  });

  const hideNow = async () => {
    busy(true);
    note(form, 'Hiding…', 'busy');
    const r = await api('save', { op: 'hide', key });
    busy(false);
    if (!r.ok) return fail(form, r);
    X.state.featured = r.featured;
    X.refresh();
    d.close();
    toast('Hidden. It leaves the live site in about a minute.');
  };
  hide.addEventListener('click', () => {
    if (!guardBox.dirty) return hideNow();
    confirmBox.hidden = true;
    hideBox.hidden = false;
    hideNo.focus();
  });
  hideYes.addEventListener('click', hideNow);
  hideNo.addEventListener('click', () => {
    hideBox.hidden = true;
    hide.focus();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fields = {};
    for (const [name] of FIELDS) {
      const control = form.elements[name];
      // A field the section hides is not sent (audit F54).
      if (control.closest('.admin-field')?.hidden) continue;
      const v = control.value.trim();
      if (v !== (item[name] || '')) fields[name] = v;
    }
    if (!checkAll()) return note(form, 'Fix the marked field first.', 'error');
    busy(true);
    note(form, 'Saving…', 'busy');
    // The item's key as it is now: after a save that changed the link, a
    // second try goes to the new one (review, Oct 6).
    let newKey = X.itemKey(item);
    const edited = Object.keys(fields).length > 0;
    const saved = (what) => (edited ? `The item saved, but ${what}` : `${what[0].toUpperCase()}${what.slice(1)}`);
    if (edited) {
      const r = await api('save', { op: 'edit', original: { ...item }, fields });
      if (!r.ok) {
        busy(false);
        return fail(form, r);
      }
      Object.assign(item, r.row);
      if (r.featured) X.state.featured = r.featured;
      newKey = X.itemKey(item);
      focusKey = newKey;
    }
    // The pin: add, move its date, or take it off.
    const had = pinOf(newKey);
    const want = pinOn.checked;
    if (want && (!had || had.until !== pinUntil.value)) {
      const r = await api('save', { op: 'pin', key: newKey, until: pinUntil.value });
      if (!r.ok) {
        busy(false);
        X.refresh();
        return note(form, `${saved("the pin didn't save")}: ${r.error}`, 'error');
      }
      X.state.featured = r.featured;
    } else if (!want && had) {
      const r = await api('save', { op: 'unpin', key: newKey });
      if (!r.ok) {
        busy(false);
        X.refresh();
        return note(form, `${saved("the pin didn't come off")}: ${r.error}`, 'error');
      }
      X.state.featured = r.featured;
    }
    // The hero card, if she changed it.
    const sumNow = cardSumRow.hidden ? summaryWas : cardSum.value.replace(/\s+/g, ' ').trim();
    if (tiles.value !== heroWas || tiles.dark !== darkWas || sumNow !== summaryWas) {
      const r = await api('save', { op: 'hero', key: newKey, hero: tiles.value, dark: tiles.dark, summary: sumNow, summary_was: summaryWas });
      if (!r.ok) {
        busy(false);
        X.refresh();
        return note(form, `${saved("the card choice didn't save")}: ${r.error}`, 'error');
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
  bandtop: '<svg viewBox="0 0 120 50" aria-hidden="true"><rect width="120" height="50" fill="#F6F6F6"/><rect width="120" height="22" fill="#A7A7A7"/><rect x="8" y="29" width="70" height="5" fill="#500000"/><rect x="8" y="37" width="40" height="3" fill="#3E3E3E"/><rect x="8" y="43" width="56" height="3" fill="#535353"/></svg>',
  band: '<svg viewBox="0 0 120 50" aria-hidden="true"><rect width="120" height="50" fill="#F6F6F6"/><rect width="120" height="2" fill="#500000"/><rect x="8" y="8" width="22" height="3" fill="#732F2F"/><rect x="8" y="14" width="70" height="5" fill="#500000"/><rect x="8" y="21" width="40" height="3" fill="#3E3E3E"/><rect y="28" width="120" height="22" fill="#A7A7A7"/></svg>',
  edit: '<svg viewBox="0 0 120 50" aria-hidden="true"><rect width="120" height="50" fill="#F6F6F6"/><rect x="8" y="10" width="62" height="6" fill="#500000"/><rect x="8" y="19" width="48" height="6" fill="#500000"/><rect x="8" y="31" width="56" height="3" fill="#3E3E3E"/><rect x="8" y="37" width="40" height="3" fill="#535353"/><rect x="8" y="43" width="24" height="3" fill="#535353"/><rect x="80" width="40" height="50" fill="#A7A7A7"/><circle cx="100" cy="19" r="7" fill="#F6F6F6"/><path d="M85 50 Q100 30 115 50Z" fill="#F6F6F6"/></svg>',
  poster: '<svg viewBox="0 0 120 50" aria-hidden="true"><rect width="120" height="50" fill="#500000"/><rect x="8" y="10" width="62" height="6" fill="#fff"/><rect x="8" y="19" width="48" height="6" fill="#fff"/><rect x="8" y="31" width="56" height="3" fill="#D6D3C4"/><rect x="8" y="37" width="40" height="3" fill="#D6D3C4"/><rect x="8" y="43" width="24" height="3" fill="#D6D3C4"/><rect x="80" width="40" height="50" fill="#A7A7A7"/><circle cx="100" cy="19" r="7" fill="#F6F6F6"/><path d="M85 50 Q100 30 115 50Z" fill="#F6F6F6"/></svg>',
  plainr: '<svg viewBox="0 0 120 50" aria-hidden="true"><rect width="120" height="50" fill="#fff"/><rect x="0.5" y="0.5" width="119" height="49" fill="none" stroke="#D1D1D1"/><rect x="8" y="10" width="70" height="6" fill="#3E3E3E"/><rect x="8" y="19" width="52" height="6" fill="#3E3E3E"/><rect x="8" y="29" width="60" height="4" fill="#500000"/><rect x="8" y="39" width="104" height="1.5" fill="#500000"/><rect x="8" y="43" width="44" height="3" fill="#535353"/></svg>',
  beside: '<svg viewBox="0 0 120 50" aria-hidden="true"><rect width="120" height="50" fill="#F6F6F6"/><rect x="0.5" y="0.5" width="119" height="49" fill="none" stroke="#D1D1D1"/><rect x="8" y="12" width="22" height="3" fill="#732F2F"/><rect x="8" y="19" width="56" height="5" fill="#500000"/><rect x="8" y="27" width="44" height="5" fill="#500000"/><rect x="8" y="37" width="36" height="3" fill="#3E3E3E"/><rect x="72" y="10" width="40" height="30" fill="#A7A7A7" stroke="#D1D1D1"/></svg>',
  photo: '<svg viewBox="0 0 120 50" aria-hidden="true"><rect width="120" height="50" fill="#D1D1D1"/><rect y="22" width="78" height="28" fill="#500000"/><rect x="6" y="28" width="24" height="3" fill="#D6D3C4"/><rect x="6" y="34" width="60" height="4" fill="#fff"/><rect x="6" y="41" width="44" height="4" fill="#fff"/></svg>',
  quote: '<svg viewBox="0 0 120 50" aria-hidden="true"><rect width="120" height="50" fill="#F6F6F6"/><rect x="0.5" y="0.5" width="119" height="49" fill="none" stroke="#D1D1D1"/><text x="6" y="20" font-family="Georgia,serif" font-size="22" font-weight="700" fill="#732F2F">“</text><rect x="7" y="22" width="62" height="3.5" fill="#500000"/><rect x="7" y="28" width="66" height="3.5" fill="#500000"/><rect x="7" y="34" width="40" height="3.5" fill="#500000"/><rect x="7" y="42" width="22" height="3" fill="#500000"/><rect x="80" width="40" height="50" fill="#A7A7A7"/><circle cx="100" cy="19" r="7" fill="#F6F6F6"/><path d="M85 50 Q100 30 115 50Z" fill="#F6F6F6"/></svg>',
};
// value, name, what it needs (in words)
const ITEM_CARDS = [
  ['edit', 'Research, light', 'grey; the title, then authors, journal and month; a portrait at the right if there is one'],
  ['poster', 'Research, dark', 'the same on maroon'],
  ['erc', 'ERC event', 'the words at the left, a portrait at the right'],
  ['date', 'Date panel', 'the day in a maroon panel, the words beside it'],
  ['type', 'Plain', 'the words on maroon, no picture'],
  ['band', 'Wide picture under', 'the words, then a wide strip of picture'],
  ['bandtop', 'Wide picture above', 'a wide strip of picture, then the words'],
  ['beside', 'Picture beside', 'the words at the left, a 16:9 picture at the right'],
  ['photo', 'Photo', 'the picture behind, the words in a maroon block'],
];
const ONEOFF_CARDS = []; // the Quote card is built but off the menu for now (Kate, Sep 30)
// The picture hint under a one-off card's picture link (the item dialog has
// its own, in FIELDS). Audit F33: the constant went missing in the Sep 30
// dialog rewrite and the card dialog died before it opened.
const PICTURE_HINTS = {
  auto: 'A direct link to a picture (ending .jpg, .png or .webp), a Google Drive file, or one from your computer. The whole card is 1200 x 500.',
  quote: 'A headshot, 400 x 500.',
};
const isPic = (url) => /\.(jpe?g|png|webp|gif|avif)$/i.test((url || '').trim());

// What Auto picks for an item, and which cards fit what it has.
function itemAuto(item) {
  const kind = (item.type || '').toLowerCase();
  const img = isPic(item.infographic);
  const date = /^\d{4}-\d{2}-\d{2}$/.test((item.date || '').trim());
  const auto =
    kind === 'event' ? (img ? 'erc' : date ? 'date' : 'type') : kind === 'research' ? 'edit' : kind === 'opportunity' ? (img ? 'beside' : 'type') : img ? 'photo' : 'type';
  const research = ['edit', 'poster', 'band', 'bandtop'];
  const fits = ITEM_CARDS.filter(([v]) =>
    kind === 'research' ? research.includes(v) : v === 'type' || (v === 'date' ? date : !['edit', 'poster'].includes(v) && img)
  ).map(([v]) => v);
  return { auto, fits };
}

// The card chooser, one card per category with its options (Kate, Sep 30:
// "group these, with options to add things"). Reads and sets like a select.
const LOOK = ['Look', [['light', 'Light', 'grey', 'edit'], ['dark', 'Dark', 'maroon', 'poster']]];
const PICKERS = {
  research: {
    name: 'Research card',
    groups: [LOOK, ['Picture', [['portrait', 'Beside, as a portrait', '', 'edit'], ['under', 'A wide strip under the words', '', 'band'], ['above', 'A wide strip above the words', '', 'bandtop'], ['none', 'None', 'the words alone', 'edit']]]],
    key: (o) => (o.picture === 'none' ? 'words' : o.picture === 'under' ? 'band' : o.picture === 'above' ? 'bandtop' : 'edit'),
    read: (k) => ({ picture: k === 'band' ? 'under' : k === 'bandtop' ? 'above' : k === 'words' || k === 'wordsdark' ? 'none' : 'portrait' }),
  },
  event: {
    name: 'Event card',
    groups: [LOOK, ['Picture', [['headshot', 'A headshot at the right', '4 wide by 5 tall', 'erc'], ['logo', 'A logo in a box', 'shown whole', 'date'], ['none', 'None', 'the words alone', 'date']]]],
    key: (o) => (o.picture === 'logo' ? 'date' : o.picture === 'none' ? 'words' : 'erc'),
    read: (k) => ({ picture: k === 'date' ? 'logo' : k === 'words' ? 'none' : 'headshot' }),
  },
  opportunity: {
    name: 'Opportunity card',
    groups: [LOOK, ['Picture', [['beside', 'Beside the words, 16:9', 'the title on top', 'beside'], ['under', 'A wide strip under the words', '', 'band'], ['above', 'A wide strip above the words', '', 'bandtop'], ['none', 'None', 'the words alone', 'type']]]],
    key: (o) => (o.picture === 'under' ? 'band' : o.picture === 'above' ? 'bandtop' : o.picture === 'none' ? 'words' : 'beside'),
    read: (k) => ({ picture: k === 'band' ? 'under' : k === 'bandtop' ? 'above' : k === 'words' ? 'none' : 'beside' }),
  },
  headline: {
    name: 'Headline card',
    groups: [LOOK, ['Picture', [['behind', 'Behind the words', 'the words in a maroon block', 'photo'], ['none', 'None', 'the words alone', 'type']]]],
    key: (o) => (o.picture === 'none' ? 'words' : 'photo'),
    read: (k) => ({ picture: k === 'words' ? 'none' : 'behind' }),
  },
};
// Where the picture goes on this section's card, drawn small with the size
// to make it; the first is what the card does on its own.
const PLACES = {
  research: [['', 'Beside, as a portrait', '400 x 500', 'edit'], ['band', 'A wide strip under the words', '1200 x 240', 'band'], ['bandtop', 'A wide strip above the words', '1200 x 240', 'bandtop']],
  event: [['', 'A headshot at the right', '400 x 500', 'erc'], ['date', 'A logo in a box', '400 x 200, shown whole', 'date']],
  opportunity: [['', 'Beside the words, 16:9', '960 x 540', 'beside'], ['band', 'A wide strip under the words', '1200 x 240', 'band'], ['bandtop', 'A wide strip above the words', '1200 x 240', 'bandtop']],
  headline: [['', 'Behind the words', '1200 x 500', 'photo']],
};
function picturePlaces(kind, current) {
  const opts = PLACES[kind] || PLACES.headline;
  // A fieldset, so a screen reader hears the group's name with each choice
  // (audit F55).
  const box = el('fieldset', { class: 'admin-tiles admin-tiles--item' });
  box.append(el('legend', { class: 'admin-tiles__h' }, 'Where the picture goes'));
  const grid = el('div', { class: 'admin-tiles__grid' });
  const known = opts.some(([v]) => v === current) ? current : '';
  opts.forEach(([v, name, size, art]) => {
    const tile = el('label', { class: 'admin-tile' });
    const r = el('input', { type: 'radio', name: 'c-place', value: v });
    r.checked = v === known;
    const pic = el('span', { class: 'admin-tile__art' });
    pic.innerHTML = ART[art] || ART.auto;
    tile.append(r, pic, el('span', { class: 'admin-tile__name' }, name), el('small', {}, size));
    grid.append(tile);
  });
  box.append(grid);
  Object.defineProperty(box, 'value', { get: () => ($('input[name="c-place"]:checked', box) || {}).value || '' });
  return box;
}
// The chooser: the category's card, its Look (light or dark) and its
// Picture. Reads like a select: .value is the card key, .dark the look.
function heroPicker(kind, current, dark) {
  const P = PICKERS[kind] || PICKERS.headline;
  const box = el('fieldset', { class: 'admin-tiles admin-tiles--item', id: 'c-hero' });
  box.append(el('legend', {}, P.name));
  const first = P.groups[1][1][0][0];
  const state = { look: dark || current === 'poster' || current === 'wordsdark' ? 'dark' : 'light', ...(current ? P.read(current) : { picture: first }) };
  P.groups.forEach(([title, opts]) => {
    const g = el('div', { class: 'admin-tiles__group' });
    g.append(el('span', { class: 'admin-tiles__h' }, title));
    const grid = el('div', { class: 'admin-tiles__grid' });
    opts.forEach(([v, name, desc, art]) => {
      const tile = el('label', { class: 'admin-tile' });
      const r = el('input', { type: 'radio', name: `c-${title.toLowerCase()}`, value: v });
      r.checked = state[title.toLowerCase()] === v;
      const pic = el('span', { class: 'admin-tile__art' });
      pic.innerHTML = ART[art] || ART.auto;
      tile.append(r, pic, el('span', { class: 'admin-tile__name' }, name), el('small', {}, desc));
      grid.append(tile);
    });
    g.append(grid);
    box.append(g);
  });
  const pick = (g) => ($(`input[name="c-${g}"]:checked`, box) || {}).value;
  Object.defineProperty(box, 'value', {
    // Auto (nothing saved) when the picture option is the first one.
    get: () => (pick('picture') === first ? '' : P.key({ picture: pick('picture') })),
  });
  Object.defineProperty(box, 'dark', { get: () => pick('look') === 'dark' });
  return box;
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
  returnFocus(d, document.activeElement, () => existing && stickerFor(`card:${existing.id}`));
  const form = el('form', { class: 'admin-form', novalidate: true });
  form.append(el('h2', { id: 'admin-dlg-h' }, existing ? 'Edit card' : 'Add to New & Upcoming'));
  form.append(
    el('p', { class: 'admin-hint' }, 'For an item already on the site, open it with Edit and pin it.')
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
  heroRow.append(inputs.hero);
  // One tile is no choice: the chooser waits until more cards are on the
  // menu (audit F55).
  heroRow.hidden = !ONEOFF_CARDS.length;
  const rows = [
    heroRow,
    fieldRow('c-headline', 'Title', inputs.headline),
    fieldRow('c-link', 'Link', inputs.link, 'Where the card goes when clicked.'),
    fieldRow('c-label', 'Label', inputs.label, 'The small word over the title, for example ERC or Announcement.'),
    fieldRow('c-until', 'Until', inputs.until),
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
        : `${n} characters. Aim for ${TITLE_MAX} or fewer.`
    )
  );
  rows[5].append(titleCount(inputs.blurb, (n) => `${n} characters. Aim for ${SUMMARY_MAX} or fewer.`));
  rows[5].classList.add('admin-field--wide');
  rows[6].classList.add('admin-field--wide');
  rows[6].append(pictureUpload(inputs.image));
  grid.append(...rows);
  const checkAll = fieldChecks([
    [inputs.headline, (v) => (v ? '' : isQuote() ? 'A card needs the quote.' : 'A card needs a title.'), { onSave: true }],
    [inputs.link, RULES.link],
    [inputs.image, RULES.picture],
  ]);
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
      // A removed card's row turns into "Removed." with Undo in place: a
      // message at the foot can't be clicked while this window is open.
      // Undo sends the same card back as a new one (Oct 7 audit F90).
      const showRow = (card) => {
        const rm = el('button', { type: 'button', class: 'btn-text' }, 'Remove');
        li.replaceChildren(el('span', {}, `${card.headline} (until ${card.until})`), rm);
        rm.addEventListener('click', async () => {
          rm.disabled = true;
          const r = await api('save', { op: 'uncard', id: card.id });
          if (!r.ok) {
            rm.disabled = false;
            return fail(form, r, 'Remove');
          }
          X.state.featured = r.featured;
          X.refresh();
          const undo = el('button', { type: 'button', class: 'btn-text' }, 'Undo');
          li.replaceChildren(el('span', {}, 'Removed.'), undo);
          undo.focus();
          toast('Card removed. It leaves the live site in about a minute.');
          undo.addEventListener('click', async () => {
            undo.disabled = true;
            const back = await api('save', { op: 'card', card, replace: '' });
            if (!back.ok) {
              undo.disabled = false;
              return fail(form, back, 'Undo');
            }
            X.state.featured = back.featured;
            X.refresh();
            showRow(back.featured.cards[0]); // a new card goes first
            $('button', li).focus();
            toast('Card back. The live site shows it in about a minute.');
          });
        });
      };
      showRow(c);
      ul.append(li);
    });
    box.append(ul);
    form.append(box);
  }

  form.append(closeGuard(d, form));
  // While a save runs, every way out waits for it, as in the item form
  // (Oct 7 audit F113).
  const busy = (on) => [save, cancel, remove].forEach((b) => b && (b.disabled = on));
  cancel.addEventListener('click', () => d.tryClose());
  if (remove) {
    remove.addEventListener('click', async () => {
      busy(true);
      note(form, 'Removing…', 'busy');
      const r = await api('save', { op: 'uncard', id: existing.id });
      busy(false);
      if (!r.ok) return fail(form, r);
      X.state.featured = r.featured;
      X.refresh();
      d.close();
      // Undo sends the same card back (Oct 7 audit F90).
      const undo = async () => {
        const back = await api('save', { op: 'card', card: existing, replace: '' });
        if (!back.ok) return undoFailed(back, undo);
        X.state.featured = back.featured;
        X.refresh();
        toast('Card back. The live site shows it in about a minute.');
      };
      toast('Card removed. It leaves the live site in about a minute.', { action: undo, actionText: 'Undo', focus: true });
    });
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const card = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value.trim()]));
    // A hidden field's words don't ride along.
    if (!isQuote()) card.who = card.role = '';
    else card.label = card.blurb = '';
    if (!checkAll()) return note(form, 'Fix the marked field first.', 'error');
    if (!card.until) {
      inputs.until.focus();
      return note(form, 'Pick the last day to show the card.', 'error');
    }
    busy(true);
    note(form, 'Saving…', 'busy');
    // A changed card replaces the old one in one checked save.
    const r = await api('save', { op: 'card', card, replace: existing ? existing.id : '' });
    busy(false);
    if (!r.ok) return fail(form, r);
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
  returnFocus(d, document.activeElement);
  const box = el('div', { class: 'admin-form' });
  box.append(el('h2', { id: 'admin-dlg-h' }, 'Hidden items'));
  const hidden = X.state.featured.hidden;
  if (!hidden.length) {
    box.append(el('p', {}, 'Nothing is hidden.'));
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
        note(box, 'Showing it again…', 'busy');
        const r = await api('save', { op: 'unhide', key });
        if (!r.ok) {
          show.disabled = false;
          return fail(box, r, 'Show again');
        }
        X.state.featured = r.featured;
        X.refresh();
        li.remove();
        note(box, 'Back on the site. The live site shows it in about a minute.');
      });
      li.append(show);
      ul.append(li);
    });
    // This window's own message line: the one at the foot sits under its
    // grey veil and can't be clicked (Oct 7 audit F109).
    box.append(ul, el('p', { class: 'admin-note', role: 'status' }));
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
