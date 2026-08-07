const fs = require('fs');
const path = require('path');
const { JSDOM } = require('/tmp/node_modules/jsdom');

const SITE = '/sessions/keen-relaxed-thompson/mnt/boardgames_calendar';
const API = 'http://localhost:8930';

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitFor(cond, timeout = 5000, step = 50) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await cond()) return true;
    await wait(step);
  }
  throw new Error('waitFor timed out');
}

function freshDom() {
  const html = fs.readFileSync(path.join(SITE, 'requests.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/requests.html', runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.fetch = fetch;
  dom.window.APP_CONFIG = { APPS_SCRIPT_URL: API };
  const requestsJs = fs.readFileSync(path.join(SITE, 'requests.js'), 'utf8');
  dom.window.eval(requestsJs);
  return dom;
}

// simulates identifying as name/email/pin via the "это вы" modal -- assumes it's already open
async function identifyVia(doc, name, email, pin) {
  doc.getElementById('inputName').value = name;
  doc.getElementById('inputEmail').value = email;
  doc.getElementById('inputPin').value = pin;
  doc.getElementById('saveWhoAmI').click();
  await waitFor(() => doc.getElementById('whoAmIOverlay').hidden === true, 5000);
}

function rowByGame(doc, name) {
  return Array.from(doc.querySelectorAll('.requests-row')).find(r => r.querySelector('.req-game').textContent === name);
}
function visibleGameNames(doc) {
  return Array.from(doc.querySelectorAll('.req-game')).map(el => el.textContent);
}

(async () => {
  // nav / static markup sanity check (shared across pages)
  const indexHtml = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
  const organizerHtml = fs.readFileSync(path.join(SITE, 'organizer.html'), 'utf8');
  const infoHtml = fs.readFileSync(path.join(SITE, 'info.html'), 'utf8');
  const requestsHtmlRaw = fs.readFileSync(path.join(SITE, 'requests.html'), 'utf8');
  [indexHtml, organizerHtml, infoHtml, requestsHtmlRaw].forEach((html, i) => {
    const label = ['index.html', 'organizer.html', 'info.html', 'requests.html'][i];
    if (!html.includes('href="index.html"') || !html.includes('href="requests.html"') || !html.includes('href="info.html"')) {
      throw new Error(label + ' is missing one of the 3 top-nav links');
    }
  });
  console.log('PASS: all 4 pages carry the shared top-nav (Календарь/Приём заявок/Важная информация)');

  // 0. "это вы" lives in its own prominent banner above the filter toolbar, not buried
  // inside the filters row itself
  if (!requestsHtmlRaw.includes('whoami-banner')) throw new Error('"это вы" should be its own .whoami-banner block');
  const whoamiIdx = requestsHtmlRaw.indexOf('whoami-banner');
  const filtersIdx = requestsHtmlRaw.indexOf('id="filters"');
  if (whoamiIdx === -1 || filtersIdx === -1 || whoamiIdx > filtersIdx) {
    throw new Error('.whoami-banner should come BEFORE the #filters toolbar in the markup');
  }
  console.log('PASS: "это вы" banner is positioned above the filter/sort toolbar');

  // 1. initial render: 3 catalog games (server-sorted by votes desc, then alphabetically)
  const dom = freshDom();
  const doc = dom.window.document;
  await waitFor(() => doc.getElementById('requestsList').querySelectorAll('.requests-row').length === 3);
  const rowNames = visibleGameNames(doc);
  if (!rowNames.includes('Каркассон') || !rowNames.includes('Манчкин') || !rowNames.includes('Активити')) {
    throw new Error('expected all 3 catalog games rendered, got: ' + rowNames);
  }
  if (rowNames.join(',') !== 'Каркассон,Активити,Манчкин') {
    throw new Error('default order should be votes desc (Каркассон has 2 seeded votes), alphabetical tie-break otherwise, got: ' + rowNames);
  }
  console.log('PASS: catalog games rendered, default order = votes desc then alphabetical ->', rowNames);
  if (!doc.getElementById('requestsHead').hidden === false) throw new Error('column header row should be visible once there are rows');

  const carcRow = rowByGame(doc, 'Каркассон');
  // офисы разделены ";", а не ",", именно чтобы запятая внутри адреса одного офиса
  // ("Москва (локер 5, 2 этаж)") не резала его на лишние куски -- проверяем, что
  // получилось ровно 2 офиса, а не 3
  const officeSpans = carcRow.querySelectorAll('.req-office');
  if (officeSpans.length !== 2) throw new Error('expected exactly 2 offices (comma inside one office must not split it), got: ' + officeSpans.length);
  if (!officeSpans[0].textContent.includes('локер 5, 2 этаж')) throw new Error('comma inside a single office address should survive intact, got: ' + officeSpans[0].textContent);
  const hostSpans = carcRow.querySelectorAll('.req-host');
  if (hostSpans.length !== 2) throw new Error('expected exactly 2 hosts (same ";" splitting as offices), got: ' + hostSpans.length);
  if (!Array.from(hostSpans).some(s => s.textContent.includes('Даша')) || !Array.from(hostSpans).some(s => s.textContent.includes('Игорь'))) {
    throw new Error('host chips missing expected names, got: ' + Array.from(hostSpans).map(s => s.textContent));
  }
  const carcBga = carcRow.querySelector('.req-bga');
  if (!carcBga || !carcBga.classList.contains('is-yes')) throw new Error('"can play on BGA" badge should render as is-yes when bgaAvailable is true');
  const carcVoteBtn = carcRow.querySelector('.vote-btn');
  if (carcVoteBtn.classList.contains('active')) throw new Error('vote button should not start active for this viewer (votes were seeded by other people)');
  if (!carcVoteBtn.textContent.includes('+ Поддержать') || !carcVoteBtn.textContent.includes('(2)')) {
    throw new Error('vote button should start as "+ Поддержать (2)" (2 seeded votes), got: ' + carcVoteBtn.textContent);
  }
  console.log('PASS: Каркассон row shows 2 office chips, 2 host chips, an is-yes BGA badge, and "+ Поддержать (2)"');

  const munchkinRow = rowByGame(doc, 'Манчкин');
  if (!munchkinRow.querySelector('.req-cell-office').textContent.includes('пока нет ни в одном офисе')) {
    throw new Error('a game with no office should say so explicitly');
  }
  if (!munchkinRow.querySelector('.req-cell-hosts').textContent.includes('пока не указано')) {
    throw new Error('a game with no hosts should say so explicitly');
  }
  const munchkinBga = munchkinRow.querySelector('.req-bga');
  if (!munchkinBga || !munchkinBga.classList.contains('is-no')) throw new Error('BGA badge should render as is-no when bgaAvailable is false');
  console.log('PASS: Манчкин row shows the "nothing yet" fallbacks for office/hosts, and an is-no BGA badge');

  // 2. city filter -- checks both the office AND the hosts text for a match
  doc.getElementById('cityFilter').value = 'Астрахань';
  doc.getElementById('cityFilter').dispatchEvent(new dom.window.Event('change'));
  if (visibleGameNames(doc).join(',') !== 'Активити') {
    throw new Error('filtering by "Астрахань" should show only Активити, got: ' + visibleGameNames(doc));
  }
  console.log('PASS: city filter (Астрахань) narrows the list down to the one matching game');

  doc.getElementById('cityFilter').value = 'Москва';
  doc.getElementById('cityFilter').dispatchEvent(new dom.window.Event('change'));
  if (visibleGameNames(doc).join(',') !== 'Каркассон') {
    throw new Error('filtering by "Москва" should show only Каркассон, got: ' + visibleGameNames(doc));
  }
  console.log('PASS: city filter (Москва) matches on the office column');

  doc.getElementById('cityFilter').value = '';
  doc.getElementById('cityFilter').dispatchEvent(new dom.window.Event('change'));
  if (visibleGameNames(doc).length !== 3) throw new Error('clearing the city filter should bring back all games');
  console.log('PASS: clearing the city filter ("Все города") restores the full list');

  // 3. alphabetical sort overrides the default votes-desc order
  doc.getElementById('sortSelect').value = 'az';
  doc.getElementById('sortSelect').dispatchEvent(new dom.window.Event('change'));
  if (visibleGameNames(doc).join(',') !== 'Активити,Каркассон,Манчкин') {
    throw new Error('А-Я sort should ignore vote count entirely, got: ' + visibleGameNames(doc));
  }
  console.log('PASS: "По алфавиту, А-Я" sorts purely alphabetically, ignoring votes');

  doc.getElementById('sortSelect').value = 'za';
  doc.getElementById('sortSelect').dispatchEvent(new dom.window.Event('change'));
  if (visibleGameNames(doc).join(',') !== 'Манчкин,Каркассон,Активити') {
    throw new Error('Я-А sort should be the exact reverse of А-Я, got: ' + visibleGameNames(doc));
  }
  console.log('PASS: "По алфавиту, Я-А" reverses it');

  doc.getElementById('sortSelect').value = 'votes';
  doc.getElementById('sortSelect').dispatchEvent(new dom.window.Event('change'));
  if (visibleGameNames(doc).join(',') !== 'Каркассон,Активити,Манчкин') {
    throw new Error('switching back to "По популярности" should restore the votes-desc order, got: ' + visibleGameNames(doc));
  }
  console.log('PASS: switching sort back to "По популярности" restores the server (votes desc) order');

  // 4. clicking vote with no identity set opens the "это вы" modal instead of voting
  rowByGame(doc, 'Каркассон').querySelector('.vote-btn').click();
  await waitFor(() => !doc.getElementById('whoAmIOverlay').hidden);
  console.log('PASS: voting with no saved identity opens "это вы" first');

  await identifyVia(doc, 'Тестовый Голосующий', 'req.voter1@beeline.ru', '1111');
  console.log('PASS: identified via "это вы" (name + email + PIN), same flow as the calendar page');

  // 5. now vote for real -- button becomes active, count increments from the 2 seeded votes
  rowByGame(doc, 'Каркассон').querySelector('.vote-btn').click();
  await waitFor(() => {
    const row = rowByGame(doc, 'Каркассон');
    return row && row.querySelector('.vote-btn').classList.contains('active');
  });
  const btnAfterVote = rowByGame(doc, 'Каркассон').querySelector('.vote-btn');
  if (!btnAfterVote.textContent.includes('✓ Поддержано') || !btnAfterVote.textContent.includes('(3)')) {
    throw new Error('after voting, button should read "✓ Поддержано (3)" (2 seeded + this one), got: ' + btnAfterVote.textContent);
  }
  console.log('PASS: voting activates the button and increments the count -> "✓ Поддержано (3)"');

  // 6. clicking again un-votes (toggle off), back down to the 2 seeded votes
  btnAfterVote.click();
  await waitFor(() => {
    const row = rowByGame(doc, 'Каркассон');
    return row && !row.querySelector('.vote-btn').classList.contains('active');
  });
  if (!rowByGame(doc, 'Каркассон').querySelector('.vote-btn').textContent.includes('(2)')) {
    throw new Error('clicking an active vote button should remove the vote, count back down to the 2 seeded votes');
  }
  console.log('PASS: clicking an active vote button toggles the vote off again (unvote)');

  // 7. one plюсик per game, but unlimited games -- same identity can also support Манчкин
  rowByGame(doc, 'Манчкин').querySelector('.vote-btn').click();
  await waitFor(() => {
    const row = rowByGame(doc, 'Манчкин');
    return row && row.querySelector('.vote-btn').classList.contains('active');
  });
  console.log('PASS: the same identified person can also support a different game (no cross-game exclusivity)');

  // 8. a second visitor sees the aggregate vote count but their own button starts inactive
  const dom2 = freshDom();
  dom2.window.localStorage.setItem('nastolki_me', JSON.stringify({ name: 'Второй Голосующий', email: 'req.voter2@beeline.ru' }));
  const doc2 = dom2.window.document;
  await waitFor(() => doc2.getElementById('requestsList').querySelectorAll('.requests-row').length === 3);
  const munchkinForVoter2 = rowByGame(doc2, 'Манчкин');
  if (munchkinForVoter2.querySelector('.vote-btn').classList.contains('active')) {
    throw new Error('a different visitor should not see someone else\'s vote as their own');
  }
  if (!munchkinForVoter2.querySelector('.vote-btn').textContent.includes('(1)')) {
    throw new Error('a different visitor should still see the aggregate count of 1');
  }
  console.log('PASS: a second visitor sees the aggregate vote count without inheriting someone else\'s vote');

  // 9. whoAmIBtn reflects the saved identity immediately on load (persisted localStorage)
  if (!doc2.getElementById('whoAmIBtn').textContent.includes('Второй Голосующий')) {
    throw new Error('whoAmIBtn should reflect the saved identity from localStorage');
  }
  console.log('PASS: saved identity (from localStorage, shared across pages) is reflected immediately');

  console.log('\nALL REQUESTS-PAGE TESTS PASSED');
  process.exit(0);
})().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
