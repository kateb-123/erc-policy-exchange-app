/* ============================================================
 * app.js — ERC Policy Exchange
 * ============================================================
 * A filterable feed of education opportunities, new policy
 * research, headlines, and upcoming (non-ERC) events. Everything
 * is CSV-driven: edit data/news.csv, reload, done.
 *
 * Interaction: category tabs across the top pick the stream; the
 * Quick Search buttons refine within it. Rows expand
 * in place; the feed is sorted newest-first.
 *
 * Deep-link params (so a newsletter can link straight to a view):
 *   ?type=opportunity   category tab (opportunity/research/headline/event)
 *   ?subtype=…          sub-category filter
 *   ?q=teacher          keyword search
 * ============================================================ */

const NEWS_CSV = "data/news.csv";
// The admin door's pins, one-off cards and hidden items (Kate, Sep 23).
const FEATURED_JSON = "data/featured.json";

// Category tabs across the top — you view one stream at a time (the
// categories are distinct enough that a mixed "All" view isn't useful).
// These mirror the ERC newsletter's timely sections.
// label = full name (feed/section header); nav = short top-nav label;
// icon = a file under assets/ (the Aggie UX glyphs from the Claude Design
// handoff), shown on the landing card via CSS mask — swap the file to change it.
const NEWS_TABS = [
  {
    value: "research",
    label: "New Education Policy Research",
    nav: "Research",
    icon: "aggie/book-open.svg",
    desc: "New working papers, peer-reviewed studies, and reports.",
  },
  {
    value: "event",
    label: "Upcoming Events",
    nav: "Events",
    icon: "aggie/calendar.svg",
    desc: "Webinars, forums, and conferences on education policy from organizations across the country.",
  },
  {
    value: "opportunity",
    label: "Opportunities",
    nav: "Opportunities",
    icon: "aggie/hand-holding-dollar.svg",
    desc: "Fellowships, grants, and calls for proposals relevant to education researchers.",
  },
  {
    value: "headline",
    label: "Education Headlines",
    nav: "Headlines",
    icon: "aggie/newspaper.svg",
    desc: "News about Texas and national education policy from outlets across the state and country.",
  },
];

