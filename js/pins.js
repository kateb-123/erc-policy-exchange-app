/* A pin's own words and picture (Kate, Oct 23, 2026: "fix cards too").
   The desk's Highlight page writes a card title, a summary and a photo on a
   pin in data/featured.json. The New & upcoming card shows them in place of
   the item's own; the item's row everywhere else stays as it is. The link is
   never changed, so hidden marks and the edit door's card choices still find it.
   Loaded before app.js; tests/pins.test.js holds it. */
function withPin(it, pin) {
  const clean = (v) => String(v == null ? "" : v).trim();
  const title = clean(pin && pin.title);
  const image = clean(pin && pin.image);
  const summary = clean(pin && pin.summary);
  return {
    it: Object.assign({}, it, title ? { headline: title } : {}, image ? { infographic: image } : {}),
    summary,
  };
}
