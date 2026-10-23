// The card's own words and picture on a pin (Kate, Oct 23: "fix cards too").
// Run from the repo: node tests/pins.test.js
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pins.js'), 'utf8') + '\nthis.withPin = withPin;', ctx);
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };

const it = { headline: 'Howdy Policy Trivia Night', link: 'https://example.org/trivia', infographic: 'https://example.org/own.jpg', blurb: 'The row\'s own summary.' };

ok('a pin with words and a photo shows them in the card', () => {
  const e = ctx.withPin(it, { key: it.link, until: '2026-11-01', title: 'Trivia Night', summary: 'Bring a team.', image: 'https://example.org/card.png' });
  assert.strictEqual(e.it.headline, 'Trivia Night');
  assert.strictEqual(e.it.infographic, 'https://example.org/card.png');
  assert.strictEqual(e.summary, 'Bring a team.');
  assert.strictEqual(e.it.link, it.link, 'the key is unchanged, so hidden marks and hero choices still find it');
  assert.strictEqual(it.headline, 'Howdy Policy Trivia Night', 'the row itself is never changed');
});
ok('a bare pin shows the item as it is', () => {
  const e = ctx.withPin(it, { key: it.link, until: '2026-11-01' });
  assert.strictEqual(e.it.headline, it.headline);
  assert.strictEqual(e.it.infographic, it.infographic);
  assert.strictEqual(e.summary, '');
});
ok('blank words are no words', () => {
  const e = ctx.withPin(it, { key: it.link, title: '  ', summary: ' ', image: '' });
  assert.strictEqual(e.it.headline, it.headline);
  assert.strictEqual(e.summary, '');
});
console.log(`${n} passed`);