// Today (YYYY-MM-DD) in College Station, not UTC and not the reader's own
// clock. The ERC's day is what these dates mean: read in UTC, an event on the
// 22nd disappears at 7pm Texas time while the day is still going. Upcoming
// Events drop off automatically once their date passes, so the feed stays
// current with no manual pruning.
const ERC_TIMEZONE = "America/Chicago";
const ercDate = (when = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: ERC_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(when);
const TODAY = ercDate();
const isPastEvent = (it) =>
  (it.type || "").toLowerCase() === "event" && (it.date || "") < TODAY;

// News older than this (60 days back) has aged out. Headlines phase out of the
// site entirely (they're time-sensitive); Research instead moves to the
// Archive view on its tab, so nothing scholarly is ever lost. An undated
// headline can't prove it's fresh, so it ages out too.
const CUTOFF = (() => {
  const d = new Date();
  d.setDate(d.getDate() - 60);
  return ercDate(d);
})();
const isStaleHeadline = (it) =>
  (it.type || "").toLowerCase() === "headline" && (it.date || "") < CUTOFF;
// A partial date counts as the last day it could mean, so a paper dated only
// "2026" is not filed as the oldest thing on the site. The ERC's own research
// never moves to the Archive (Kate, Sep 23: it all belongs on the Research tab).
const endOfPeriod = (d) =>
  /^\d{4}$/.test(d) ? `${d}-12-31` : /^\d{4}-\d{2}$/.test(d) ? `${d}-31` : d;
const isArchivedResearch = (it) =>
  (it.type || "").toLowerCase() === "research" &&
  (it.subtype || "").trim().toLowerCase() !== "erc research" &&
  endOfPeriod(it.date || "") < CUTOFF;

// An item's key: its link, or its title and date when it has none. The admin
// door keeps pins and hidden items by it (api/_admin.js has the same rule).
const itemKey = (it) =>
  (it.link || "").trim() || `${(it.headline || "").trim()}|${(it.date || "").trim()}`;
// Items the admin hid stay in the file but leave the site.
const visibleItems = () => state.allItems.filter((it) => !state.featured.hidden.includes(itemKey(it)));

// Feeds reveal this many rows at a time ("Show more" pages in the rest).
const PAGE_SIZE = 15;

// Single source of truth for what's shown.
const state = {
  items: [],
  view: "home", // "home" (landing page) | "section" (a category feed)
  type: NEWS_TABS[0].value, // active category (when view === "section")
  subtype: "all", // sub-category filter (scoped to the active category)
  archive: false, // Research only: show the 60-day+ archive instead of fresh
  shown: PAGE_SIZE, // rows revealed so far in the current list
  q: "",
  sort: null, // {key,dir} once a sort action is chosen; null = per-tab default
  searchFrom: null, // where to return when the global search box is cleared
  allItems: [], // every row of the sheet, hidden ones included
  featured: { pins: [], cards: [], hidden: [] }, // the admin door's file
  briefFrom: null, // the view a brief was opened from, for its way back
  ready: false, // true once the data is in and the page's handlers are live
};

/* ------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// One Font Awesome icon (solid, Free, same set as the Content Desk). Decorative:
// the neighbouring text carries the meaning, so every icon is aria-hidden.
function faIcon(name, extraClass = "") {
  return `<i class="fa-solid fa-${name}${extraClass ? ` ${extraClass}` : ""}" aria-hidden="true"></i>`;
}

// Format an ISO date (YYYY-MM-DD) as e.g. "Jun 30, 2026". Partial dates from
// the sheet degrade gracefully: "2026-07" -> "Jul 2026", "2026" -> "2026".
function formatDate(iso) {
  if (!iso) return "";
  const parts = iso.split("-");
  if (parts.length === 2) {
    const d = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
    return isNaN(d) ? iso : d.toLocaleDateString("en-US", { year: "numeric", month: "short" });
  }
  if (parts.length !== 3) return iso;
  const [y, m, d] = parts.map(Number);
  const date = new Date(y, m - 1, d); // local time; avoids TZ off-by-one
  if (isNaN(date)) return iso;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// Search matches words, not one run of letters (Sep 23 audit: "Texas
// vouchers" found nothing and "AI" found "said"). Every word of the query has
// to start a word somewhere in the item, in any order, so "vouchers" also
// finds "voucher". A word of three letters or fewer has to match a whole word,
// so "AI" no longer finds "aid". Case, accents and curly quotes don't matter.
const fold = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019\u02bc]/g, "'");
const stem = (w) =>
  w.length <= 4
    ? w
    : /(ss|x|z|ch|sh)es$/.test(w)
      ? w.slice(0, -2)
      : /ies$/.test(w)
        ? w.slice(0, -3)
        : /[^s]s$/.test(w)
          ? w.slice(0, -1)
          : w;
function searchTerms(q) {
  return fold(q)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => new RegExp(w.length <= 3 ? `\\b${w}\\b` : `\\b${stem(w)}`));
}
const hasAll = (text, terms) => {
  const t = fold(text);
  return terms.every((re) => re.test(t));
};

// Interpret an Opportunity's `deadline` cell.
//   "2026-07-29" → a firm date: sortable, expirable, shows "Due Jul 29, 2026".
//   "rolling"    → shows "Rolling"; never sorts to the top, never expires.
//   "Fall 2026"  → any other free text: shown verbatim, treated like rolling.
//   ""           → no deadline shown; treated like rolling.
function parseDeadline(raw) {
  const v = (raw || "").trim();
  if (!v) return { iso: "", label: "", firm: false };
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return { iso: v, label: `Due ${formatDate(v)}`, firm: true };
  }
  const label = v.toLowerCase() === "rolling" ? "Rolling" : v;
  return { iso: "", label, firm: false };
}

// True once a firm opportunity deadline has passed (mirrors past-event drop-off).
const isPastDeadline = (it) => {
  if ((it.type || "").toLowerCase() !== "opportunity") return false;
  const d = parseDeadline(it.deadline);
  return d.firm && d.iso < TODAY;
};

// A dated item that has aged out of the feed entirely (past event, past
// deadline, or a headline past the 60-day window). Archived research is NOT
// expired — it stays searchable and lives in the Research tab's Archive view.
const isExpired = (it) => isPastEvent(it) || isPastDeadline(it) || isStaleHeadline(it);

/* ------------------------------------------------------------
 * URL <-> state
 * ------------------------------------------------------------ */
function readURL() {
  const p = new URLSearchParams(window.location.search);
  const type = (p.get("type") || "").toLowerCase();
  state.q = (p.get("q") || "").trim();
  // ?q= opens global search; a valid ?type= opens that section; anything else
  // is the landing page.
  if (NEWS_TABS.some((t) => t.value === type)) {
    state.type = type;
    state.view = "section";
  } else {
    state.view = "home";
  }
  if (state.q) state.view = "search";
  state.brief = null;
  const brief = (p.get("brief") || "").trim();
  if (brief) {
    state.view = "brief";
    state.brief = brief;
    state.type = "research"; // briefs belong to the Research section
  }
  state.subtype = p.get("subtype") || "all";
  state.archive = p.get("archive") === "1";
  // A chosen sort rides in the address (?sort=1), so Back and a shared link
  // keep it, and one section's sort never carries into another.
  const sorts = TOOLBAR_SORTS[state.type] || [];
  const si = Number(p.get("sort"));
  state.sort = si > 0 && sorts[si] ? sorts[si] : null;
}

// push = a new history entry (view or section changes, so Back returns here);
// otherwise the current entry is rewritten (filters, sort, search keystrokes).
function writeURL(push = false) {
  const p = new URLSearchParams();
  // Search carries ?q=; a section carries ?type=; home is a clean URL.
  if (state.view === "search") {
    p.set("q", state.q.trim());
  } else if (state.view === "brief") {
    p.set("brief", state.brief);
  } else if (state.view === "section") {
    p.set("type", state.type);
    if (state.subtype !== "all") p.set("subtype", state.subtype);
    if (state.type === "research" && state.archive) p.set("archive", "1");
    const si = (TOOLBAR_SORTS[state.type] || []).indexOf(state.sort);
    if (si > 0) p.set("sort", String(si));
  }
  const qs = p.toString();
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  const current = window.location.pathname + window.location.search;
  if (push && url !== current) window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
}

/* ------------------------------------------------------------
 * Init
 * ------------------------------------------------------------ */
function init(rows, modified, featured) {
  state.allItems = rows;
  state.featured = featured;
  state.items = visibleItems();

  // Last update: when the CSV itself was last touched (the server's
  // Last-Modified, the last deploy that changed it). Fallback: the newest
  // research or headline date that isn't in the future; event dates and
  // deadlines are not publish dates.
  const LONG = { year: "numeric", month: "long", day: "numeric" };
  const mod = modified ? new Date(modified) : null;
  const newest = state.items
    .filter((it) => /^(research|headline)$/i.test(it.type || ""))
    .map((it) => it.date)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d || "") && d <= TODAY)
    .reduce((m, d) => (d > m ? d : m), "");
  const stamp =
    mod && !isNaN(mod)
      ? mod.toLocaleDateString("en-US", { ...LONG, timeZone: "America/Chicago" })
      : newest
        ? new Date(`${newest}T12:00:00`).toLocaleDateString("en-US", LONG)
        : "";
  $("#landing-updated").textContent = stamp ? `Last update: ${stamp}` : "";

  buildLanding();
  buildWhatsNew();
  validateSubtype();

  // Back and Forward: the URL is the source of truth, so re-read it and render.
  window.addEventListener("popstate", () => {
    readURL();
    validateSubtype();
    state.shown = PAGE_SIZE;
    state.searchFrom = null;
    state.briefFrom = null;
    $("#global-search").value = state.q;
    closeMenu();
    render();
    focusHeading();
  });

  // Global search (top strip): typing searches every section at once; clearing
  // returns to wherever you were (landing or a section).
  const gs = $("#global-search");
  const typedEarly = gs.value;
  gs.value = state.q;
  gs.addEventListener("input", (e) => {
    const q = e.target.value;
    const entering = !!q.trim() && state.view !== "search";
    state.shown = PAGE_SIZE; // a new query starts at the first page
    if (q.trim()) {
      if (state.view !== "search") {
        state.searchFrom = { view: state.view, type: state.type };
        state.view = "search";
      }
      state.q = q;
    } else {
      state.q = "";
      if (state.view === "search") {
        const back = state.searchFrom || { view: "home" };
        state.view = back.view;
        if (back.type) state.type = back.type;
      }
    }
    render();
    writeURL(entering);
  });
  // F11: Enter or a phone's Search key closes the keyboard over the results;
  // the results are already on the page.
  $("#global-search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    gs.blur();
  });

  // Card-tab toolbar: sort text actions + category "view" buttons. The
  // toolbar is rebuilt by render(), so afterwards we restore focus to the
  // equivalent new button (keyboard users would otherwise be dropped).
  $("#opp-toolbar").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sort], [data-subtype], [data-archive]");
    if (!btn) return;
    state.shown = PAGE_SIZE; // any toolbar change starts the list over
    if (btn.dataset.sort != null) {
      state.sort = TOOLBAR_SORTS[state.type][Number(btn.dataset.sort)] || null;
    } else if (btn.dataset.archive != null) {
      // Archive is a view switch, so the sub-category filter starts fresh
      // (fresh and archived research can have different sub-category mixes).
      state.archive = !state.archive;
      state.subtype = "all";
    } else if (btn.dataset.subtype != null) {
      // Clicking the active category pill again deselects it (same as Clear).
      state.subtype =
        btn.dataset.subtype === state.subtype ? "all" : btn.dataset.subtype;
      // Clear also backs out of the Archive view.
      if (btn.dataset.subtype === "all") state.archive = false;
    }
    render();
    writeURL();
    // The chips and the buttons carry the same data attributes; land on the
    // copy this width shows.
    const again = $$(
      btn.dataset.sort != null
        ? `[data-sort="${btn.dataset.sort}"]`
        : btn.dataset.archive != null
          ? "[data-archive]"
          : `[data-subtype="${CSS.escape(btn.dataset.subtype)}"]`,
      $("#opp-toolbar")
    ).find((el) => el.offsetParent !== null);
    if (again && !again.disabled) again.focus();
    else focusHeading();
  });

  // One delegated listener covers every feed row ever rendered: the caret
  // button toggles the detail, a click elsewhere on the row does the same
  // (bigger target), and link-only rows open their source.
  $("#news-list").addEventListener("click", (e) => {
    // "Show more": reveal the next page in place (works in sections + search).
    const moreBtn = e.target.closest("[data-more]");
    if (moreBtn) {
      // The list is rebuilt longer: rows the reader opened stay open, and
      // focus lands on the first new row, not on the next button below them.
      const before = state.shown;
      const open = $$('.feed-item[data-expanded="true"] .feed-expand', $("#news-list")).map((b) =>
        b.getAttribute("aria-controls")
      );
      state.shown += PAGE_SIZE;
      render();
      open.forEach((id) => {
        const b = $(`.feed-expand[aria-controls="${id}"]`);
        if (b) toggleDetail(b);
      });
      const first = $$("#news-list .feed-item, #news-list .ncard")[before];
      const target = first && first.querySelector("a[href], button");
      if (target) target.focus({ preventScroll: true });
      return;
    }
    const briefLink = e.target.closest("a[data-brief]");
    if (briefLink) {
      e.preventDefault();
      openBrief(briefLink.dataset.brief, briefLink.dataset.briefTitle);
      return;
    }
    if (e.target.closest(".brief__back")) {
      leaveBrief();
      return;
    }
    const caretBtn = e.target.closest(".feed-expand");
    if (caretBtn) {
      toggleDetail(caretBtn);
      return;
    }
    const row = e.target.closest(".feed-item__row");
    if (!row || e.target.closest("a")) return;
    const caret = row.querySelector(".feed-expand");
    if (caret) toggleDetail(caret);
    const linkItem = row.closest(".feed-item--link");
    if (linkItem && linkItem.dataset.briefRow) {
      openBrief(linkItem.dataset.briefRow, linkItem.dataset.briefTitle);
      return;
    }
    if (linkItem && linkItem.dataset.href) {
      window.open(linkItem.dataset.href, "_blank", "noopener");
    }
  });

  state.ready = true;
  render();
  // The admin door: a signed-in admin's browser carries a hint cookie, and
  // only then is the editor loaded; it asks the server before it shows
  // anything (Kate, Sep 23).
  window.Exchange = { state, itemKey, refresh, NEWS_TABS, TODAY };
  if (/(?:^|;\s*)exa_admin_on=1/.test(document.cookie)) import("./admin.js?v=5").catch(() => {});
  if (typedEarly.trim() && typedEarly !== state.q) {
    gs.value = typedEarly;
    gs.dispatchEvent(new Event("input"));
  }
}

// After an admin save the page redraws from the changed items and pins.
function refresh() {
  state.items = visibleItems();
  validateSubtype();
  buildLanding();
  buildWhatsNew();
  render();
}

// The phone Menu: the button opens and closes the panel; Escape and a tap
// outside the bar close it too. Wired in boot, so it works while the data
// is still on its way.
function wireMenu() {
  $("#menu-btn").addEventListener("click", () => {
    const open = $(".topnav").classList.toggle("is-open");
    $("#menu-btn").setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $(".topnav").classList.contains("is-open")) {
      closeMenu();
      $("#menu-btn").focus();
    }
  });
  document.addEventListener("click", (e) => {
    if ($(".topnav").classList.contains("is-open") && !e.target.closest(".topnav")) closeMenu();
  });
}

/* ------------------------------------------------------------
 * Top navigation + landing
 * ------------------------------------------------------------ */
// Build the top bar's section links. The site title beside them (static in
// index.html) is the Home link; Share an item and About the ERC sit on the
// right, static too.
function buildNav() {
  const el = $("#topnav");
  // Real links: every view has a URL, so middle-click, "open in new tab" and
  // copy-link all work, and screen readers hear "link". A plain click is
  // intercepted for the in-page route.
  el.innerHTML = NEWS_TABS.map(
    (t) => `
    <a class="topnav__link" href="?type=${t.value}" data-type="${t.value}">${esc(t.nav)}</a>`
  ).join("");

  el.addEventListener("click", (e) => {
    const link = e.target.closest(".topnav__link[data-type]");
    if (!link || modifiedClick(e) || !state.ready) return;
    e.preventDefault();
    setType(link.dataset.type);
  });
  $(".topnav__brand").addEventListener("click", (e) => {
    if (modifiedClick(e) || !state.ready) return;
    e.preventDefault();
    setHome();
  });
}

