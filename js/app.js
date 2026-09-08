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

// Category tabs across the top — you view one stream at a time (the
// categories are distinct enough that a mixed "All" view isn't useful).
// These mirror the ERC newsletter's timely sections.
// label = full name (feed/section header); nav = short top-nav label;
// icon = a file under assets/ (Kate's dedicated home-icons set),
// shown on the landing card via CSS mask — swap the file name to change it.
const NEWS_TABS = [
  {
    value: "research",
    label: "New Education Policy Research",
    lines: ["New Education", "Policy Research"],
    nav: "Research",
    icon: "home-icons/research.svg",
    desc: "New working papers, peer-reviewed studies, and reports.",
  },
  {
    value: "event",
    label: "Upcoming Events",
    lines: ["Upcoming", "Events"],
    nav: "Events",
    icon: "home-icons/events.svg",
    desc: "Events, lectures, webinars, and conferences, both on and off campus.",
  },
  {
    value: "opportunity",
    label: "Opportunities",
    nav: "Opportunities",
    icon: "home-icons/opportunities.svg",
    desc: "Fellowships, grants, and calls for proposals relevant to education researchers.",
  },
  {
    value: "headline",
    label: "Education Headlines",
    lines: ["Education", "Headlines"],
    nav: "Headlines",
    icon: "home-icons/headlines.svg",
    desc: "The education news we're following, from Texas and across the country.",
  },
];

// Home icon for the top nav.
const HOME_ICON = faIcon("house");

// Today (YYYY-MM-DD). Upcoming Events drop off automatically once their date
// passes, so the feed stays current with no manual pruning.
const TODAY = new Date().toISOString().slice(0, 10);
const isPastEvent = (it) =>
  (it.type || "").toLowerCase() === "event" && (it.date || "") < TODAY;

// News older than this (60 days back) has aged out. Headlines phase out of the
// site entirely (they're time-sensitive); Research instead moves to the
// Archive view on its tab, so nothing scholarly is ever lost. An undated
// headline can't prove it's fresh, so it ages out too.
const CUTOFF = (() => {
  const d = new Date();
  d.setDate(d.getDate() - 60);
  return d.toISOString().slice(0, 10);
})();
const isStaleHeadline = (it) =>
  (it.type || "").toLowerCase() === "headline" && (it.date || "") < CUTOFF;
const isArchivedResearch = (it) =>
  (it.type || "").toLowerCase() === "research" && (it.date || "") < CUTOFF;

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

