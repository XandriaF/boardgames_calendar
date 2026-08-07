const http = require('http');

const ROLE_AMBASSADOR = 'Амбассадор';

function capitalizeFirst(s) {
  s = String(s || '').trim();
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// NOTE on dates: fixtures meant to read as "upcoming" are deliberately anchored a full year
// out (2027) rather than right after whenever this file was last edited -- app.js hides
// "past" events by default, so a fixture pinned close to "today" eventually flips to past
// as real time marches on and silently breaks every test that counts visible cards. Only
// «Корона из пепла» below is meant to stay in the past -- any fixed past date works forever.
const events = [
  { date: '2027-08-07', time: '18:00', city: 'Москва', format: 'Стратегия, Евро', game: 'Таверна Красный дракон', place: 'Клубик', organizer: 'Даша', organizerEmail: 'dasha@beeline.ru', maxParticipants: 2, status: 'Набор открыт', note: '', difficulty: 'Средняя', maxDuration: 90, teseraUrl: 'https://tesera.ru/game/tavern/', bggUrl: 'https://boardgamegeek.com/boardgame/tavern', setting: 'фэнтези, таверна', imageUrl: 'https://example.com/tavern.jpg', isClosed: false, reservedCount: 0, type: 'game', games: [] },
  { date: '2027-08-08', time: '12:20', city: 'Санкт-Петербург', format: 'НРИ', game: 'Брасс Бирмингем', place: 'МПК', organizer: 'Даша', organizerEmail: 'dasha@beeline.ru', maxParticipants: null, status: 'Набрано', note: '', difficulty: '', maxDuration: null, teseraUrl: '', bggUrl: '', setting: '', imageUrl: '', isClosed: false, reservedCount: 0, type: 'game', games: [] },
  { date: '2027-08-04', time: '', city: 'Москва', format: 'Стратегия', game: 'Descent', place: '', organizer: 'Влад', organizerEmail: 'vlad@beeline.ru', maxParticipants: null, status: 'Отменено', note: '', difficulty: '', maxDuration: null, teseraUrl: '', bggUrl: '', setting: '', imageUrl: '', isClosed: false, reservedCount: 0, type: 'game', games: [] },
  // always in the past, regardless of when tests run -- still marked "Набор открыт", to
  // exercise the client-side past-event override on its own
  { date: '2026-07-20', time: '18:30', city: 'Москва', format: 'Стратегия', game: 'Корона из пепла', place: 'ШК', organizer: 'Настя', organizerEmail: 'nastya@beeline.ru', maxParticipants: null, status: 'Набор открыт', note: '', difficulty: '', maxDuration: null, teseraUrl: '', bggUrl: '', setting: '', imageUrl: '', isClosed: false, reservedCount: 0, type: 'game', games: [] },
  // scheduled/private: not published yet -- only visible to olya@beeline.ru (its creator)
  // or an ambassador, until it's explicitly published
  { date: '2027-08-15', time: '19:00', city: 'Москва', format: 'Абстрактная', game: 'Тайный проект', place: '', organizer: 'Оля', organizerEmail: 'olya@beeline.ru', maxParticipants: null, status: 'Запланировано', note: '', difficulty: '', maxDuration: null, teseraUrl: '', bggUrl: '', setting: '', imageUrl: '', isClosed: false, reservedCount: 0, type: 'game', games: [] },
  // closed/private: publicly-statused but hidden from the general grid -- visible only to
  // its organizer, ambassadors, or its (pre-added) participants
  { date: '2027-08-20', time: '18:00', city: 'Москва', format: 'Кооперативная', game: 'Секретный клуб', place: '', organizer: 'Оля', organizerEmail: 'olya@beeline.ru', maxParticipants: null, status: 'Набор открыт', note: '', difficulty: '', maxDuration: null, teseraUrl: '', bggUrl: '', setting: '', imageUrl: '', isClosed: true, reservedCount: 0, type: 'game', games: [] },
];

let signups = [];
// { email: { name, pin, role } } -- mirrors the «Аккаунты» sheet
let accounts = {};

// «Приём заявок» -- каталог игр (лист «Заявки», пополняется только вручную) + событийный
// лог голосов (лист «Заявки_голоса»), один плюсик на игру на человека, игр -- сколько угодно
const requests = [
  { game: 'Каркассон', office: 'Москва (локер 5, 2 этаж); Санкт-Петербург', bgaAvailable: true },
  { game: 'Манчкин', office: '', bgaAvailable: false },
];
let votes = [];

// pre-seed the closed event's fixture with one participant so visibility tests have
// something to assert against
signups.push({ date: '2027-08-20', time: '18:00', game: 'Секретный клуб', name: 'Петя', email: 'petya@beeline.ru', status: 'Записан', guests: 0 });

function eventKey(e) { return e.date + '|' + (e.time || '') + '|' + e.game; }
function requestKey(game) { return String(game || '').trim().toLowerCase(); }

function computeActive(key) {
  const rows = signups.filter(s => (s.date + '|' + (s.time||'') + '|' + s.game) === key);
  const byEmail = {};
  rows.forEach(r => { byEmail[r.email] = r; });
  return Object.values(byEmail).filter(r => r.status === 'Записан');
}

function computeInterested(key) {
  const rows = signups.filter(s => (s.date + '|' + (s.time||'') + '|' + s.game) === key);
  const byEmail = {};
  rows.forEach(r => { byEmail[r.email] = r; });
  return Object.values(byEmail).filter(r => r.status === 'Интересуюсь');
}

// each signup takes up 1 + guests seats
function headcountOf(active) {
  return active.reduce((sum, r) => sum + 1 + (r.guests || 0), 0);
}

function getAccountRole(email) {
  email = (email || '').toLowerCase();
  return (accounts[email] && accounts[email].role) || '';
}
function isAmbassadorEmail(email) {
  return getAccountRole(email) === ROLE_AMBASSADOR;
}

function computeActiveVotes(gameKey) {
  const rows = votes.filter(v => requestKey(v.game) === gameKey);
  const byEmail = {};
  rows.forEach(r => { byEmail[r.email] = r; }); // latest per email wins
  return Object.values(byEmail).filter(r => r.status === 'Голос');
}

function visibleRequests(viewerEmail) {
  viewerEmail = (viewerEmail || '').toLowerCase();
  const list = requests.map(req => {
    const key = requestKey(req.game);
    const active = computeActiveVotes(key);
    return {
      game: capitalizeFirst(req.game),
      office: req.office || '',
      bgaAvailable: !!req.bgaAvailable,
      votes: active.length,
      iVoted: !!viewerEmail && active.some(v => v.email === viewerEmail)
    };
  });
  list.sort((a, b) => (b.votes - a.votes) || a.game.localeCompare(b.game, 'ru'));
  return list;
}

function visibleEvents(viewerEmail, hasAmbassadorAccess) {
  viewerEmail = (viewerEmail || '').toLowerCase();
  return events.filter(e => {
    const key = eventKey(e);
    const active = computeActive(key);
    const isOrganizerOrAmbassador = (viewerEmail && e.organizerEmail && viewerEmail === e.organizerEmail.toLowerCase()) || hasAmbassadorAccess;
    const isParticipant = !!viewerEmail && active.some(a => a.email === viewerEmail);
    if (e.status === 'Запланировано') return isOrganizerOrAmbassador;
    if (['Набор открыт', 'Набрано', 'Отменено'].includes(e.status)) {
      if (e.isClosed) return isOrganizerOrAmbassador || isParticipant;
      return true;
    }
    return false;
  }).map(e => {
    const key = eventKey(e);
    const active = computeActive(key);
    const reservedCount = e.reservedCount || 0;
    const headcount = headcountOf(active) + reservedCount;
    const isFull = e.maxParticipants ? headcount >= e.maxParticipants : false;
    const isOpen = e.status === 'Набор открыт' && !isFull && !e.isClosed;
    const interested = computeInterested(key);
    return {
      id: key, date: e.date, time: e.time, city: capitalizeFirst(e.city), format: e.format, game: capitalizeFirst(e.game),
      place: e.place, organizer: capitalizeFirst(e.organizer), organizerEmail: e.organizerEmail || '',
      maxParticipants: e.maxParticipants, status: e.status, isClosed: !!e.isClosed,
      type: e.type === 'event' ? 'event' : 'game',
      games: e.games || [],
      note: e.note, difficulty: e.difficulty || '', maxDuration: e.maxDuration || null,
      teseraUrl: e.teseraUrl || '', bggUrl: e.bggUrl || '', setting: e.setting || '', imageUrl: e.imageUrl || '',
      participantsCount: headcount,
      reservedCount: reservedCount,
      participants: active.map(a => ({ name: capitalizeFirst(a.name), email: a.email, guests: a.guests || 0 })),
      isOpen, isFull, interestCount: interested.length
    };
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET') {
    const action = url.searchParams.get('action') || 'events';
    if (action === 'events') {
      const email = (url.searchParams.get('email') || '').toLowerCase();
      const hasAmbassadorAccess = email ? isAmbassadorEmail(email) : false;
      const result = { ok: true, events: visibleEvents(email, hasAmbassadorAccess) };
      if (email) {
        const registered = [];
        events.forEach(e => {
          const key = eventKey(e);
          const active = computeActive(key);
          if (active.some(a => a.email === email)) registered.push(key);
        });
        result.registeredIds = registered;
      }
      res.end(JSON.stringify(result));
      return;
    }
    if (action === 'myStatus') {
      const email = (url.searchParams.get('email') || '').toLowerCase();
      const registered = [];
      events.forEach(e => {
        const key = eventKey(e);
        const active = computeActive(key);
        if (active.some(a => a.email === email)) registered.push(key);
      });
      res.end(JSON.stringify({ ok: true, registered }));
      return;
    }
    if (action === 'requests') {
      const email = (url.searchParams.get('email') || '').toLowerCase();
      res.end(JSON.stringify({ ok: true, requests: visibleRequests(email) }));
      return;
    }
    res.end(JSON.stringify({ ok: false, error: 'unknown action' }));
    return;
  }
  if (req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const payload = JSON.parse(body);
      const email = (payload.email || '').toLowerCase();
      const key = payload.date + '|' + (payload.time || '') + '|' + payload.game;
      const ev = events.find(e => eventKey(e) === key);
      if (payload.action === 'signup') {
        if (!ev) { res.end(JSON.stringify({ ok: false, error: 'event not found' })); return; }
        if (ev.status === 'Отменено') { res.end(JSON.stringify({ ok: false, error: 'event cancelled' })); return; }
        if (ev.isClosed) { res.end(JSON.stringify({ ok: false, error: 'closed' })); return; }
        const active = computeActive(key);
        const guests = Math.max(0, Math.min(10, Math.floor(Number(payload.guests) || 0)));
        const requested = 1 + guests;
        if (ev.maxParticipants && headcountOf(active) + requested > ev.maxParticipants) {
          res.end(JSON.stringify({ ok: false, error: 'full' })); return;
        }
        signups.push({ date: payload.date, time: payload.time, game: payload.game, name: capitalizeFirst(payload.name), email, status: 'Записан', guests });
        res.end(JSON.stringify({ ok: true, participantsCount: headcountOf(computeActive(key)) }));
        return;
      }
      if (payload.action === 'interest') {
        if (!payload.date || !payload.game || !payload.name || !email) {
          res.end(JSON.stringify({ ok: false, error: 'missing fields' })); return;
        }
        if (ev && ev.isClosed) { res.end(JSON.stringify({ ok: false, error: 'closed' })); return; }
        const activeMine = computeActive(key).find(a => a.email === email);
        if (activeMine) { res.end(JSON.stringify({ ok: true })); return; }
        signups.push({ date: payload.date, time: payload.time, game: payload.game, name: capitalizeFirst(payload.name), email, status: 'Интересуюсь', guests: 0 });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (payload.action === 'cancel') {
        // pull the name from their latest row for this event, so the cancellation log
        // entry doesn't end up with a blank name
        const priorRows = signups.filter(s => (s.date + '|' + (s.time||'') + '|' + s.game) === key && s.email === email);
        const priorName = priorRows.length ? priorRows[priorRows.length - 1].name : '';
        signups.push({ date: payload.date, time: payload.time, game: payload.game, name: priorName, email, status: 'Отменено', guests: 0 });
        res.end(JSON.stringify({ ok: true, participantsCount: headcountOf(computeActive(key)) }));
        return;
      }
      if (payload.action === 'publish') {
        if (!ev) { res.end(JSON.stringify({ ok: false, error: 'event not found' })); return; }
        const hasAmbassadorAccess = email ? isAmbassadorEmail(email) : false;
        const isCreator = !!email && !!ev.organizerEmail && email === ev.organizerEmail.toLowerCase();
        if (!isCreator && !hasAmbassadorAccess) { res.end(JSON.stringify({ ok: false, error: 'forbidden' })); return; }
        if (ev.status !== 'Запланировано') { res.end(JSON.stringify({ ok: false, error: 'not scheduled' })); return; }
        ev.status = 'Набор открыт';
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (payload.action === 'createEvent') {
        if (!payload.date || !payload.game || !payload.city || !payload.organizer || !payload.organizerEmail) {
          res.end(JSON.stringify({ ok: false, error: 'missing fields' })); return;
        }
        const dupKey = eventKey({ date: payload.date, time: payload.time, game: payload.game });
        if (events.some(e => eventKey(e) === dupKey)) {
          res.end(JSON.stringify({ ok: false, error: 'duplicate' })); return;
        }
        const status = payload.publishNow === false ? 'Запланировано' : 'Набор открыт';
        const type = payload.eventType === 'event' ? 'event' : 'game';
        // «закрытое» не имеет смысла для «событий» -- принудительно снимаем, как и в Code.gs
        const isClosed = type === 'event' ? false : !!payload.isClosed;
        // «Событие» может опционально нести список настольных игр -- те же поля, что и у
        // обычного анонса игры; для типа «Игра» игнорируется, как и в Code.gs
        const games = type === 'event' && Array.isArray(payload.games)
          ? payload.games.filter(g => g && g.game && String(g.game).trim()).map(g => ({
              game: capitalizeFirst(String(g.game).trim()),
              format: g.format || '', difficulty: g.difficulty || '',
              maxDuration: g.maxDuration || null, setting: g.setting || '',
              teseraUrl: g.teseraUrl || '', bggUrl: g.bggUrl || '', imageUrl: g.imageUrl || ''
            }))
          : [];
        events.push({
          date: payload.date, time: payload.time || '', city: capitalizeFirst(payload.city), format: payload.format || '',
          game: capitalizeFirst(payload.game), place: payload.place || '', organizer: capitalizeFirst(payload.organizer),
          organizerEmail: (payload.organizerEmail || '').toLowerCase(),
          maxParticipants: payload.maxParticipants || null, status, note: payload.note || '',
          difficulty: payload.difficulty || '', maxDuration: payload.maxDuration || null,
          teseraUrl: payload.teseraUrl || '', bggUrl: payload.bggUrl || '', setting: payload.setting || '',
          imageUrl: payload.imageUrl || '', isClosed, reservedCount: 0, type, games
        });
        if (isClosed && Array.isArray(payload.closedParticipants)) {
          payload.closedParticipants.forEach(p => {
            const pEmail = (p && p.email || '').toLowerCase().trim();
            if (!pEmail) return;
            const pName = capitalizeFirst((p && p.name) || pEmail.split('@')[0]);
            signups.push({ date: payload.date, time: payload.time || '', game: capitalizeFirst(payload.game), name: pName, email: pEmail, status: 'Записан', guests: 0 });
          });
        }
        res.end(JSON.stringify({ ok: true, id: dupKey, status }));
        return;
      }
      if (payload.action === 'adjustReserved') {
        if (!ev) { res.end(JSON.stringify({ ok: false, error: 'event not found' })); return; }
        const delta = Math.trunc(Number(payload.delta) || 0);
        if (!payload.date || !payload.game || !delta) { res.end(JSON.stringify({ ok: false, error: 'missing fields' })); return; }
        const hasAmbassadorAccess = email ? isAmbassadorEmail(email) : false;
        const isCreator = !!email && !!ev.organizerEmail && email === ev.organizerEmail.toLowerCase();
        if (!isCreator && !hasAmbassadorAccess) { res.end(JSON.stringify({ ok: false, error: 'forbidden' })); return; }
        const headcount = headcountOf(computeActive(key));
        let next = (ev.reservedCount || 0) + delta;
        if (next < 0) next = 0;
        if (ev.maxParticipants && headcount + next > ev.maxParticipants) {
          res.end(JSON.stringify({ ok: false, error: 'full' })); return;
        }
        ev.reservedCount = next;
        res.end(JSON.stringify({ ok: true, reservedCount: next, participantsCount: headcount + next }));
        return;
      }
      if (payload.action === 'identify') {
        const name = capitalizeFirst((payload.name || '').trim());
        const idEmail = (payload.email || '').toLowerCase().trim();
        const pin = String(payload.pin || '').trim();
        if (!name || !idEmail) { res.end(JSON.stringify({ ok: false, error: 'missing_fields' })); return; }
        if (!/^\d{4}$/.test(pin)) { res.end(JSON.stringify({ ok: false, error: 'invalid_pin' })); return; }
        const existing = accounts[idEmail];
        if (!existing) {
          accounts[idEmail] = { name, pin, role: 'Участник' };
          res.end(JSON.stringify({ ok: true, isNew: true }));
          return;
        }
        if (existing.pin !== pin) { res.end(JSON.stringify({ ok: false, error: 'wrong_pin' })); return; }
        existing.name = name;
        res.end(JSON.stringify({ ok: true, isNew: false }));
        return;
      }
      if (payload.action === 'vote' || payload.action === 'unvote') {
        const game = String(payload.game || '').trim();
        if (!game || !email) { res.end(JSON.stringify({ ok: false, error: 'missing fields' })); return; }
        const found = requests.some(r => requestKey(r.game) === requestKey(game));
        if (!found) { res.end(JSON.stringify({ ok: false, error: 'not found' })); return; }
        const status = payload.action === 'vote' ? 'Голос' : 'Отмена';
        votes.push({ game, name: capitalizeFirst(payload.name || ''), email, status });
        const active = computeActiveVotes(requestKey(game));
        res.end(JSON.stringify({ ok: true, votes: active.length, iVoted: status === 'Голос' }));
        return;
      }
      // test-only backdoor: in real life a role is only ever set by editing the
      // «Аккаунты» sheet by hand -- this simulates that manual edit for the test suite,
      // it does not exist as an action in the real Code.gs
      if (payload.action === 'test_setRole') {
        const rEmail = (payload.email || '').toLowerCase().trim();
        if (!rEmail) { res.end(JSON.stringify({ ok: false, error: 'missing_fields' })); return; }
        if (!accounts[rEmail]) accounts[rEmail] = { name: rEmail.split('@')[0], pin: '0000', role: payload.role || 'Участник' };
        else accounts[rEmail].role = payload.role || 'Участник';
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.end(JSON.stringify({ ok: false, error: 'unknown action' }));
    });
    return;
  }
  res.end('{}');
});

const PORT = process.env.PORT || 8930;
server.listen(PORT, () => console.log('mock server on', PORT));