// Cmd/Ctrl/Shift-click or middle-click: let the browser open a new tab or window.
const modifiedClick = (e) => e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1;

// Build the landing-page section cards: glyph, title over the live count, chevron.
function buildLanding() {
  const el = $("#landing-cards");
  el.innerHTML = NEWS_TABS.map(
    (t) => `
    <a class="slab-btn" href="?type=${t.value}" data-type="${t.value}"><span class="slab-btn__icon" aria-hidden="true"></span><span class="slab-btn__name">${esc(t.nav)}</span> <small>${esc(countLabel(t.value))}</small>${faIcon("chevron-right", "slab-btn__go")}</a>`
  ).join("");

  if (el.dataset.wired) return;
  el.dataset.wired = "1";
  el.addEventListener("click", (e) => {
    const btn = e.target.closest(".slab-btn");
    if (!btn || modifiedClick(e)) return;
    e.preventDefault();
    setType(btn.dataset.type);
  });
}

/* ------------------------------------------------------------
 * New & upcoming (landing)
 * ------------------------------------------------------------
 * Claude Design handoff, home v2 (Sep 23, 2026): a featured card beside the
 * list that feeds it. The list is the index: picking a row shows it in the
 * card and stops the walk. Left alone, the list walks a row at a time and the
 * card follows. Arrows under the card step it by hand; phones hide the list.
 *
 * Kate's calls over the handoff (Sep 22 and 23): "New & upcoming" rather than
 * "What's New", since a conference deadline three weeks out is not new; and
 * 8 seconds a row rather than 4, since the card holds about 40 words.
 */
const WN_PER = 3; // items taken from each section
const WN_TURN_MS = 8000; // how long one item is held before the list moves on
const WN_FADE_MS = 250;
const wnWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The top few of a section, in the order that section's own feed opens in
// (soonest for Events, closing soon for Opportunities, newest elsewhere).
function whatsNewFeed(per = WN_PER) {
  const bags = NEWS_TABS.map((tab) => {
    const items = state.items.filter(
      (it) =>
        (it.type || "").toLowerCase() === tab.value &&
        !isExpired(it) &&
        !(tab.value === "research" && isArchivedResearch(it))
    );
    items.sort(sortComparator(TOOLBAR_SORTS[tab.value][0]));
    return items.slice(0, per).map((it) => ({ it, tab }));
  });
  // Round-robin, so the four sections share the box evenly and it is mixed by
  // construction rather than merged on date.
  const out = [];
  for (let i = 0; i < per; i++) bags.forEach((bag) => bag[i] && out.push(bag[i]));
  // The admin door's pins and one-off cards go first while their dates last
  // (Kate, Sep 23), then the round-robin; twelve in all, unless there are
  // more pins and cards than that.
  const tabOf = (it) => NEWS_TABS.find((t) => t.value === (it.type || "").toLowerCase());
  const pinned = state.featured.pins
    .filter((p) => (p.until || "") >= TODAY)
    .map((p) => state.items.find((it) => itemKey(it) === p.key))
    .filter((it) => it && !isExpired(it) && tabOf(it))
    .map((it) => ({ it, tab: tabOf(it) }));
  const cards = state.featured.cards
    .filter((c) => (c.until || "") >= TODAY)
    .map((c) => ({
      it: { headline: c.headline, link: c.link || "", blurb: c.blurb || "", infographic: c.image || "", card: c.id },
      tab: { value: "", nav: c.label || "ERC" },
    }));
  const front = [...pinned, ...cards];
  const taken = new Set(pinned.map((x) => itemKey(x.it)));
  const rest = out.filter((x) => !taken.has(itemKey(x.it)));
  return [...front, ...rest].slice(0, Math.max(per * NEWS_TABS.length, front.length));
}
// A New & upcoming entry's key: a one-off card's own id, else the item's.
const wnKey = ({ it }) => (it.card ? `card:${it.card}` : itemKey(it));

// Opportunities are judged on their deadline, everything else on its date.
const wnWhen = (it, tab) =>
  tab.value === "opportunity"
    ? parseDeadline(it.deadline).label
    : it.date
      ? formatDate(it.date)
      : "";

// A Drive link is a PDF viewer, not an image: only a direct image file can go
// in the card.
const wnImage = (it) => {
  const raw = (it.infographic || "").trim();
  return /\.(jpe?g|png|webp|gif|avif)$/i.test(raw) ? raw : "";
};

// Every picture runs under the text in one landscape frame, 1200 x 500 (Kate,
// Sep 24: "the landscape one looks best ... that will be the only
// dimensions. under."). Each picture is loaded once; one that will not load
// stays out of the card.
const wnShapes = new Map();
function wnShape(url) {
  if (!url) return Promise.resolve("");
  if (!wnShapes.has(url))
    wnShapes.set(
      url,
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve("wide");
        img.onerror = () => resolve("");
        img.src = url;
      })
    );
  return wnShapes.get(url);
}

// The featured title's length class: the card's type steps down as the
// title gets longer so it always shows whole (Kate, Sep 24; styles.css).
const wnLen = (it) => {
  const n = (it.headline || "").trim().length;
  return n <= 60 ? "short" : n <= 100 ? "mid" : "long";
};