function matches(haystack, needle) {
  return haystack.toLowerCase().includes(needle.toLowerCase().trim());
}

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
function init(rows, modified) {
  state.items = rows;

  // Freshness cue: when the CSV itself was last touched (the server's
  // Last-Modified — on GitHub Pages that's the last deploy that changed it).
  // Fallback: the most recent item date that isn't in the future.
  const mod = modified ? new Date(modified) : null;
  const stamp =
    mod && !isNaN(mod)
      ? mod.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
      : formatDate(
          state.items
            .map((it) => it.date)
            .filter((d) => d && d <= TODAY)
            .reduce((m, d) => (d > m ? d : m), "")
        );
  $("#news-updated").textContent = stamp ? `Updated ${stamp}` : "";
  $("#landing-updated").textContent = stamp ? `Updated ${stamp}` : "";

  buildNav();
  buildLanding();
  validateSubtype();

  // Back and Forward: the URL is the source of truth, so re-read it and render.
  window.addEventListener("popstate", () => {
    readURL();
    validateSubtype();
    state.shown = PAGE_SIZE;
    state.searchFrom = null;
    $("#global-search").value = state.q;
    closeMenu();
    render();
  });

  // Global search (top strip): typing searches every section at once; clearing
  // returns to wherever you were (landing or a section).
  const gs = $("#global-search");
  gs.value = state.q;
  gs.addEventListener("input", (e) => {
    const q = e.target.value;
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
    writeURL();
  });

  // Card-tab toolbar: sort text actions + category "view" buttons. The
  // toolbar is rebuilt by render(), so afterwards we restore focus to the
  // equivalent new button (keyboard users would otherwise be dropped).
  $("#opp-toolbar").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sortkey], [data-subtype], [data-archive]");
    if (!btn) return;
    state.shown = PAGE_SIZE; // any toolbar change starts the list over
    if (btn.dataset.sortkey) {
      state.sort = { key: btn.dataset.sortkey, dir: btn.dataset.sortdir };
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
    const again = $("#opp-toolbar").querySelector(
      btn.dataset.sortkey
        ? `[data-sortkey="${btn.dataset.sortkey}"][data-sortdir="${btn.dataset.sortdir}"]`
        : btn.dataset.archive != null
          ? "[data-archive]"
          : `[data-subtype="${CSS.escape(btn.dataset.subtype)}"]`
    );
    if (again && !again.disabled) again.focus();
  });

  // Re-measure the sticky toolbar when the viewport changes (it can re-wrap).
  window.addEventListener("resize", syncToolbarHeight);

  // Mobile hamburger: toggles the collapsed nav panel (CSS shows the button
  // and hides the links only under the mobile breakpoint).
  $("#menu-btn").addEventListener("click", () => {
    const open = $(".topnav").classList.toggle("is-open");
    $("#menu-btn").setAttribute("aria-expanded", String(open));
  });
  // The open panel also closes on Escape and on a tap anywhere outside the strip.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $(".topnav").classList.contains("is-open")) {
      closeMenu();
      $("#menu-btn").focus();
    }
  });
  document.addEventListener("click", (e) => {
    if ($(".topnav").classList.contains("is-open") && !e.target.closest(".topnav")) closeMenu();
  });

  // One delegated listener covers every feed row ever rendered: the caret
  // button toggles the detail, a click elsewhere on the row does the same
  // (bigger target), and link-only rows open their source.
  $("#news-list").addEventListener("click", (e) => {
    // "Show more": reveal the next page in place (works in sections + search).
    const moreBtn = e.target.closest("[data-more]");
    if (moreBtn) {
      state.shown += PAGE_SIZE;
      render();
      const again = $("#news-list").querySelector("[data-more]");
      if (again) again.focus();
      return;
    }
    const briefLink = e.target.closest("a[data-brief]");
    if (briefLink) {
      e.preventDefault();
      openBrief(briefLink.dataset.brief, briefLink.dataset.briefTitle);
      return;
    }
    if (e.target.closest(".brief__back")) {
      setType("research");
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
    if (linkItem && linkItem.dataset.href) {
      window.open(linkItem.dataset.href, "_blank", "noopener");
    }
  });

  render();
}

/* ------------------------------------------------------------
 * Top navigation + landing
 * ------------------------------------------------------------ */
// Build the top nav strip: Home + the four sections.
function buildNav() {
  const el = $("#topnav");
  // Real links: every view has a URL, so middle-click, "open in new tab" and
  // copy-link all work, and screen readers hear "link". A plain click is
  // intercepted for the in-page route.
  const home = `
    <a class="topnav__link topnav__home" href="?" data-view="home">
      <span class="topnav__icon" aria-hidden="true">${HOME_ICON}</span>Home
    </a>`;
  // Section links are text-only; Home keeps its icon (it reads as the one
  // utility control in the row).
  const sections = NEWS_TABS.map(
    (t) => `
    <a class="topnav__link" href="?type=${t.value}" data-type="${t.value}">${esc(t.nav)}</a>`
  ).join("");
  el.innerHTML = home + sections;

  el.addEventListener("click", (e) => {
    const link = e.target.closest(".topnav__link");
    if (!link || modifiedClick(e)) return;
    e.preventDefault();
    if (link.dataset.view === "home") setHome();
    else if (link.dataset.type) setType(link.dataset.type);
  });
}

// Cmd/Ctrl/Shift-click or middle-click: let the browser open a new tab or window.
const modifiedClick = (e) => e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1;

