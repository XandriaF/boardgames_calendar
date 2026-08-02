const http = require('http');

const AMBASSADOR_SECRET = 'я-амбассадор';

function capitalizeFirst(s) {
  s = String(s || '').trim();
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function normalizeSecret(s) { return String(s || '').trim().toLowerCase(); }
function isAmbassador(secret) {
  const s = normalizeSecret(secret);
  return !!s && s === normalizeSecret(AMBASSADOR_SECRET);
}

const events = [
  { date: '2026-08-07', time: '18:00', city: 'Москва', format: 'Стратегия, Евро', game: 'Таверна Красный дракон', place: 'Клубик', organizer: 'Даша', organizerEmail: 'dasha@beeline.ru', maxParticipants: 2, status: 'Набор открыт', note: '', difficulty: 'Средняя', maxDuration: 90, teseraUrl: 'https://tesera.ru/game/tavern/', bggUrl: 'https://boardgamegeek.com/boardgame/tavern', setting: 'фэнтези, таверна', imageUrl: 'https://example.com/tavern.jpg' },
  { date: '2026-08-08', time: '12:20', city: 'Санкт-Петербург', format: 'НРИ', game: 'Брасс Бирмингем', place: 'МПК', organizer: 'Даша', organizerEmail: 'dasha@beeline.ru', maxParticipants: null, status: 'Набрано', note: '', difficulty: '', maxDuration: null, teseraUrl: '', bggUrl: '', setting: '', imageUrl: '' },
  { date: '2026-08-04', time: '', city: 'Москва', format: 'Стратегия', game: 'Descent', place: '', organizer: 'Влад', organizerEmail: 'vlad@beeline.ru', maxParticipants: null, status: 'Отменено', note: '', difficulty: '', maxDuration: null, teseraUrl: '', bggUrl: '', setting: '', imageUrl: '' },
  // deliberately in the past relative to "today" (sandbox clock is 2026-07-31) and still
  // marked "Набор открыт" -- exercises the client-side past-event override on its own
  { date: '2026-07-20', time: '18:30', city: 'Москва', format: 'Стратегия', game: 'Корона из пепла', place: 'ШК', organizer: 'Настя', organizerEmail: 'nastya@beeline.ru', maxParticipants: null, status: 'Набор открыт', note: '', difficulty: '', maxDuration: null, teseraUrl: '', bggUrl: '', setting: '', imageUrl: '' },
  // scheduled/private: not published yet -- only visible to olya@beeline.ru (its creator)
  // or anyone who knows the ambassador secret, until it's explicitly published
  { date: '2026-08-15', time: '19:00', city: 'Москва', format: 'Абстрактная', game: 'Тайный проект', place: '', organizer: 'Оля', organizerEmail: 'olya@beeline.ru', maxParticipants: null, status: 'Запланировано', note: '', difficulty: '', maxDuration: null, teseraUrl: '', bggUrl: '', setting: '', imageUrl: '' },
];

let signups = [];

function eventKey(e) { return e.date + '|' + (e.time || '') + '|' + e.game; }

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

function visibleEvents(viewerEmail, hasAmbassadorAccess) {
  viewerEmail = (viewerEmail || '').toLowerCase();
  return events.filter(e => {
    if (['Набор открыт', 'Набрано', 'Отменено'].includes(e.status)) return true;
    if (e.status === 'Запланировано') {
      return (viewerEmail && e.organizerEmail && viewerEmail === e.organizerEmail.toLowerCase()) || hasAmbassadorAccess;
    }
    return false;
  }).map(e => {
    const key = eventKey(e);
    const active = computeActive(key);
    const headcount = headcountOf(active);
    const isFull = e.maxParticipants ? headcount >= e.maxParticipants : false;
    const isOpen = e.status === 'Набор открыт' && !isFull;
    const interested = computeInterested(key);
    return {
      id: key, date: e.date, time: e.time, city: capitalizeFirst(e.city), format: e.format, game: capitalizeFirst(e.game),
      place: e.place, organizer: capitalizeFirst(e.organizer), organizerEmail: e.organizerEmail || '',
      maxParticipants: e.maxParticipants, status: e.status,
      note: e.note, difficulty: e.difficulty || '', maxDuration: e.maxDuration || null,
      teseraUrl: e.teseraUrl || '', bggUrl: e.bggUrl || '', setting: e.setting || '', imageUrl: e.imageUrl || '',
      participantsCount: headcount,
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
      const hasAmbassadorAccess = isAmbassador(url.searchParams.get('secret') || '');
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
        const hasAmbassadorAccess = isAmbassador(payload.secret || '');
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
        events.push({
          date: payload.date, time: payload.time || '', city: capitalizeFirst(payload.city), format: payload.format || '',
          game: capitalizeFirst(payload.game), place: payload.place || '', organizer: capitalizeFirst(payload.organizer),
          organizerEmail: (payload.organizerEmail || '').toLowerCase(),
          maxParticipants: payload.maxParticipants || null, status, note: payload.note || '',
          difficulty: payload.difficulty || '', maxDuration: payload.maxDuration || null,
          teseraUrl: payload.teseraUrl || '', bggUrl: payload.bggUrl || '', setting: payload.setting || '',
          imageUrl: payload.imageUrl || ''
        });
        res.end(JSON.stringify({ ok: true, id: dupKey, status }));
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