// The headline is a card's one way out: a brief opens in the site, an item at
// its source, a one-off card with no link in its section, if it has one. No
// new-tab icon on the scrolling card (Kate, Sep 24); screen readers still hear it.
function wnTitleLink({ it, tab }) {
  const title = esc(it.headline);
  const id = briefId(it);
  const link = (it.link || "").trim();
  return id
    ? `<a href="?brief=${id}" data-brief="${id}" data-brief-title="${title}">${title}</a>`
    : link
      ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${title}${NEW_TAB}</a>`
      : tab.value
        ? `<a href="?type=${tab.value}" data-type="${tab.value}">${title}</a>`
        : `<span class="feat__plain">${title}</span>`;
}

function wnFeatHTML({ it, tab }, shape) {
  const a = wnTitleLink({ it, tab });
  // Source and date share one line: a long source gives way, the date (or
  // an opportunity's deadline) never does.
  const from = (it.source || "").trim();
  const when = wnWhen(it, tab);
  const sub =
    (from ? `<span class="feat__from">${esc(from)}</span>` : "") +
    (when ? `<span class="feat__when">${from ? "&nbsp;• " : ""}${esc(when)}</span>` : "");
  const blurb = cleanBlurb(it.blurb);
  const sec = `<p class="feat__sec">${esc(tab.nav)}</p>`;
  const txt = `
    <div class="feat__txt">
      <h3>${a}</h3>
      ${sub ? `<p class="feat__src">${sub}</p>` : ""}
      ${blurb ? `<p class="feat__b">${esc(blurb)}</p>` : ""}
    </div>`;
  if (!shape) return sec + txt;
  // The picture is decorative: the headline names the talk and the speaker.
  const fig = `<figure class="feat__media"><img src="${esc(wnImage(it))}" alt=""></figure>`;
  return sec + txt + fig;
}

/* ---------- Hero cards (Kate's 1200 x 500 designs, Sep 24) ----------
   On laptops New & Upcoming shows each item as one of her dark card
   templates, drawn with real text in a 12:5 frame that scales with the page
   (styles.css .hc). The item picks the template: an event with a photo is
   the ERC card (a 4:5 portrait on the right), any other dated event the date
   panel, research with a picture the landscape band, a headline or one-off
   card with a picture the photo with a maroon block, and the rest the
   type-only card. A card that could hold a photo but has none also carries
   that photo layout with an empty slot, shown only to a signed-in editor
   (html.admin-on), so she sees where a picture would go; visitors never see
   an empty slot. */
const HC_SUPER = { research: "New research", event: "Upcoming event", opportunity: "Opportunity", headline: "Headlines" };
const hcDate = (iso) => {
  const [y, m, d] = (iso || "").split("-").map(Number);
  return y && m && d ? new Date(Date.UTC(y, m - 1, d)) : null;
};
const hcFmt = (date, opts) => date.toLocaleDateString("en-US", { timeZone: "UTC", ...opts });
const hcLine = (parts) => parts.filter(Boolean).map(esc).join(" · ");

function heroCardHTML(entry) {
  const { it, tab } = entry;
  const kind = tab.value;
  const img = wnImage(it);
  const src = (it.source || "").trim();
  const date = hcDate(it.date);
  const erc = kind === "event" && (/^erc\b/i.test(it.subtype || "") || src === "ERC" || /^ERC\b/.test(it.headline || ""));
  const sup = esc(kind ? (erc ? "ERC event" : HC_SUPER[kind]) : tab.nav || "ERC");
  const head = `<p class="hc__sup">${sup}</p><h3 class="hc__ttl">${wnTitleLink(entry)}</h3>`;
  const pic = (url, cls, label) =>
    url
      ? `<figure class="hc__img ${cls}"><img src="${esc(url)}" alt=""></figure>`
      : `<div class="hc__img ${cls} hc__slot"><span>${label}</span></div>`;
  const deadline = parseDeadline(it.deadline).label.replace(/^Due /, "");
  const meta =
    kind === "research"
      ? hcLine([src, date && hcFmt(date, { month: "long", year: "numeric" })])
      : kind === "opportunity"
        ? hcLine([src, deadline && (deadline === "Rolling" ? "Rolling deadline" : `Apply by ${deadline}`)])
        : kind === "headline" || kind === "event"
          ? hcLine([src, date && formatDate(it.date)])
          : esc(cleanBlurb(it.blurb).slice(0, 140));
  const when = date
    ? hcLine([hcFmt(date, { weekday: "long", month: "long", day: "numeric" }), (it.time || "").trim()])
    : "";

  const ercV = (url) => `
    <div class="hc__v hc-erc${url ? "" : " hc__v--slot"}"><div class="hc__col">${head}
      <p class="hc__meta">${hcLine([src === "ERC" ? "Education Research Center" : src])}<br>${hcLine([
        date && hcFmt(date, { weekday: "long", month: "long", day: "numeric" }),
        (it.time || "").trim(),
        (it.location || "").trim(),
      ])}</p></div>${pic(url, "hc__img--pt", "Portrait 4:5")}</div>`;
  const dateV = () => `
    <div class="hc__v hc-date"><div class="hc__panel" aria-hidden="true"><span class="hc__k">Upcoming</span>
      <span class="hc__m">${esc(hcFmt(date, { month: "short" }))}</span><span class="hc__d">${date.getUTCDate()}</span></div>
      <div class="hc__col">${head}<p class="hc__meta">${hcLine([src, (it.location || "").trim() || "Online"])}<br>${when}</p></div></div>`;
  const typeV = () => `
    <div class="hc__v hc-type"><div class="hc__dots" aria-hidden="true"></div>${head}<p class="hc__meta">${meta}</p></div>`;
  const bandV = (url) => `
    <div class="hc__v hc-band${url ? "" : " hc__v--slot"}"><div class="hc__col">${head}<p class="hc__meta">${meta}</p></div>${pic(url, "hc__img--band", "Landscape photo")}</div>`;
  const photoV = (url) => `
    <div class="hc__v hc-photo${url ? "" : " hc__v--slot"}">${pic(url, "hc__img--full", "Photo 1200 x 500")}
      <div class="hc__blk">${head}<p class="hc__meta">${meta}</p></div></div>`;

  let main;
  let slot = "";
  if (kind === "event") {
    main = img ? ercV(img) : date ? dateV() : typeV();
    if (!img) slot = ercV("");
  } else if (kind === "research") {
    main = img ? bandV(img) : typeV();
    if (!img) slot = bandV("");
  } else if (kind === "headline" || !kind) {
    main = img ? photoV(img) : typeV();
    if (!img) slot = photoV("");
  } else {
    main = typeV();
  }
  return `<div class="hc" data-len="${wnLen(it)}"><div class="hc__in">${main}${slot}</div></div>`;
}

function wnRowHTML(entry, i) {
  const { it, tab } = entry;
  const foot = [(it.source || "").trim(), wnWhen(it, tab)].filter(Boolean).map(esc).join(" • ");
  return `
    <li class="rail__row" data-key="${esc(wnKey(entry))}">
      <button type="button" class="rail__pick" data-i="${i}" aria-describedby="wn-pick-hint">
        <span class="rail__sec">${esc(tab.nav)}</span>
        <span class="rail__hd-line">${esc(it.headline)}</span>
        ${foot ? `<span class="rail__src">${foot}</span>` : ""}
      </button>
    </li>`;
}

let wnStop = null;
function buildWhatsNew() {
  if (wnStop) wnStop();
  wnStop = null;
  const band = $("#whats-new");
  const list = whatsNewFeed();
  if (!list.length) {
    band.hidden = true;
    return;
  }
  band.hidden = false;
  $("#wn-split").innerHTML = `
    <article class="feat no-art" id="wn-feat" data-len="${wnLen(list[0].it)}" aria-live="off">${wnFeatHTML(list[0], "")}${heroCardHTML(list[0])}</article>
    <div class="caro" role="group" aria-label="Browse new and upcoming items">
      <button type="button" class="caro__btn" data-step="-1" aria-label="Previous item">${faIcon("chevron-left")}</button>
      <span class="caro__count" aria-live="off" aria-atomic="true"><b>1</b> / ${list.length}</span>
      <button type="button" class="caro__btn" data-step="1" aria-label="Next item">${faIcon("chevron-right")}</button>
      <button type="button" class="rail__pause"></button>
    </div>
    <div class="rail">
      <span id="wn-pick-hint" hidden>Shows this item in the featured card</span>
      <div class="rail__vp" role="group" aria-label="New and upcoming items">
        <ul class="rail__list" role="list">${list.map(wnRowHTML).join("")}</ul>
      </div>
    </div>`;

  // The card's own links still route through the app.
  $("#wn-feat").addEventListener("click", (e) => {
    if (modifiedClick(e)) return;
    const brief = e.target.closest("a[data-brief]");
    if (brief) {
      e.preventDefault();
      openBrief(brief.dataset.brief, brief.dataset.briefTitle);
      return;
    }
    const section = e.target.closest("a[data-type]");
    if (section) {
      e.preventDefault();
      setType(section.dataset.type);
    }
  });
  wnStop = initWhatsNew(list);
}

function initWhatsNew(list) {
  const split = $("#wn-split");
  const feat = $("#wn-feat");
  const vp = $(".rail__vp", split);
  const btn = $(".rail__pause", split);
  const count = $(".caro__count b", split);
  const countBox = $(".caro__count", split);
  const rows = $$(".rail__row", vp);
  const picks = $$(".rail__pick", vp);
  const phone = matchMedia("(max-width: 820px)");
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Motion nobody asked for: off from the start for anyone who has said so.
  let off = calm;
  let held = false; // a pointer or focus on the card or the list holds it
  let at = 0;
  let timer = 0;
  let glide = 0;
  let turn = 0; // a slow picture must not land over a newer pick
  // Listeners on things that outlive a rebuild (the band, the width query)
  // go when the band is rebuilt.
  const lasting = new AbortController();
  const until = { signal: lasting.signal };

  list.forEach(({ it }) => wnShape(wnImage(it)));

  async function show(i, { fade = true } = {}) {
    at = (i + list.length) % list.length;
    rows.forEach((r, n) => r.classList.toggle("is-current", n === at));
    picks.forEach((b, n) => {
      n === at ? b.setAttribute("aria-current", "true") : b.removeAttribute("aria-current");
      b.tabIndex = n === at ? 0 : -1;
    });
    count.textContent = at + 1;
    if (!phone.matches) glideTo(rows[at], !fade);
    const mine = ++turn;
    const shape = await Promise.race([wnShape(wnImage(list[at].it)), wnWait(1500).then(() => "")]);
    if (mine !== turn) return;
    const paint = () => {
      feat.className = `feat ${shape ? `has-${shape}` : "no-art"}`;
      feat.dataset.key = wnKey(list[at]);
      feat.dataset.len = wnLen(list[at].it);
      feat.innerHTML = wnFeatHTML(list[at], shape) + heroCardHTML(list[at]);
    };
    if (!fade || calm) return paint();
    feat.classList.add("is-out");
    await wnWait(WN_FADE_MS);
    if (mine === turn) paint();
  }

  // The list glides rather than jumps (Kate, Sep 22: the jump read as
  // "powerpoint circa 95"). The row goes to the top while there is list below
  // it; at the end the list rests and the outline walks down the last rows,
  // so all twelve get their turn.
  function glideTo(row, instant) {
    cancelAnimationFrame(glide);
    const from = vp.scrollTop;
    const to = Math.min(row.offsetTop, vp.scrollHeight - vp.clientHeight);
    if (instant || calm || Math.abs(to - from) < 2) {
      vp.scrollTop = to;
      return;
    }
    const ms = Math.min(900, 350 + Math.abs(to - from) / 4);
    const t0 = performance.now();
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      vp.scrollTop = from + (to - from) * ease(t);
      if (t < 1) glide = requestAnimationFrame(step);
    };
    glide = requestAnimationFrame(step);
  }
  // A hand on the wheel wins over the glide.
  ["wheel", "touchstart", "pointerdown"].forEach((ev) =>
    vp.addEventListener(ev, () => cancelAnimationFrame(glide), { passive: true })
  );

  // Nothing turns over on a phone, behind a section, in a hidden tab, or
  // while someone is reading; each of those waits a full turn after.
  function schedule() {
    clearTimeout(timer);
    if (!off) timer = setTimeout(tick, WN_TURN_MS);
  }
  function tick() {
    if (!held && !phone.matches && !$("#landing").hidden && !document.hidden) show(at + 1);
    schedule();
  }

  // Nothing that turns over by itself is read aloud: the card and its
  // counter speak only when a person moves them.
  function announce() {
    const live = off || phone.matches ? "polite" : "off";
    feat.setAttribute("aria-live", live);
    countBox.setAttribute("aria-live", live);
  }

  // A stop is not optional: WCAG 2.2.2 asks for one on anything that moves by
  // itself for more than five seconds. The label says what a press will do,
  // and a card that turns over by itself is not read aloud.
  function sync() {
    btn.innerHTML = faIcon(off ? "play" : "pause");
    btn.title = off ? "Resume auto-scrolling" : "Pause auto-scrolling";
    btn.setAttribute("aria-label", `${btn.title} the list`);
    announce();
    schedule();
  }
  btn.addEventListener("click", () => {
    off = !off;
    sync();
  });

  // Picking a row means "stay on this one".
  vp.addEventListener("click", (e) => {
    const b = e.target.closest(".rail__pick");
    if (!b) return;
    off = true;
    sync();
    show(Number(b.dataset.i));
  });
  // Up and down walk the list without leaving the keyboard; Home and End
  // jump to its ends.
  vp.addEventListener("keydown", (e) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    const jump = { Home: 0, End: list.length - 1 }[e.key];
    if (step === undefined && jump === undefined) return;
    e.preventDefault();
    off = true;
    sync();
    show(jump === undefined ? at + step : jump);
    picks[at].focus({ preventScroll: true });
  });
  // The arrows step the card, and stop the walk the way a pick does.
  $$(".caro__btn", split).forEach((b) =>
    b.addEventListener("click", () => {
      off = true;
      sync();
      show(at + Number(b.dataset.step));
    })
  );

  // Reading beats turning, on the card as much as on the list.
  split.addEventListener("pointerenter", () => {
    held = true;
  }, until);
  split.addEventListener("pointerleave", () => {
    held = false;
    schedule();
  }, until);
  split.addEventListener("focusin", () => {
    held = true;
  }, until);
  split.addEventListener("focusout", (e) => {
    if (split.contains(e.relatedTarget)) return;
    held = false;
    schedule();
  }, until);
  phone.addEventListener("change", () => {
    announce();
    if (!phone.matches) glideTo(rows[at], true);
  }, until);

  sync();
  show(0, { fade: false });
  return () => {
    lasting.abort();
    clearTimeout(timer);
    cancelAnimationFrame(glide);
    turn++;
  };
}

// "14 upcoming", "23 recent", "8 open": how much is live in a section right now,
// so the landing page answers "is this site alive?" before anyone clicks.
const COUNT_WORD = { event: "upcoming", research: "recent", opportunity: "open", headline: "recent" };
function countLabel(type) {
  const n = state.items.filter(
    (it) =>
      (it.type || "").toLowerCase() === type &&
      !isExpired(it) &&
      !(type === "research" && isArchivedResearch(it))
  ).length;
  return `${n} ${COUNT_WORD[type] || "items"}`;
}

// Highlight the active section link (none on the landing or while
// searching). The site title is the Home link: on the landing it carries
// aria-current, with no visual change.
function updateNavActive() {
  const inSection = state.view !== "search" && state.view !== "home";
  $$("#topnav .topnav__link[data-type]").forEach((b) => {
    const active = inSection && b.dataset.type === state.type;
    b.classList.toggle("is-active", active);
    if (active) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  const brand = $(".topnav__brand");
  if (state.view === "home") brand.setAttribute("aria-current", "page");
  else brand.removeAttribute("aria-current");
}

// Open a section. Sub-category is category-specific, so it resets; navigating
// anywhere also leaves search mode.
// Collapse the mobile nav panel (no-op on desktop, where it isn't a panel).
function closeMenu() {
  $(".topnav").classList.remove("is-open");
  $("#menu-btn").setAttribute("aria-expanded", "false");
}

function setType(type) {
  state.view = "section";
  state.type = type;
  state.subtype = "all";
  state.archive = false;
  state.shown = PAGE_SIZE;
  state.sort = null; // each section starts at its sensible default sort
  clearSearch();
  closeMenu();
  render();
  writeURL(true);
  window.scrollTo(0, 0);
  focusHeading();
}

// Return to the landing page.
function setHome() {
  state.view = "home";
  clearSearch();
  closeMenu();
  render();
  writeURL(true);
  window.scrollTo(0, 0);
  focusHeading();
}

function clearSearch() {
  state.q = "";
  state.searchFrom = null;
  const gs = $("#global-search");
  if (gs) gs.value = "";
}

// After a navigation, move focus to the new view's heading (intro, section
// title, or brief title) so keyboard and screen reader users land on it.
function focusHeading() {
  const target = $$("[data-focus-target]").find((el) => el.offsetParent !== null);
  if (target) target.focus({ preventScroll: true });
}

// Browser-tab title per view: sections, searches and briefs are distinguishable
// in history, bookmarks and a row of open tabs.
const SITE_NAME = "ERC Policy Exchange";
function setTitle() {
  let title = SITE_NAME;
  if (state.view === "search") {
    title = `Search: ${state.q.trim()} · ${SITE_NAME}`;
  } else if (state.view === "brief") {
    const it = state.items.find((x) => briefId(x) === state.brief);
    title = `${it ? it.headline : state.briefTitle || "ERC Research"} · ${SITE_NAME}`;
  } else if (state.view === "section") {
    const tab = NEWS_TABS.find((x) => x.value === state.type);
    const archive = state.type === "research" && state.archive ? ": Archive" : "";
    title = `${tab ? tab.label : SITE_NAME}${archive} · ${SITE_NAME}`;
  }
  document.title = title;
}

/* ------------------------------------------------------------
 * Rail filters
 * ------------------------------------------------------------ */
function distinct(field, items = state.items) {
  const set = new Set();
  items.forEach((it) => {
    const v = (it[field] || "").trim();
    if (v) set.add(v);
  });
  return [...set].sort();
}

// Kate's per-tab subtype order (2026-07-15) — drives the Quick Search button
// order AND the colour cycle (1st non-maroon subtype = navy, then gold, teal,
// purple, orange). Lowercase, matching the CSV labels. Subtypes not listed
// here sink to the end alphabetically.
const SUBTYPE_ORDER = {
  event: ["erc events", "texas a&m", "online", "webinar", "off-campus"],
  research: ["erc research", "working paper", "peer-reviewed", "report"],
  headline: ["texas", "national"],
  opportunity: ["call for proposals", "fellowships & programs", "funding & grants"],
};

// The ERC's own subtypes: their label is the darker maroon, every other one
// the lighter (Kate, Sep 23).
const OWN_SUBTYPES = new Set(["erc research", "erc events", "texas a&m", "a&m"]);
function sortSubtypes(subs, type) {
  const order = SUBTYPE_ORDER[(type || "").toLowerCase()] || [];
  const rank = (s) => {
    const i = order.indexOf(s.trim().toLowerCase());
    return i === -1 ? order.length : i;
  };
  return [...subs].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// Validate a ?subtype= deep-link against the active tab's live data — a stale
// or misspelled value resets to "all" so the feed never renders empty.
function validateSubtype() {
  if (state.subtype === "all") return;
  const subs = distinct("subtype", liveItemsOfType(state.type));
  if (!subs.includes(state.subtype)) state.subtype = "all";
}

// Every non-expired item in a category — the basis for that tab's feed,
// subtype buttons, and deep-link validation. Research splits by freshness:
// the tab shows fresh items normally, archived (60-day+) ones in Archive view.
function liveItemsOfType(type) {
  return state.items.filter(
    (it) =>
      (it.type || "").toLowerCase() === type &&
      !isExpired(it) &&
      (type !== "research" || isArchivedResearch(it) === state.archive)
  );
}

/* ------------------------------------------------------------
 * Filter + render
 * ------------------------------------------------------------ */
function filter() {
  const { type, subtype, q } = state;
  const terms = searchTerms(q);
  const out = state.items.filter((it) => {
    const typeOk = (it.type || "").toLowerCase() === type;
    if (!typeOk || isExpired(it)) return false; // past events / deadlines / stale headlines drop off
    // Research: fresh feed vs Archive view, never both at once.
    if (type === "research" && isArchivedResearch(it) !== state.archive) return false;
    const subOk = subtype === "all" || (it.subtype || "").trim() === subtype;
    const qOk = !terms.length || hasAll([it.headline, it.blurb, it.source].join(" "), terms);
    return subOk && qOk;
  });
  out.sort(sortComparator());
  return out;
}

// The sort in effect: the user's chosen action, or the tab's first option
// (closing soon for Opportunities, soonest for Events, newest elsewhere).
function activeSort() {
  return state.sort || TOOLBAR_SORTS[state.type][0];
}

function sortComparator(sort = activeSort()) {
  const { key, dir, first } = sort;
  const mult = dir === "asc" ? 1 : -1;
  // "ERC first" / "Texas first": that subtype on top, newest first within
  // each half.
  if (key === "sub") {
    const top = (it) => ((it.subtype || "").trim().toLowerCase() === first ? 0 : 1);
    return (a, b) => top(a) - top(b) || (b.date || "").localeCompare(a.date || "");
  }
  // "Closing soon": firm deadlines ascending (soonest first); rolling / fuzzy /
  // undated ones always fall to the bottom, ordered newest-posted among
  // themselves so the list stays stable.
  if (key === "deadline") {
    return (a, b) => {
      const da = parseDeadline(a.deadline);
      const db = parseDeadline(b.deadline);
      if (da.firm && db.firm) {
        return da.iso < db.iso ? -1 : da.iso > db.iso ? 1 : 0;
      }
      if (da.firm !== db.firm) return da.firm ? -1 : 1;
      return (b.date || "").localeCompare(a.date || "");
    };
  }
  // Every remaining sort is by posted date.
  return (a, b) => (a.date || "").localeCompare(b.date || "") * mult;
}

// Whole days from today to an ISO date (used for the "closing soon" cue).
function daysUntil(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const [ty, tm, td] = TODAY.split("-").map(Number);
  return Math.round((new Date(y, m - 1, d) - new Date(ty, tm - 1, td)) / 86400000);
}

// Words for the closing-soon cue, so urgency does not ride on colour alone:
// "today", "tomorrow", "6 days left" (deadlines) or "in 6 days" (events).
function relativeDays(iso, isDeadline) {
  const n = daysUntil(iso);
  if (n <= 0) return "today";
  if (n === 1) return "tomorrow";
  return isDeadline ? `${n} days left` : `in ${n} days`;
}

// Sort options per section (the first is the default). Opportunities and
// Events sort by the moment ahead; Research and Headlines can pull ERC's own
// or Texas to the top.
const TOOLBAR_SORTS = {
  opportunity: [{ label: "Closing soon", key: "deadline", dir: "asc" }],
  event: [{ label: "Soonest", key: "date", dir: "asc" }],
  headline: [
    { label: "Newest", key: "date", dir: "desc" },
    { label: "Texas first", key: "sub", dir: "desc", first: "texas" },
  ],
  research: [
    { label: "Newest", key: "date", dir: "desc" },
    { label: "ERC first", key: "sub", dir: "desc", first: "erc research" },
  ],
};

// Per-section wording for the way out of an opened summary.
const DETAIL_LINK_LABEL = {
  opportunity: "Open at the source",
  event: "Register at the source",
  research: "Open at the source",
  headline: "Read at the source",
};

// Scraped summaries can end in the feed's own tails ("… more →", "The post …
// appeared first on …"); those never show. The ellipsis stays: the summary
// really was cut.
const cleanBlurb = (s) =>
  String(s || "")
    .replace(/\s*The post [\s\S]*? appeared first on [\s\S]*$/, "")
    .replace(/\s*more\s*→\s*$/, "")
    .trim();
// The sheet's medium codes read as words; "online" says nothing and goes, and
// a medium that only repeats the outlet ("The 74 • The 74") is left off.
const MEDIUM_WORDS = { online: "", tv: "TV", radio: "Radio", newspaper: "Newspaper", magazine: "Magazine" };
const mediumLabel = (raw, source) => {
  const m = (raw || "").trim();
  if (!m || fold(m) === fold(source)) return "";
  const key = m.toLowerCase();
  return key in MEDIUM_WORDS ? MEDIUM_WORDS[key] : m;
};

// Shared helpers for the feed templates.
const SEP = `<span class="feed-meta-sep" aria-hidden="true">·</span>`;
// ext = show the ↗ outbound marker. On expandable rows the row opens in place
// while the title leaves the site, so the title needs its own cue (phones have
// no hover underline). Link-only rows already carry a row-level ↗.
const NEW_TAB = `<span class="sr-only"> (opens in new tab)</span>`;
const titleLink = (link, headline, ext = false) =>
  link
    ? `<a class="feed-title-link" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(headline)}${
        ext ? `&nbsp;${faIcon("arrow-up-right-from-square", "feed-ext")}` : "" // nbsp keeps the arrow on the last word's line
      }${NEW_TAB}</a>`
    : `<span class="feed-title-link">${esc(headline)}</span>`;

// ERC Research Briefs live on Google Drive; instead of bouncing readers out,
// they open in an in-app viewer (?brief=<drive file id>) that iframes Drive's
// embeddable /preview player.
const driveId = (link) => {
  const m = (link || "").match(/drive\.google\.com\/file\/d\/([\w-]+)/);
  return m ? m[1] : null;
};
const briefId = (it) =>
  (it.subtype || "").trim().toLowerCase() === "erc research"
    ? driveId(it.link)
    : null;
// Title link for a feed row: briefs route to the internal viewer (the
// delegated #news-list listener intercepts data-brief clicks — no reload);
// everything else opens the source in a new tab.
const itemTitleLink = (it, ext = false) => {
  const id = briefId(it);
  return id
    ? `<a class="feed-title-link" href="?brief=${id}" data-brief="${id}">${esc(it.headline)}</a>`
    : titleLink((it.link || "").trim(), it.headline, ext);
};
// The expanded "Read the full …" link mirrors the title: a brief opens the
// in-app viewer (intercepted by the delegated listener), everything else
// opens its source in a new tab.
const itemDetailLink = (it) => {
  const id = briefId(it);
  if (id)
    return `<a class="feed-link" href="?brief=${id}" data-brief="${id}">Read the full brief »</a>`;
  const link = (it.link || "").trim();
  return link
    ? `<a class="feed-link" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${DETAIL_LINK_LABEL[state.type] || "Read more"} »${NEW_TAB}</a>`
    : "";
};

// "A, B, C, D…" → "A, B, C, et al." for the collapsed row (full list shows in
// the expanded detail when truncated).
function shortAuthors(raw) {
  // "Burdick-Will, J., & Stein, M. L." is two people: a list written
  // "Last, F." splits after each set of initials, any other on commas and "&".
  const apa = /,\s*(?:[A-Z]\.\s*)+(?:,|$)/.test(raw);
  const names = (
    apa
      ? raw.split(/\.\s*,\s*(?:&\s*)?/).map((s, i, a) => (i < a.length - 1 ? `${s}.` : s))
      : raw.replace(/\s*&\s*/g, ", ").split(/,\s*/)
  )
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length <= 3) return { text: raw, truncated: false };
  return { text: names.slice(0, 3).join(", ") + ", et al.", truncated: true };
}

// Build the section toolbar: the Quick Search buttons (one per sub-category,
// plus Clear and, for Research, Archive), then the count and the sort actions.
function renderToolbar() {
  const bar = $("#opp-toolbar");
  bar.hidden = false;
  const items = liveItemsOfType(state.type);
  const cur = activeSort();

  // A section with one order (Events, Opportunities) shows no sort choice.
  const sorts = TOOLBAR_SORTS[state.type] || [];
  const sortHTML = (sorts.length > 1 ? sorts : [])
    .map(
      (s, i) =>
        `<button type="button" class="tsort${s === cur ? " is-active" : ""}" data-sort="${i}" aria-pressed="${s === cur}">${esc(s.label)}</button>`
    )
    .join(`<span class="tsort-sep" aria-hidden="true">·</span>`);
  // No visible "Sort" label — the options are self-describing; the group's
  // aria-label still announces it for assistive tech.
  const sortGroup = `
    <div class="tgroup tgroup--sort" role="group" aria-label="Sort by">
      ${sortHTML}
    </div>`;

  // The category buttons render on every section, even with one sub-category,
  // so the toolbar's shape is identical as you move between sections.
  const subs = sortSubtypes(distinct("subtype", items), state.type);
  const catBtns = subs
    .map((v) => {
      const active = state.subtype === v;
      return `<button type="button" class="tbtn${active ? " is-active" : ""}" data-subtype="${esc(v)}" aria-pressed="${active}">${esc(v)}</button>`;
    })
    .join("");
  // No "All" button — clicking a category filters, and the quiet Clear text
  // action beside the buttons resets to everything (dimmed until a filter is on).
  const clearBtn = `<button type="button" class="tclear" data-subtype="all"${
    state.subtype === "all" && !state.archive ? " disabled" : ""
  }>Clear</button>`;
  // Research keeps its 60-day+ items behind an Archive toggle at the row's end.
  const archiveBtn =
    state.type === "research"
      ? `<button type="button" class="tbtn tbtn--archive${
          state.archive ? " is-active" : ""
        }" data-archive aria-pressed="${state.archive}">Archive</button>`
      : "";
  const catGroup = `
    <div class="tgroup tgroup--show" role="group" aria-label="Quick search by category">
      <span class="tgroup__label">Quick search</span>${catBtns}${clearBtn}${archiveBtn}
    </div>`;
  // Phones get the same choices as one row of filter chips that slides
  // sideways, "All" first and Archive last (Kate, Sep 23). CSS shows this row
  // or the buttons above by width; both answer to the same click handler.
  const chips = [
    `<button type="button" class="chip" data-subtype="all" aria-pressed="${state.subtype === "all" && !state.archive}">All</button>`,
    ...subs.map(
      (v) =>
        `<button type="button" class="chip" data-subtype="${esc(v)}" aria-pressed="${state.subtype === v}">${esc(v)}</button>`
    ),
    state.type === "research"
      ? `<button type="button" class="chip chip--archive" data-archive aria-pressed="${state.archive}">${faIcon("box-archive")} Archive</button>`
      : "",
  ].join("");
  const chipRow = `<div class="chips" role="group" aria-label="Quick search by category">${chips}</div>`;

  // The count node is persistent (it is the live region screen readers track),
  // so detach it before the rebuild and seat it at the head of the sort row.
  const count = $("#news-count");
  // The chip row is rebuilt on every change: it keeps its scroll within a
  // section, and the chosen chip stays in view (Sep 23 audit).
  const oldRow = $(".chips", bar);
  const keep = oldRow && bar.dataset.for === state.type ? oldRow.scrollLeft : 0;
  bar.innerHTML = chipRow + catGroup + sortGroup;
  bar.dataset.for = state.type;
  if (count) bar.querySelector(".tgroup--sort").prepend(count);
  const row = $(".chips", bar);
  row.scrollLeft = keep;
  const on = $$('.chip[aria-pressed="true"]', row)[0];
  if (on) {
    const r = row.getBoundingClientRect();
    const c = on.getBoundingClientRect();
    if (c.left < r.left || c.right > r.right) row.scrollLeft += c.left - r.left - 24;
  }
}