// Build the landing-page section cards (icon + title).
function buildLanding() {
  const el = $("#landing-cards");
  el.innerHTML = NEWS_TABS.map(
    (t) => `
    <a class="lcard" href="?type=${t.value}" data-type="${t.value}">
      <span class="lcard__icon" aria-hidden="true"><span class="lcard__glyph" ${iconMask(t.icon)}></span></span>
      <span class="lcard__title">${(t.lines || [t.label]).map(esc).join("<br>")}</span>
      <span class="lcard__count">${esc(countLabel(t.value))}</span>
    </a>`
  ).join("");

  el.addEventListener("click", (e) => {
    const card = e.target.closest(".lcard");
    if (!card || modifiedClick(e)) return;
    e.preventDefault();
    setType(card.dataset.type);
  });
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

// Highlight the active top-nav link (none while searching).
function updateNavActive() {
  $$("#topnav .topnav__link").forEach((b) => {
    const active =
      state.view === "search"
        ? false
        : state.view === "home"
        ? b.dataset.view === "home"
        : b.dataset.type === state.type;
    b.classList.toggle("is-active", active);
    if (active) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
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
    const archive = state.type === "research" && state.archive ? " — Archive" : "";
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

// ERC's own + Texas subtypes always wear the solid-border Aggie-maroon pill
// (Kate's rule); everything else takes a fixed hue from the table below, so a
// subtype keeps its colour wherever it appears. Within any one tab the hues
// are distinct; a subtype missing from the table falls back to the old cycle.
const MAROON_SUBS = new Set(["erc events", "erc research", "texas"]);
const SUBTYPE_COLOR = {
  // Research
  "working paper": "tag--c0", // navy
  "peer-reviewed": "tag--c2", // teal
  report: "tag--c3", // purple
  // Events
  "webinar-online": "tag--c0",
  webinar: "tag--c0",
  online: "tag--c0",
  "off-campus": "tag--c3",
  "texas a&m": "tag--c4", // orange
  // Headlines
  national: "tag--c0",
  // Opportunities
  "funding & grants": "tag--c2",
  "fellowships & programs": "tag--c1", // gold
  "call for proposals": "tag--c4",
};
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
  const out = state.items.filter((it) => {
    const typeOk = (it.type || "").toLowerCase() === type;
    if (!typeOk || isExpired(it)) return false; // past events / deadlines / stale headlines drop off
    // Research: fresh feed vs Archive view, never both at once.
    if (type === "research" && isArchivedResearch(it) !== state.archive) return false;
    const subOk = subtype === "all" || (it.subtype || "").trim() === subtype;
    const qOk =
      !q.trim() ||
      matches(it.headline || "", q) ||
      matches(it.blurb || "", q) ||
      matches(it.source || "", q);
    return subOk && qOk;
  });
  out.sort(sortComparator());
  return out;
}

// The sort in effect: the user's chosen action, or the tab's first toolbar
// option (soonest-first for Upcoming Events, newest-first everywhere else).
function activeSort() {
  return state.sort || TOOLBAR_SORTS[state.type][0];
}

function sortComparator() {
  const { key, dir } = activeSort();
  const mult = dir === "asc" ? 1 : -1;
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

// Sort options offered in each tab's button toolbar. Opportunities contrasts
// posted-date vs deadline; Events and Headlines are chronological.
const TOOLBAR_SORTS = {
  opportunity: [
    { label: "Newest posted", key: "date", dir: "desc" },
    { label: "Closing soon", key: "deadline", dir: "asc" },
  ],
  event: [
    { label: "Soonest first", key: "date", dir: "asc" },
    { label: "Latest first", key: "date", dir: "desc" },
  ],
  headline: [
    { label: "Newest first", key: "date", dir: "desc" },
    { label: "Oldest first", key: "date", dir: "asc" },
  ],
  research: [
    { label: "Newest first", key: "date", dir: "desc" },
    { label: "Oldest first", key: "date", dir: "asc" },
  ],
};

// Medium icons (Font Awesome) + display labels — shown AFTER the source
// ("K-12 Dive · [icon] Article") when the CSV's `medium` column is filled.
// Blank medium = source only, so the column stays optional row by row.
const MEDIA = {
  online: { label: "Online", icon: faIcon("globe") },
  magazine: { label: "Magazine", icon: faIcon("book-open") },
  newspaper: { label: "Article", icon: faIcon("newspaper") },
  radio: { label: "Radio", icon: faIcon("radio") },
  tv: { label: "TV", icon: faIcon("tv") },
  opinion: { label: "Opinion", icon: faIcon("comment") },
  blog: { label: "Blog", icon: faIcon("blog") },
};

// Small icons inside the category pills — FEED ROWS ONLY (the Quick Search
// pills stay text-only). Keyed by lowercase subtype → a Font Awesome solid
// icon name (Sep 2026; the earlier hand-drawn SVG set stays in assets/icons/
// for reference). The icon takes the pill's colour through currentColor.
// Unknown subtypes simply get no icon, so new CSV categories degrade
// gracefully.
const CAT_ICONS = {
  // Opportunities
  "call for proposals": "bullhorn",
  "fellowships & programs": "lightbulb",
  "funding & grants": "sack-dollar",
  // Events — ERC Events shares the star with ERC Research (both = "ours").
  "erc events": "star",
  "texas a&m": "building-columns",
  "off-campus": "location-dot",
  online: "video",
  webinar: "video",
  "webinar-online": "video",
  // Research
  "erc research": "star",
  "peer-reviewed": "file-circle-check",
  report: "file-lines",
  "working paper": "file-pen",
  // Headlines. Texas keeps Kate's own outline of the state (no Font Awesome
  // equivalent in the free set); an object value means "mask this SVG".
  national: "flag-usa",
  texas: { svg: "texas.svg" },
};

// One category-pill icon: a Font Awesome name, or one of Kate's SVGs masked
// over currentColor so it takes the pill's colour like the others.
function catIconHTML(icon) {
  if (!icon) return "";
  if (typeof icon === "string") return faIcon(icon, "tag__icon");
  return `<span class="tag__icon tag__icon--svg" ${iconMask("icons/" + icon.svg)} aria-hidden="true"></span>`;
}

// Per-tab wording for the expanded detail's outbound link.
const DETAIL_LINK_LABEL = {
  opportunity: "View opportunity",
  event: "Event details",
  research: "Read the full paper",
};

// Shared helpers for the feed templates.
const SEP = `<span class="feed-meta-sep" aria-hidden="true">·</span>`;
const iconMask = (file) =>
  `style="-webkit-mask-image:url('assets/${file}');mask-image:url('assets/${file}')"`;
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
    return `<a class="feed-link" href="?brief=${id}" data-brief="${id}">Read the full brief ${faIcon("arrow-up-right-from-square")}</a>`;
  const link = (it.link || "").trim();
  return link
    ? `<a class="feed-link" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${DETAIL_LINK_LABEL[state.type] || "Read more"} ${faIcon("arrow-up-right-from-square")}</a>`
    : "";
};

// Column labels for the card table's frozen header, per tab.
// `expand: false` = rows don't expand in place; the row is a straight link to
// the source (Headlines: the blurb is just a teaser, the article is the point).
const CARD_HEADERS = {
  opportunity: { left: "Opportunity", right: "Deadline", expand: true },
  event: { left: "Event", right: "Date", expand: true },
  headline: { left: "Headline", right: "Date", expand: false },
  // Research: authors are the scan-key, so rows run three lines (title /
  // authors / source · category · date) and the date column moves off the
  // right edge — no right header label.
  research: { left: "Research", right: "", expand: true, authors: true },
};

// "A, B, C, D…" → "A, B, C, et al." for the collapsed row (full list shows in
// the expanded detail when truncated).
function shortAuthors(raw) {
  const names = raw
    .replace(/\s*&\s*/g, ", ")
    .split(/,\s*/)
    .filter(Boolean);
  if (names.length <= 3) return { text: raw, truncated: false };
  return { text: names.slice(0, 3).join(", ") + ", et al.", truncated: true };
}

// Build the card-tab toolbar: a Category group (only when there's more than one
// sub-category to choose between) and a Sort group of lighter text actions.
function renderToolbar() {
  const bar = $("#opp-toolbar");
  bar.hidden = false;
  const items = liveItemsOfType(state.type);
  const cur = activeSort();

  // Sort = lighter text actions (not boxed buttons like the category filters).
  const sortHTML = (TOOLBAR_SORTS[state.type] || [])
    .map((s) => {
      const active = cur.key === s.key && cur.dir === s.dir;
      return `<button type="button" class="tsort${active ? " is-active" : ""}" data-sortkey="${s.key}" data-sortdir="${s.dir}" aria-pressed="${active}">${esc(s.label)}</button>`;
    })
    .join(`<span class="tsort-sep" aria-hidden="true">·</span>`);
  // No visible "Sort" label — the options are self-describing; the group's
  // aria-label still announces it for assistive tech.
  const sortGroup = `
    <div class="tgroup tgroup--sort" role="group" aria-label="Sort by">
      ${sortHTML}
    </div>`;

  // Category filter buttons render on every tab — even with a single
  // sub-category — so the toolbar structure (SHOW row over SORT row) is
  // identical as you move between sections.
  const subs = sortSubtypes(distinct("subtype", items), state.type);
  const catBtns = subs
    .map((v) => {
      const active = state.subtype === v;
      return `<button type="button" class="tbtn${active ? " is-active" : ""}" data-subtype="${esc(v)}" aria-pressed="${active}">${esc(v)}</button>`;
    })
    .join("");
  // No "All" pill — clicking a category filters, and the quiet Clear text
  // action beside the pills resets to everything (dimmed until a filter is on).
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
      <span class="tgroup__label">Quick Search</span>${catBtns}${clearBtn}${archiveBtn}
    </div>`;

  // The count node is persistent (it is the live region screen readers track),
  // so detach it before the rebuild and seat it at the head of the sort row.
  const count = $("#news-count");
  bar.innerHTML = catGroup + sortGroup;
  if (count) bar.querySelector(".tgroup--sort").prepend(count);
  syncToolbarHeight();
}

// Publish the sticky toolbar's height as --toolbar-h so the table header can
// dock directly beneath it (the toolbar wraps to two rows on some tabs).
function syncToolbarHeight() {
  const bar = $("#opp-toolbar");
  document.documentElement.style.setProperty(
    "--toolbar-h",
    `${bar && !bar.hidden ? bar.offsetHeight : 0}px`
  );
}

// Every tab renders as card rows: category pill above the title, source (and
// medium / authors / date) below, expanding in place to the full blurb. The
// right-hand value is the deadline (Opportunities) or the date.
function renderFeedCards(results, colorFor, total = results.length) {
  const isOpp = state.type === "opportunity";
  const expandable = (CARD_HEADERS[state.type] || {}).expand !== false;
  const cards = results
    .map((it, i) => {
      const link = (it.link || "").trim();
      const source = (it.source || "").trim();
      const subtype = (it.subtype || "").trim();
      const catText = subtype || (it.type || "");
      // Category = a coloured pill above the title (the .tag palette), with a
      // small icon when the subtype has one in CAT_ICONS. When this subtype is
      // the active filter, the tag matches the selected pill's warm grey instead.
      const catClass =
        state.subtype !== "all" && subtype === state.subtype
          ? "tag--selected"
          : colorFor[subtype] || "tag--c0";
      const catIcon = CAT_ICONS[catText.trim().toLowerCase()] || "";
      const catHTML = `<div class="feed-item__cat"><span class="tag ${catClass}">${catIconHTML(catIcon)}${esc(catText)}</span></div>`;
      const detailId = `feed-detail-${i}`;
      // Right column: Opportunities show the deadline; Events show the event date.
      const rv = isOpp
        ? parseDeadline(it.deadline)
        : { label: it.date ? formatDate(it.date) : "", firm: !!it.date, iso: it.date || "" };
      // Flag anything happening within two weeks so urgency reads at a glance.
      const soon =
        rv.firm && rv.iso >= TODAY && daysUntil(rv.iso) <= 14
          ? " feed-deadline--soon"
          : "";
      const soonText = soon ? relativeDays(rv.iso, isOpp) : "";
      const deadlineHTML = rv.label
        ? `<span class="feed-deadline${soon}">${esc(rv.label)}${
            soonText
              ? `<span class="feed-deadline__days"> · ${esc(soonText)}</span><span class="sr-only"> closing soon</span>`
              : ""
          }</span>`
        : "";
      const titleHTML = itemTitleLink(it, expandable);
      const linkHTML = itemDetailLink(it);
      // Optional second action: a "View infographic" button when the CSV's
      // `infographic` cell holds a link. A Drive link opens in the in-app
      // viewer (like the brief); any other link opens in a new tab.
      const infographic = (it.infographic || "").trim();
      const igId = driveId(infographic);
      const infographicHTML = infographic
        ? igId
          ? `<a class="feed-link" href="?brief=${igId}" data-brief="${igId}" data-brief-title="${esc(it.headline)} infographic">View infographic ${faIcon("arrow-up-right-from-square")}</a>`
          : `<a class="feed-link" href="${esc(infographic)}" target="_blank" rel="noopener noreferrer">View infographic ${faIcon("arrow-up-right-from-square")}</a>`
        : "";
      const actionsHTML =
        linkHTML || infographicHTML
          ? `<div class="feed-actions">${linkHTML}${infographicHTML}</div>`
          : "";
      // Events and Opportunities lead their expanded detail with a standardized
      // facts panel beside the summary (two columns). Each fact renders only
      // when its CSV cell is filled, so sparse rows degrade gracefully.
      const fact = (label, valueHTML) =>
        valueHTML
          ? `<div class="feed-fact"><dt class="feed-fact__label">${label}</dt><dd class="feed-fact__value">${valueHTML}</dd></div>`
          : "";
      const actionLink = (label) =>
        link
          ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${label} ${faIcon("arrow-up-right-from-square")}</a>`
          : "";
      let factsHTML = "";
      if (state.type === "event") {
        factsHTML = `<dl class="feed-facts">${
          fact("Date", it.date ? esc(formatDate(it.date)) : "") +
          fact("Time", esc((it.time || "").trim())) +
          fact("Location", esc((it.location || "").trim())) +
          fact("Register", actionLink("Event page"))
        }</dl>`;
      } else if (isOpp) {
        // Deadline mirrors the collapsed row; Topic surfaces the CSV `topic`
        // (otherwise unshown); Apply is the actionable link.
        factsHTML = `<dl class="feed-facts">${
          fact("Deadline", rv.label ? esc(rv.label.replace(/^Due /, "")) : "") +
          fact("Topic", esc((it.topic || "").trim())) +
          fact("Apply", actionLink("Application page"))
        }</dl>`;
      }
      // Metadata line under the title: source · [icon] medium label (the
      // category rides in the pill above the title now). Both icon and label
      // come from the optional `medium` column; blank medium = source only.
      // Events add time · location here, so a reader can pick a webinar they
      // can attend without expanding every row.
      const med = MEDIA[(it.medium || "").trim().toLowerCase()];
      const mediumHTML = med
        ? `${SEP}<span class="feed-medium-type"><span class="feed-medium" aria-hidden="true">${med.icon}</span>${esc(med.label)}</span>`
        : "";
      const whenWhere =
        state.type === "event"
          ? [(it.time || "").trim(), (it.location || "").trim()]
              .filter(Boolean)
              .map((v) => `<span class="feed-medium-type">${esc(v)}</span>`)
              .join(SEP)
          : "";
      const metaHTML = [source ? `<span class="feed-source">${esc(source)}</span>${mediumHTML}` : "", whenWhere]
        .filter(Boolean)
        .join(SEP);
      const metaDivHTML = metaHTML
        ? `<div class="feed-item__meta">${metaHTML}</div>`
        : "";
      // Research: three-line row — title / authors / source · category · date.
      // The caret is the only thing on the right; the full author list rides in
      // the expanded detail when the collapsed line is truncated.
      if ((CARD_HEADERS[state.type] || {}).authors) {
        // Truncated ("…et al.") when collapsed; the same line un-truncates in
        // place on expand (CSS swaps the spans), so nothing jumps around.
        const a = shortAuthors((it.authors || "").trim());
        const authorsHTML = a.text
          ? a.truncated
            ? `<div class="feed-item__authors"><span class="authors-short">${esc(a.text)}</span><span class="authors-full">${esc(it.authors)}</span></div>`
            : `<div class="feed-item__authors">${esc(a.text)}</div>`
          : "";
        const line3 = [
          metaHTML,
          it.date
            ? `<span class="feed-meta-date">${formatDate(it.date)}</span>`
            : "",
        ]
          .filter(Boolean)
          .join(SEP);
        // feed-item--caret-only: the right cell holds just the chevron, so on
        // phones it tucks into the row's top-right corner instead of taking a line.
        return `
          <li class="feed-item feed-item--caret-only" data-expanded="false">
            <div class="feed-item__row">
              <div class="feed-item__body">
                ${catHTML}
                <div class="feed-item__title">${titleHTML}</div>
                ${authorsHTML}
                ${line3 ? `<div class="feed-item__meta">${line3}</div>` : ""}
              </div>
              <div class="feed-cell--due">
                <button type="button" class="feed-expand" aria-expanded="false" aria-controls="${detailId}" aria-label="Show abstract">${chevronIcon()}</button>
              </div>
            </div>
            <div class="feed-item__detail" id="${detailId}" hidden>
              <h3 class="feed-detail__label">Abstract</h3>
              <p class="feed-detail__blurb">${esc(it.blurb)}</p>
              ${actionsHTML}
            </div>
          </li>`;
      }
      // Non-expandable tabs (Headlines): no caret, no detail — the whole row is
      // a straight link to the source (data-href picked up by the delegated listener).
      if (!expandable) {
        return `
          <li class="feed-item feed-item--link"${link ? ` data-href="${esc(link)}"` : ""}>
            <div class="feed-item__row">
              <div class="feed-item__body">
                ${catHTML}
                <div class="feed-item__title">${titleHTML}</div>
                ${metaDivHTML}
              </div>
              <div class="feed-cell--due">
                ${deadlineHTML}
                ${link ? `${faIcon("arrow-up-right-from-square", "feed-goto")}` : ""}
              </div>
            </div>
          </li>`;
      }
      return `
        <li class="feed-item" data-expanded="false">
          <div class="feed-item__row">
            <div class="feed-item__body">
              ${catHTML}
              <div class="feed-item__title">${titleHTML}</div>
              ${metaDivHTML}
            </div>
            <div class="feed-cell--due">
              ${deadlineHTML}
              <button type="button" class="feed-expand" aria-expanded="false" aria-controls="${detailId}" aria-label="Show details">${chevronIcon()}</button>
            </div>
          </div>
          <div class="feed-item__detail${factsHTML ? " feed-item__detail--cols" : ""}" id="${detailId}" hidden>
            ${factsHTML}
            <div class="feed-detail__main">
              <p class="feed-detail__blurb">${esc(it.blurb)}</p>
              ${factsHTML ? "" : actionsHTML}
            </div>
          </div>
        </li>`;
    })
    .join("");
  // No column-header bar: the section title + the per-row category pills carry
  // the context, and each date labels itself ("Due …"). Keeps one maroon band
  // (the masthead) instead of two competing ones.
  return `
    <div class="feed feed--opp">
      <ul class="feed__list" role="list">${cards}</ul>
      ${showMoreHTML(total)}
    </div>`;
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
  syncToolbarHeight();
  const q = state.q.trim();
  // Search uses the same head as a section: a title, then the count where the
  // description line would be (no toolbar, so the count lives here).
  const head = $("#section-head");
  head.hidden = false;
  head.innerHTML = `<h2 class="section-head__title" tabindex="-1" data-focus-target>Search results</h2>`;
  head.append($("#news-count"));
  const results = state.items
    .filter((it) => !isExpired(it))
    .filter((it) =>
      [it.headline, it.blurb, it.source, it.authors, it.topic, it.subtype].some(
        (f) => matches(f || "", q)
      )
    )
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));

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
      const meta = [
        `<span class="feed-cat">${esc(sectionLabel[(it.type || "").toLowerCase()] || it.type)}</span>`,
        source ? `<span class="feed-source">${esc(source)}</span>` : "",
        it.date ? `<span class="feed-meta-date">${formatDate(it.date)}</span>` : "",
      ]
        .filter(Boolean)
        .join(SEP);
      return `
        <li class="feed-item feed-item--link feed-item--caret-only"${link ? ` data-href="${esc(link)}"` : ""}>
          <div class="feed-item__row">
            <div class="feed-item__body">
              <div class="feed-item__title">${titleHTML}</div>
              <div class="feed-item__meta">${meta}</div>
            </div>
            <div class="feed-cell--due">
              ${link ? `${faIcon("arrow-up-right-from-square", "feed-goto")}` : ""}
            </div>
          </div>
        </li>`;
    })
    .join("");

  // No header bar: the section head above carries the title and count, as on
  // every other list.
  list.innerHTML = `
    <div class="feed feed--opp">
      <ul class="feed__list" role="list">${rows}</ul>
      ${showMoreHTML(results.length)}
    </div>`;
}

