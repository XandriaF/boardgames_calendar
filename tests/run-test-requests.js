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

  // 1. initial render: 2 catalog games, sorted, 0 votes each, "+ Поддержать" (not yet voted)
  const dom = freshDom();
  const doc = dom.window.document;
  await waitFor(() => doc.getElementById('requestsList').querySelectorAll('.requests-row').length === 2);
  const rowNames = Array.from(doc.querySelectorAll('.req-game')).map(el => el.textContent);
  if (!rowNames.includes('Каркассон') || !rowNames.includes('Манчкин')) {
    throw new Error('expected both catalog games rendered, got: ' + rowNames);
  }
  console.log('PASS: catalog games rendered ->', rowNames);

  const carcRow = Array.from(doc.querySelectorAll('.requests-row')).find(r => r.querySelector('.req-game').textContent === 'Каркассон');
  if (!carcRow.querySelector('.req-meta').textContent.includes('Москва')) throw new Error('office not rendered for Каркассон');
  // офисы разделены ";", а не ",", именно чтобы запятая внутри адреса одного офиса
  // ("Москва (локер 5, 2 этаж)") не резала его на лишние куски -- проверяем, что
  // получилось ровно 2 офиса, а не 3
  const officeSpans = carcRow.querySelectorAll('.req-meta span');
  if (officeSpans.length !== 2) throw new Error('expected exactly 2 offices (comma inside one office must not split it), got: ' + officeSpans.length);
  if (!officeSpans[0].textContent.includes('локер 5, 2 этаж')) throw new Error('comma inside a single office address should survive intact, got: ' + officeSpans[0].textContent);
  if (!carcRow.querySelector('.card-link')) throw new Error('BGG link should render for a game that has one');
  const carcVoteBtn = carcRow.querySelector('.vote-btn');
  if (carcVoteBtn.classList.contains('active')) throw new Error('vote button should not start active');
  if (!carcVoteBtn.textContent.includes('+ Поддержать') || !carcVoteBtn.textContent.includes('(0)')) {
    throw new Error('vote button should start as "+ Поддержать (0)", got: ' + carcVoteBtn.textContent);
  }
  console.log('PASS: Каркассон row shows office, BGG link, and an inactive "+ Поддержать (0)" button');

  const munchkinRow = Array.from(doc.querySelectorAll('.requests-row')).find(r => r.querySelector('.req-game').textContent === 'Манчкин');
  if (!munchkinRow.querySelector('.req-meta').textContent.includes('пока нет ни в одном офисе')) {
    throw new Error('a game with no office should say so explicitly');
  }
  console.log('PASS: a game with an empty "Офис" column shows the "нет ни в одном офисе" fallback');

  // 2. clicking vote with no identity set opens the "это вы" modal instead of voting
  carcVoteBtn.click();
  await waitFor(() => !doc.getElementById('whoAmIOverlay').hidden);
  console.log('PASS: voting with no saved identity opens "это вы" first');

  await identifyVia(doc, 'Тестовый Голосующий', 'req.voter1@beeline.ru', '1111');
  console.log('PASS: identified via "это вы" (name + email + PIN), same flow as the calendar page');

  // 3. now vote for real -- button becomes active, count increments
  const carcRow2 = Array.from(doc.querySelectorAll('.requests-row')).find(r => r.querySelector('.req-game').textContent === 'Каркассон');
  carcRow2.querySelector('.vote-btn').click();
  await waitFor(() => {
    const row = Array.from(doc.querySelectorAll('.requests-row')).find(r => r.querySelector('.req-game').textContent === 'Каркассон');
    return row && row.querySelector('.vote-btn').classList.contains('active');
  });
  const carcRow3 = Array.from(doc.querySelectorAll('.requests-row')).find(r => r.querySelector('.req-game').textContent === 'Каркассон');
  const btnAfterVote = carcRow3.querySelector('.vote-btn');
  if (!btnAfterVote.textContent.includes('✓ Поддержано') || !btnAfterVote.textContent.includes('(1)')) {
    throw new Error('after voting, button should read "✓ Поддержано (1)", got: ' + btnAfterVote.textContent);
  }
  console.log('PASS: voting activates the button and increments the count -> "✓ Поддержано (1)"');

  // 4. clicking again un-votes (toggle off)
  btnAfterVote.click();
  await waitFor(() => {
    const row = Array.from(doc.querySelectorAll('.requests-row')).find(r => r.querySelector('.req-game').textContent === 'Каркассон');
    return row && !row.querySelector('.vote-btn').classList.contains('active');
  });
  const carcRow4 = Array.from(doc.querySelectorAll('.requests-row')).find(r => r.querySelector('.req-game').textContent === 'Каркассон');
  if (!carcRow4.querySelector('.vote-btn').textContent.includes('(0)')) {
    throw new Error('clicking an active vote button should remove the vote, count back to 0');
  }
  console.log('PASS: clicking an active vote button toggles the vote off again (unvote)');

  // 5. one plюсик per game, but unlimited games -- same identity can also support Манчкин
  const munchkinRow2 = Array.from(doc.querySelectorAll('.requests-row')).find(r => r.querySelector('.req-game').textContent === 'Манчкин');
  munchkinRow2.querySelector('.vote-btn').click();
  await waitFor(() => {
    const row = Array.from(doc.querySelectorAll('.requests-row')).find(r => r.querySelector('.req-game').textContent === 'Манчкин');
    return row && row.querySelector('.vote-btn').classList.contains('active');
  });
  console.log('PASS: the same identified person can also support a different game (no cross-game exclusivity)');

  // 6. a second visitor sees the aggregate vote count but their own button starts inactive
  const dom2 = freshDom();
  dom2.window.localStorage.setItem('nastolki_me', JSON.stringify({ name: 'Второй Голосующий', email: 'req.voter2@beeline.ru' }));
  const doc2 = dom2.window.document;
  await waitFor(() => doc2.getElementById('requestsList').querySelectorAll('.requests-row').length === 2);
  const munchkinForVoter2 = Array.from(doc2.querySelectorAll('.requests-row')).find(r => r.querySelector('.req-game').textContent === 'Манчкин');
  if (munchkinForVoter2.querySelector('.vote-btn').classList.contains('active')) {
    throw new Error('a different visitor should not see someone else\'s vote as their own');
  }
  if (!munchkinForVoter2.querySelector('.vote-btn').textContent.includes('(1)')) {
    throw new Error('a different visitor should still see the aggregate count of 1');
  }
  console.log('PASS: a second visitor sees the aggregate vote count without inheriting someone else\'s vote');

  // 7. whoAmIBtn reflects the saved identity immediately on load (persisted localStorage)
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