// Every section renders as rows: the tag above the title, the source and a
// detail line below (Research: the authors; Events: time · location), the
// date or deadline at the right beside a chevron that opens the summary in
// place. Rows without a summary have no chevron; their title is the link.
function renderFeedCards(results, colorFor, total = results.length) {
  const isOpp = state.type === "opportunity";
  const rows = results
    .map((it, i) => {
      const source = (it.source || "").trim();
      const subtype = (it.subtype || "").trim();
      const catText = subtype || (it.type || "");
      const catHTML = `<div class="feed-item__cat"><span class="tag ${colorFor[subtype] || ""}">${esc(catText)}</span></div>`;
      const detailId = `feed-detail-${i}`;
      // The right side: Opportunities show the deadline, everything else its date.
      const rv = isOpp
        ? parseDeadline(it.deadline)
        : { label: it.date ? formatDate(it.date) : "", firm: !!it.date, iso: it.date || "" };
      // Flag anything happening within two weeks so urgency reads at a glance.
      // Only rows with a moment ahead get it: opportunity deadlines and event
      // dates. Headlines and research carry a publication date, so a fresh
      // item there is just fresh, not "closing soon".
      const hasMomentAhead = isOpp || state.type === "event";
      const soon = hasMomentAhead && rv.firm && rv.iso >= TODAY && daysUntil(rv.iso) <= 14;
      const soonText = soon ? relativeDays(rv.iso, isOpp) : "";
      const dateHTML = rv.label
        ? `<span class="feed-date">${esc(rv.label)}${
            soonText
              ? `<span class="feed-date__soon"> · ${esc(soonText)}</span>${isOpp ? `<span class="sr-only"> closing soon</span>` : ""}`
              : ""
          }</span>`
        : "";
      const titleHTML = itemTitleLink(it, true);
      // Research: the authors, truncated ("…et al.") while the row is closed;
      // the same line un-truncates in place on open, so nothing jumps around.
      let metaHTML = "";
      if (state.type === "research") {
        const authors = (it.authors || "").trim();
        const a = shortAuthors(fold(authors) === fold(source) ? "" : authors);
        if (a.text)
          metaHTML = a.truncated
            ? `<div class="feed-item__meta"><span class="authors-short">${esc(a.text)}</span><span class="authors-full">${esc(it.authors)}</span></div>`
            : `<div class="feed-item__meta">${esc(a.text)}</div>`;
      } else if (state.type === "event") {
        // time · location, so a reader can pick a webinar without opening rows.
        const when = [(it.time || "").trim(), (it.location || "").trim()].filter(Boolean).map(esc).join(SEP);
        if (when) metaHTML = `<div class="feed-item__meta">${when}</div>`;
      }
      // The summary: the blurb, the way out to the source (or a brief's in-app
      // viewer), and, on Research, an infographic when the sheet's
      // `infographic` cell holds a link (a Drive link opens in the viewer, any
      // other in a new tab). Events keep their card picture in that column,
      // so they get no link (Sep 23 audit: it opened a bare image file).
      const infographic = state.type === "research" ? (it.infographic || "").trim() : "";
      const igId = driveId(infographic);
      const infographicHTML = infographic
        ? igId
          ? `<a class="feed-link" href="?brief=${igId}" data-brief="${igId}" data-brief-title="${esc(it.headline)} infographic">View infographic »</a>`
          : `<a class="feed-link" href="${esc(infographic)}" target="_blank" rel="noopener noreferrer">View infographic »${NEW_TAB}</a>`
        : "";
      const actions = [itemDetailLink(it), infographicHTML].filter(Boolean).join("");
      const blurb = cleanBlurb(it.blurb);
      const detailHTML =
        blurb || actions
          ? `<div class="feed-item__detail" id="${detailId}" hidden>${
              blurb ? `<p class="feed-detail__blurb">${esc(blurb)}</p>` : ""
            }${actions ? `<div class="feed-actions">${actions}</div>` : ""}</div>`
          : "";
      const toggleHTML = detailHTML
        ? `<button type="button" class="feed-expand" aria-expanded="false" aria-controls="${detailId}" aria-label="Show details: ${esc(it.headline)}">${chevronIcon()}</button>`
        : "";
      return `
        <li class="feed-item" data-expanded="false" data-key="${esc(itemKey(it))}">
          <div class="feed-item__row">
            <div class="feed-item__body">
              ${catHTML}
              <h3 class="feed-item__title">${titleHTML}</h3>
              ${source ? `<div class="feed-item__source">${esc(source)}</div>` : ""}
              ${metaHTML}
            </div>
            <div class="feed-item__side">
              ${dateHTML}
              ${toggleHTML}
            </div>
          </div>
          ${detailHTML}
        </li>`;
    })
    .join("");
  return `
    <div class="feed">
      <ul class="feed__list" role="list">${rows}</ul>
      ${showMoreHTML(total)}
    </div>`;
}

