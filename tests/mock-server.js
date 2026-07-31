const http = require('http');

const events = [
  { date: '2026-08-07', time: '18:00', city: 'Москва', format: 'Настольная игра', game: 'Таверна Красный дракон', place: 'Клубик', organizer: 'Даша', maxParticipants: 2, status: 'Набор открыт', note: '', difficulty: 'Средняя', maxDuration: 90, teseraUrl: 'https://tesera.ru/game/tavern/', bggUrl: 'https://boardgamegeek.com/boardgame/tavern', setting: 'фэнтези, таверна', imageUrl: 'https://example.com/tavern.jpg' },
  { date: '2026-08-08', time: '12:20', city: 'Санкт-Петербург', format: 'НРИ', game: 'Брасс Бирмингем', place: 'МПК', organizer: 'Даша', maxParticipants: null, status: 'Набрано', note: '', difficulty: '', maxDuration: null, teseraUrl: '', bggUrl: '', setting: '', imageUrl: '' },
  { date: '2026-08-04', time: '', city: 'Москва', format: 'Настольная игра', game: 'Descent', place: '', organizer: 'Влад', maxParticipants: null, status: 'Отменено', note: '', difficulty: '', maxDuration: null, teseraUrl: '', bggUrl: '', setting: '', imageUrl: '' },
  // deliberately in the past relative to "today" (sandbox clock is 2026-07-31) and still
  // marked "Набор открыт" -- exercises the client-side past-event override on its own
  { date: '2026-07-20', time: '18:30', city: 'Москва', format: 'Настольная игра', game: 'Корона из пепла', place: 'ШК', organizer: 'Настя', maxParticipants: null, status: 'Набор открыт', note: '', difficulty: '', maxDuration: null, teseraUrl: '', bggUrl: '', setting: '', imageUrl: '' },
];

let signups = [];

function eventKey(e) { return e.date + '|' + (e.time || '') + '|' + e.game; }

function computeActive(key) {
  const rows = signups.filter(s => (s.date + '|' + (s.time||'') + '|' + s.game) === key);
  const byEmail = {};
  rows.forEach(r => { byEmail[r.email] = r; });
  return Object.values(byEmail).filter(r => r.status === 'Записан');
}

function publicEvents() {
  return events.filter(e => ['Набор открыт','Набрано','Отменено'].includes(e.status)).map(e => {
    const key = eventKey(e);
    const active = computeActive(key);
    const isFull = e.maxParticipants ? active.length >= e.maxParticipants : false;
    const isOpen = e.status === 'Набор открыт' && !isFull;
    return {
      id: key, date: e.date, time: e.time, city: e.city, format: e.format, game: e.game,
      place: e.place, organizer: e.organizer, maxParticipants: e.maxParticipants, status: e.status,
      note: e.note, difficulty: e.difficulty || '', maxDuration: e.maxDuration || null,
      teseraUrl: e.teseraUrl || '', bggUrl: e.bggUrl || '', setting: e.setting || '', imageUrl: e.imageUrl || '',
      participantsCount: active.length, participantNames: active.map(a => a.name),
      isOpen, isFull
    };
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET') {
    const action = url.searchParams.get('action') || 'events';
    if (action === 'events') {
      const result = { ok: true, events: publicEvents() };
      const email = (url.searchParams.get('email') || '').toLowerCase();
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
        if (ev.maxParticipants && active.length >= ev.maxParticipants) { res.end(JSON.stringify({ ok: false, error: 'full' })); return; }
        signups.push({ date: payload.date, time: payload.time, game: payload.game, name: payload.name, email, status: 'Записан' });
        res.end(JSON.stringify({ ok: true, participantsCount: computeActive(key).length }));
        return;
      }
      if (payload.action === 'cancel') {
        signups.push({ date: payload.date, time: payload.time, game: payload.game, name: '', email, status: 'Отменено' });
        res.end(JSON.stringify({ ok: true, participantsCount: computeActive(key).length }));
        return;
      }
      if (payload.action === 'createEvent') {
        if (!payload.date || !payload.game || !payload.city || !payload.organizer) {
          res.end(JSON.stringify({ ok: false, error: 'missing fields' })); return;
        }
        const dupKey = eventKey({ date: payload.date, time: payload.time, game: payload.game });
        if (events.some(e => eventKey(e) === dupKey)) {
          res.end(JSON.stringify({ ok: false, error: 'duplicate' })); return;
        }
        events.push({
          date: payload.date, time: payload.time || '', city: payload.city, format: payload.format || '',
          game: payload.game, place: payload.place || '', organizer: payload.organizer,
          maxParticipants: payload.maxParticipants || null, status: 'Набор открыт', note: payload.note || '',
          difficulty: payload.difficulty || '', maxDuration: payload.maxDuration || null,
          teseraUrl: payload.teseraUrl || '', bggUrl: payload.bggUrl || '', setting: payload.setting || '',
          imageUrl: payload.imageUrl || ''
        });
        res.end(JSON.stringify({ ok: true, id: dupKey }));
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