// In-app viewer for an ERC Research Brief: title + authors up top, the PDF in
// Drive's embeddable /preview iframe, with an escape hatch out to Drive.
function renderBrief() {
  const it = state.items.find((x) => briefId(x) === state.brief);
  // Title: the matching brief row when there is one; otherwise whatever the
  // opener passed (an infographic isn't its own row) or a generic fallback.
  const label = it ? it.headline : state.briefTitle || "ERC Research";
  const driveView = `https://drive.google.com/file/d/${esc(state.brief)}/view`;
  const head = $("#section-head");
  if (head) head.hidden = true;
  $("#opp-toolbar").hidden = true;
  syncToolbarHeight();
  $("#news-count").textContent = "";
  $("#news-list").innerHTML = `
    <div class="brief">
      <h2 class="section-head__title brief__title" tabindex="-1" data-focus-target>${esc(label)}</h2>
      <div class="brief__bar">
        <button type="button" class="brief__back">${faIcon("arrow-left")}Back to Research</button>
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
        archiveMode ? " — Archive" : ""
      }</h2><p class="section-head__desc">${esc(
        archiveMode
          ? "Research published more than 60 days ago. Everything here still shows up in search."
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

  // Give each sub-category in the active tab its own pill colour (palette in
  // styles.css; MAROON_SUBS always wear the maroon pill).
  const tabSubs = sortSubtypes(
    distinct(
      "subtype",
      state.items.filter((it) => (it.type || "").toLowerCase() === state.type)
    ),
    state.type
  );
  const colorFor = {};
  let ci = 0;
  tabSubs.forEach((s) => {
    const key = s.trim().toLowerCase();
    colorFor[s] = MAROON_SUBS.has(key)
      ? "tag--maroon"
      : SUBTYPE_COLOR[key] || `tag--c${ci++ % 5}`;
  });

  if (results.length === 0) {
    list.innerHTML = `
      <div class="state">
        <strong>${archiveMode ? "Nothing in the archive yet" : "No matching updates"}</strong>
        Try clearing filters or picking a different category.
      </div>`;
    return;
  }

  list.innerHTML = renderFeedCards(
    results.slice(0, state.shown),
    colorFor,
    results.length
  );
}

// Toggle one item's detail via its caret button (the accessible expand
// control): data-expanded drives the row's collapsed/expanded styling, and the
// detail region named by aria-controls shows/hides.
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

async function boot() {
  readURL();
  try {
    const { rows, modified } = await loadCSV(NEWS_CSV);
    init(rows, modified);
  } catch (err) {
    // Visitors get plain words and a way out; the local-server hint appears
    // only when the page was opened from the file system, where fetch() is blocked.
    const local = window.location.protocol === "file:";
    $("#news-list").innerHTML = `
      <div class="state">
        <strong>We couldn't load the latest items</strong>
        ${
          local
            ? "This page needs to be served over http, not opened from the file system. From the project folder run <code>python3 -m http.server 8000</code>, then visit <code>http://localhost:8000</code>."
            : 'Refresh the page to try again. If it keeps happening, email <a href="mailto:erc@tamu.edu">erc@tamu.edu</a>.'
        }
        <div class="feed-actions state__actions"><button type="button" class="feed-link state__retry">Try again</button></div>
        <span class="state__hint">(${esc(err.message)})</span>
      </div>`;
    $(".state__retry").addEventListener("click", () => window.location.reload());
    console.error(err);
  }
}

document.addEventListener("DOMContentLoaded", boot);