// Headlines as the Aggie UX News Collection: a grid of text-only cards with
// nothing to open — tag, title, the source line. No teaser: the outlets' ledes
// ran 2 to 10 lines and 9 of 43 stopped mid-sentence (Kate, Sep 23). The blurb
// stays in the data, so search still reads it.
function renderHeadlineCards(results, colorFor, total = results.length) {
  const cards = results
    .map((it) => {
      const subtype = (it.subtype || "").trim();
      const source = (it.source || "").trim();
      const medium = mediumLabel(it.medium, source);
      const subhead = [source, it.date ? formatDate(it.date) : "", medium]
        .filter(Boolean)
        .map(esc)
        .join(" • ");
      return `
        <article class="ncard" data-key="${esc(itemKey(it))}">
          <span class="tag ${colorFor[subtype] || ""}">${esc(subtype || it.type || "")}</span>
          <h3 class="ncard__title">${itemTitleLink(it, true)}</h3>
          ${subhead ? `<span class="ncard__subhead">${subhead}</span>` : ""}
        </article>`;
    })
    .join("");
  return `<div class="ncol">${cards}</div>${showMoreHTML(total)}`;
}

// "Show more" control under any list with pages left: quiet pill + a muted
// running count, revealing PAGE_SIZE more rows in place per click.
function showMoreHTML(total) {
  if (total <= state.shown) return "";
  const left = Math.min(PAGE_SIZE, total - state.shown);
  return `
    <div class="feed-more">
      <button type="button" class="feed-more__btn" data-more>Show ${left} more</button>
      <span class="feed-more__count">Showing ${Math.min(state.shown, total)} of ${total}</span>
    </div>`;
}

// Global search: match every live (non-expired) item in any section against
// the query, newest first. Rows are flat links out to the source, tagged with
// their section so you know where each hit lives. Archived research counts —
// it has aged out of the fresh feed, not out of the site.
function renderSearch() {
  $("#opp-toolbar").hidden = true;
  const q = state.q.trim();
  // Search uses the same head as a section: a title, then the count where the
  // description line would be (no toolbar, so the count lives here).
  const head = $("#section-head");
  head.hidden = false;
  head.innerHTML = `<h2 class="section-head__title" tabindex="-1" data-focus-target>Search results</h2>`;
  head.append($("#news-count"));
  const terms = searchTerms(q);
  const fields = (it) => [it.headline, it.blurb, it.source, it.authors, it.topic, it.subtype].join("\n");
  // How far from today, by the date a reader goes by: an opportunity's
  // deadline, anything else's own date. Year-only dates go last.
  const distance = (it) => {
    const iso = (it.type || "").toLowerCase() === "opportunity" ? parseDeadline(it.deadline).iso : it.date || "";
    return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? Math.abs(daysUntil(iso)) : Infinity;
  };
  const results = state.items
    .filter((it) => !isExpired(it) && hasAll(fields(it), terms))
    .map((it) => ({ it, title: hasAll(it.headline, terms), far: distance(it) }))
    .sort((a, b) => b.title - a.title || a.far - b.far || (b.it.date || "").localeCompare(a.it.date || ""))
    .map((r) => r.it);

  $("#news-count").innerHTML = `<strong>${results.length}</strong> ${
    results.length === 1 ? "result" : "results"
  } for “${esc(q)}”`;

  const list = $("#news-list");
  if (results.length === 0) {
    list.innerHTML = `
      <div class="state">
        <strong>No matches for “${esc(q)}”</strong>
        Try a different word, or browse a section from the menu above.
      </div>`;
    return;
  }

  const sectionLabel = {};
  NEWS_TABS.forEach((t) => (sectionLabel[t.value] = t.nav));

  const rows = results
    .slice(0, state.shown)
    .map((it) => {
      const link = (it.link || "").trim();
      const source = (it.source || "").trim();
      const titleHTML = itemTitleLink(it);
      // The date a reader goes by: an opportunity's deadline, else its own.
      const when =
        (it.type || "").toLowerCase() === "opportunity"
          ? parseDeadline(it.deadline).label
          : it.date
            ? formatDate(it.date)
            : "";
      const meta = [
        `<span class="feed-cat">${esc(sectionLabel[(it.type || "").toLowerCase()] || it.type)}</span>`,
        source ? `<span class="feed-source">${esc(source)}</span>` : "",
        when ? `<span class="feed-meta-date">${esc(when)}</span>` : "",
      ]
        .filter(Boolean)
        .join(SEP);
      // An ERC brief opens in the site's own viewer from anywhere on its row,
      // the way its title does, never in Drive.
      const bid = briefId(it);
      const rowTarget = bid
        ? ` data-brief-row="${bid}" data-brief-title="${esc(it.headline)}"`
        : link
          ? ` data-href="${esc(link)}"`
          : "";
      return `
        <li class="feed-item feed-item--link" data-key="${esc(itemKey(it))}"${rowTarget}>
          <div class="feed-item__row">
            <div class="feed-item__body">
              <h3 class="feed-item__title">${titleHTML}</h3>
              <div class="feed-item__meta">${meta}</div>
            </div>
            <div class="feed-item__side">
              ${link && !bid ? `${faIcon("arrow-up-right-from-square", "feed-goto")}` : ""}
            </div>
          </div>
        </li>`;
    })
    .join("");

  list.innerHTML = `
    <div class="feed">
      <ul class="feed__list" role="list">${rows}</ul>
      ${showMoreHTML(results.length)}
    </div>`;
}

// In-app viewer for an ERC Research Brief: title + authors up top, the PDF in
// Drive's embeddable /preview iframe, with an escape hatch out to Drive.
// A brief's way back goes where the reader came from (Sep 23 audit: it always
// opened the fresh Research list); one opened straight from a link goes to
// Research.
function briefBackLabel() {
  const from = state.briefFrom;
  if (!from) return "Back to Research";
  if (from.view === "search") return "Back to search results";
  if (from.view === "home") return "Back to the home page";
  if (from.type === "research" && from.archive) return "Back to the Archive";
  const tab = NEWS_TABS.find((t) => t.value === from.type);
  return `Back to ${tab ? tab.nav : "Research"}`;
}
function leaveBrief() {
  if (state.briefFrom) history.back();
  else setType("research");
}

function renderBrief() {
  const it = state.items.find((x) => briefId(x) === state.brief);
  // Title: the matching brief row when there is one; otherwise whatever the
  // opener passed (an infographic isn't its own row) or a generic fallback.
  const label = it ? it.headline : state.briefTitle || "ERC Research";
  const driveView = `https://drive.google.com/file/d/${esc(state.brief)}/view`;
  const head = $("#section-head");
  if (head) head.hidden = true;
  $("#opp-toolbar").hidden = true;
  $("#news-count").textContent = "";
  $("#news-list").innerHTML = `
    <div class="brief">
      <h2 class="section-head__title brief__title" tabindex="-1" data-focus-target>${esc(label)}</h2>
      <div class="brief__bar">
        <button type="button" class="brief__back">${faIcon("arrow-left")}${esc(briefBackLabel())}</button>
        <a class="brief__open" href="${driveView}" target="_blank" rel="noopener noreferrer">Open in Google Drive ${faIcon("arrow-up-right-from-square")}</a>
      </div>
      <p class="state state--loading brief__loading" role="status">Loading the brief…</p>
      <iframe
        class="brief__frame"
        src="https://drive.google.com/file/d/${esc(state.brief)}/preview"
        title="${esc(label)}"
        allow="autoplay"
        loading="lazy"></iframe>
    </div>`;
  // Drive's preview can take a few seconds; drop the loading line once it lands.
  const frame = $(".brief__frame");
  const loading = $(".brief__loading");
  if (frame && loading) frame.addEventListener("load", () => { loading.hidden = true; }, { once: true });
}

function openBrief(id, title) {
  state.briefFrom = { view: state.view, type: state.type, archive: state.archive };
  state.view = "brief";
  state.brief = id;
  state.briefTitle = title || "";
  state.type = "research";
  clearSearch();
  closeMenu();
  render();
  writeURL(true);
  window.scrollTo(0, 0);
  focusHeading();
}

function render() {
  updateNavActive();
  setTitle();
  // The count node is persistent (the live region). Park it under the list
  // first; the section toolbar or the search head then seats it where it goes.
  $(".results__meta").prepend($("#news-count"));

  // The strip is identical on every page — persistent nav people learn once.
  // (The landing cards introduce; the bar is the always-there utility.)

  // Home view: show the landing page, hide the section feed, and stop.
  if (state.view === "home") {
    $("#landing").hidden = false;
    $("#section").hidden = true;
    return;
  }
  $("#landing").hidden = true;
  $("#section").hidden = false;

  // Global search view: results across every section, no per-tab toolbar.
  if (state.view === "search") {
    renderSearch();
    return;
  }

  // Brief viewer: one ERC Research Brief, embedded in place.
  if (state.view === "brief") {
    renderBrief();
    return;
  }

  // Section head: the tab's full title + one-line description.
  const headTab = NEWS_TABS.find((t) => t.value === state.type);
  const head = $("#section-head");
  const archiveMode = state.type === "research" && state.archive;
  if (head) {
    head.hidden = !headTab;
    if (headTab) {
      head.innerHTML = `<h2 class="section-head__title" tabindex="-1" data-focus-target>${esc(headTab.label)}${
        archiveMode ? ": Archive" : ""
      }</h2><p class="section-head__desc">${esc(
        archiveMode
          ? "Research posted more than 60 days ago."
          : headTab.desc
      )}</p>`;
    }
  }

  const list = $("#news-list");
  const results = filter();
  // The count answers every filter and sort click, and the live region reads
  // it out for screen readers.
  $("#news-count").innerHTML = `<strong>${results.length}</strong> ${
    results.length === 1 ? "item" : "items"
  }${state.subtype !== "all" ? ` in ${esc(state.subtype)}` : ""}`;

  renderToolbar();

  // Each sub-category's label class: the ERC's own wear the darker maroon.
  const colorFor = {};
  distinct(
    "subtype",
    state.items.filter((it) => (it.type || "").toLowerCase() === state.type)
  ).forEach((s) => {
    colorFor[s] = OWN_SUBTYPES.has(s.trim().toLowerCase()) ? "tag--own" : "";
  });

  if (results.length === 0) {
    // Filters are built from what is there, so an empty list is an empty
    // section; say that, and where a reader can help.
    const what = archiveMode
      ? "Nothing in the Archive yet."
      : state.subtype !== "all"
        ? `Nothing in ${state.subtype} right now.`
        : `No ${headTab.nav.toLowerCase()} listed right now.`;
    list.innerHTML = `
      <div class="state">
        <strong>${esc(what)}</strong>
        ${archiveMode ? "" : `Know of one? <a href="share/">Share it with the ERC</a>.`}
      </div>`;
    return;
  }

  const page = results.slice(0, state.shown);
  list.innerHTML =
    state.type === "headline"
      ? renderHeadlineCards(page, colorFor, results.length)
      : renderFeedCards(page, colorFor, results.length);
}

// Toggle one item's summary via its chevron button (the accessible expand
// control): data-expanded drives the row's open styling, and the detail
// region named by aria-controls shows/hides.
function toggleDetail(caretBtn) {
  const expanded = caretBtn.getAttribute("aria-expanded") === "true";
  caretBtn.setAttribute("aria-expanded", String(!expanded));
  const item = caretBtn.closest(".feed-item");
  if (item) item.setAttribute("data-expanded", String(!expanded));
  const detail = document.getElementById(caretBtn.getAttribute("aria-controls"));
  if (detail) detail.hidden = expanded;
}

function chevronIcon() {
  return faIcon("chevron-down", "chevron");
}

/* ------------------------------------------------------------
 * Boot
 * ------------------------------------------------------------ */
async function loadCSV(path) {
  // no-store so an edited CSV always shows up on refresh.
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return {
    rows: parseCSV(await res.text()),
    modified: res.headers.get("last-modified"),
  };
}

// The admin door's file; the site works the same without it.
async function loadFeatured() {
  const list = (v) => (Array.isArray(v) ? v : []);
  try {
    const res = await fetch(FEATURED_JSON, { cache: "no-store" });
    const j = res.ok ? await res.json() : {};
    return { pins: list(j.pins), cards: list(j.cards), hidden: list(j.hidden) };
  } catch {
    return { pins: [], cards: [], hidden: [] };
  }
}

async function boot() {
  readURL();
  buildNav();
  wireMenu();
  $("#section").hidden = false;
  try {
    const [{ rows, modified }, featured] = await Promise.all([loadCSV(NEWS_CSV), loadFeatured()]);
    init(rows, modified, featured);
  } catch (err) {
    // Visitors get plain words and a way out; the local-server hint appears
    // only when the page was opened from the file system, where fetch() is blocked.
    const local = window.location.protocol === "file:";
    $("#landing").hidden = true;
    $("#section").hidden = false;
    $("#section-head").hidden = true;
    $("#opp-toolbar").hidden = true;
    $("#news-list").innerHTML = `
      <div class="state" role="alert">
        <strong>We couldn't load the latest items</strong>
        ${
          local
            ? "This page needs to be served over http, not opened from the file system. From the project folder run <code>python3 -m http.server 8000</code>, then visit <code>http://localhost:8000</code>."
            : 'Refresh the page to try again. If it keeps happening, email <a href="mailto:erc@tamu.edu">erc@tamu.edu</a>.'
        }
        <div class="feed-actions state__actions"><button type="button" class="feed-link state__retry">Try again</button></div>
        ${local ? `<span class="state__hint">(${esc(err.message)})</span>` : ""}
      </div>`;
    $(".state__retry").addEventListener("click", () => window.location.reload());
    console.error(err);
  }
}

document.addEventListener("DOMContentLoaded", boot);
