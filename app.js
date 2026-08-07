(function () {
  'use strict';

  var API_URL = (window.APP_CONFIG && window.APP_CONFIG.APPS_SCRIPT_URL) || '';

  var state = {
    events: [],
    registeredIds: [],     // event ids current user is signed up for
    activeCity: 'Все',
    activeFormat: 'Все',
    showPast: false,       // past events are hidden by default, revealed via togglePastBtn
    pendingSignupEvent: null,
    pendingInterestEvent: null,
    hashHandled: false
  };

  var STATUS_LABEL = {
    'Набор открыт': 'Идёт запись',
    'Набрано': 'Мест нет',
    'Отменено': 'Отменено'
  };

  var WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  var MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

  function fmtDate(iso) {
    var d = new Date(iso + 'T00:00:00');
    if (isNaN(d)) return iso;
    return WEEKDAYS[d.getDay()] + ', ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
  }

  // defensive, client-side mirror of Code.gs's capitalizeFirst() -- the backend already
  // capitalizes on write, but this also covers rows edited by hand straight in the sheet
  function capitalizeFirst(s) {
    s = String(s || '').trim();
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // «Жанр» can hold several comma-separated values (same pattern as «Сеттинг»)
  function splitList(s) {
    return String(s || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  }

  // same algorithm as organizer.js -- used to build a stable, linkable #anchor per event
  function slugifyEventId(date, time, game) {
    var raw = (date + '-' + (time || '') + '-' + game).toLowerCase();
    return 'ev-' + raw.replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-+|-+$/g, '');
  }

  // an event with a time counts as past once that moment has passed; an event with no
  // time given is treated as lasting the whole day, so it only flips to "past" after midnight
  function isPastEvent(ev, now) {
    now = now || new Date();
    var dt = ev.time ? new Date(ev.date + 'T' + ev.time + ':00') : new Date(ev.date + 'T23:59:59');
    if (isNaN(dt)) return false;
    return dt.getTime() < now.getTime();
  }

  // ---------- persistence of "who am I" ----------
  function getMe() {
    try {
      return JSON.parse(localStorage.getItem('nastolki_me') || 'null');
    } catch (e) { return null; }
  }
  function setMe(me) {
    localStorage.setItem('nastolki_me', JSON.stringify(me));
  }

  // the "это вы" button never reflected a saved identity -- it always said
  // "указать имя и почту" even right after saving. Show the saved name and email instead.
  function renderWhoAmI() {
    var me = getMe();
    var label = (me && me.name) ? me.name + (me.email ? ' · ' + me.email : '') : 'указать имя и почту';
    document.getElementById('whoAmIBtn').textContent = label;
  }

  // ---------- API ----------
  function apiGet(action, params) {
    var url = API_URL + '?action=' + encodeURIComponent(action);
    Object.keys(params || {}).forEach(function (k) {
      url += '&' + k + '=' + encodeURIComponent(params[k]);
    });
    // cache-bust: identical GET URLs (e.g. ?action=events) can otherwise be served from the
    // browser's HTTP cache, so a signup/cancel that changed the sheet doesn't show up on refresh
    url += '&_ts=' + Date.now();
    return fetch(url, { cache: 'no-store' }).then(function (r) { return r.json(); });
  }

  function apiPost(payload) {
    // text/plain avoids a CORS preflight against the Apps Script endpoint
    return fetch(API_URL, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); });
  }

  // ---------- rendering ----------
  function uniqueSorted(arr) {
    return Array.from(new Set(arr.filter(Boolean))).sort(function (a, b) { return a.localeCompare(b, 'ru'); });
  }

  function renderChips(containerId, values, activeVal, onPick) {
    var el = document.getElementById(containerId);
    el.innerHTML = '';
    var all = ['Все'].concat(values);
    all.forEach(function (val) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip' + (val === activeVal ? ' active' : '');
      chip.textContent = val;
      chip.addEventListener('click', function () { onPick(val); });
      el.appendChild(chip);
    });
  }

  function renderFilters() {
    var cities = uniqueSorted(state.events.map(function (e) { return e.city; }));
    // «Жанр» can hold several comma-separated values per event -- collect the union of
    // individual genres across all events, not the raw (possibly multi-value) strings
    var formatsSet = [];
    state.events.forEach(function (e) {
      splitList(e.format).forEach(function (f) {
        if (formatsSet.indexOf(f) === -1) formatsSet.push(f);
      });
    });
    var formats = uniqueSorted(formatsSet);
    renderChips('cityChips', cities, state.activeCity, function (val) {
      state.activeCity = val;
      renderFilters();
      renderGrid();
    });
    renderChips('formatChips', formats, state.activeFormat, function (val) {
      state.activeFormat = val;
      renderFilters();
      renderGrid();
    });
  }

  function statCard(label, value, sub) {
    var div = document.createElement('div');
    div.className = 'card-s';
    var capTop = document.createElement('div');
    capTop.className = 'cap';
    capTop.textContent = label;
    var n = document.createElement('div');
    n.className = 'n';
    n.textContent = value;
    var capBottom = document.createElement('div');
    capBottom.className = 'cap mut';
    capBottom.textContent = sub;
    div.appendChild(capTop);
    div.appendChild(n);
    div.appendChild(capBottom);
    return div;
  }

  function renderStats() {
    var el = document.getElementById('statsRow');
    var total = state.events.length;
    var cities = uniqueSorted(state.events.map(function (e) { return e.city; })).length;
    var upcoming = state.events
      .filter(function (e) { return e.status !== 'Отменено' && !isPastEvent(e); })
      .slice()
      .sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); });
    var nearest = upcoming[0];
    var nearestLabel = nearest ? (fmtDate(nearest.date) + (nearest.time ? ', ' + nearest.time : '')) : '—';
    var nearestSub = nearest ? nearest.game : 'пока ничего не запланировано';

    el.innerHTML = '';
    el.appendChild(statCard('мероприятий', String(total), 'сейчас доступны'));
    el.appendChild(statCard('городов', String(cities), 'участвует в программе'));
    el.appendChild(statCard('ближайшее', nearestLabel, nearestSub));
  }

  function passesFilter(ev) {
    var cityOk = state.activeCity === 'Все' || ev.city === state.activeCity;
    var formatOk = state.activeFormat === 'Все' || splitList(ev.format).indexOf(state.activeFormat) !== -1;
    var pastOk = state.showPast || !isPastEvent(ev);
    return cityOk && formatOk && pastOk;
  }

  function renderPastToggle() {
    var btn = document.getElementById('togglePastBtn');
    btn.textContent = state.showPast ? 'скрыть прошедшие' : 'показать прошедшие';
    btn.classList.toggle('active', state.showPast);
  }

  function renderGrid() {
    var grid = document.getElementById('eventsGrid');
    var list = state.events.filter(passesFilter).slice().sort(function (a, b) {
      var aPast = isPastEvent(a), bPast = isPastEvent(b);
      if (aPast !== bPast) return aPast ? 1 : -1; // upcoming events always float above past ones
      var key = function (e) { return e.date + (e.time || ''); };
      return aPast
        ? key(b).localeCompare(key(a))  // past: most recently happened first
        : key(a).localeCompare(key(b)); // upcoming: soonest first
    });
    grid.innerHTML = '';

    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Пока нет мероприятий с такими фильтрами 🎲';
      grid.appendChild(empty);
      return;
    }

    list.forEach(function (ev) {
      grid.appendChild(renderCard(ev));
    });
  }

  function renderCard(ev) {
    var past = isPastEvent(ev);
    var card = document.createElement('div');
    card.className = 'card';
    card.id = slugifyEventId(ev.date, ev.time, ev.game);
    if (ev.status === 'Отменено') card.classList.add('is-cancelled');
    else if (past) card.classList.add('is-past');
    if (ev.isFull) card.classList.add('is-full');

    var top = document.createElement('div');
    top.className = 'card-top';
    var dateEl = document.createElement('span');
    dateEl.className = 'card-date';
    dateEl.textContent = fmtDate(ev.date) + (ev.time ? ' · ' + ev.time : '');
    var badge = document.createElement('span');
    var badgeClass, badgeText;
    if (ev.status === 'Запланировано') {
      badgeClass = 'badge-planned';
      badgeText = 'Запланировано';
    } else if (ev.status === 'Отменено') {
      badgeClass = 'badge-cancelled';
      badgeText = STATUS_LABEL[ev.status] || ev.status;
    } else if (past) {
      badgeClass = 'badge-past';
      badgeText = 'Уже прошло';
    } else if (ev.type === 'event') {
      // «Событие» -- просто отметка, без записи и мест, поэтому не «Идёт запись»/«Мест нет»
      badgeClass = 'badge-open';
      badgeText = 'Событие';
    } else {
      badgeClass = ev.isOpen ? 'badge-open' : 'badge-full';
      badgeText = STATUS_LABEL[ev.status] || ev.status;
    }
    badge.className = 'badge ' + badgeClass;
    badge.textContent = badgeText;
    top.appendChild(dateEl);
    top.appendChild(badge);

    var image = null;
    if (ev.imageUrl) {
      image = document.createElement('img');
      image.className = 'card-image';
      image.src = ev.imageUrl;
      image.alt = ev.game;
      image.loading = 'lazy';
      // a bad/expired link should just quietly disappear, not show a broken-image icon
      image.addEventListener('error', function () { image.remove(); });
    }

    var game = document.createElement('div');
    game.className = 'card-game';
    game.textContent = capitalizeFirst(ev.game);

    var tags = document.createElement('div');
    tags.className = 'card-tags';
    var tagValues = [capitalizeFirst(ev.city)];
    if (ev.isClosed) tagValues.push('Закрытое');
    splitList(ev.format).forEach(function (t) { tagValues.push(t); });
    if (ev.difficulty) tagValues.push(ev.difficulty);
    if (ev.setting) {
      splitList(ev.setting).forEach(function (s) { tagValues.push(s); });
    }
    tagValues.filter(Boolean).forEach(function (t) {
      var tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = t;
      tags.appendChild(tag);
    });

    var meta = document.createElement('div');
    meta.className = 'card-meta';
    if (ev.place) meta.appendChild(metaLine('Где', ev.place));
    if (ev.organizer) meta.appendChild(metaLine('Организатор', capitalizeFirst(ev.organizer), ev.organizerEmail));
    if (ev.maxDuration) meta.appendChild(metaLine('Время партии', '~' + ev.maxDuration + ' мин (при полном столе)'));

    var links = null;
    if (ev.teseraUrl || ev.bggUrl) {
      links = document.createElement('div');
      links.className = 'card-links';
      if (ev.teseraUrl) links.appendChild(externalLink('Тесера', ev.teseraUrl));
      if (ev.bggUrl) links.appendChild(externalLink('Об игре подробнее (bgg)', ev.bggUrl));
    }

    // «Событие» -- просто отметка (описание/где/когда), без записи и без счётчика мест,
    // поэтому блок участников/интереса/резерва для него не строится вовсе
    var isEventType = ev.type === 'event';

    var participants = null;
    if (!isEventType) {
      participants = document.createElement('div');
      participants.className = 'card-participants';
      var countText = ev.maxParticipants
        ? (ev.participantsCount + ' из ' + ev.maxParticipants + ' (свободно: ' + Math.max(0, ev.maxParticipants - ev.participantsCount) + ')')
        : (ev.participantsCount + ' записалось');
      participants.innerHTML = '<b>' + countText + '</b>';
      if (ev.participants && ev.participants.length) {
        var namesWrap = document.createElement('span');
        namesWrap.className = 'names';
        namesWrap.appendChild(document.createTextNode(' — '));
        ev.participants.forEach(function (p, i) {
          if (i > 0) namesWrap.appendChild(document.createTextNode(', '));
          var pName = document.createElement('span');
          if (p.email) {
            pName.className = 'hoverable-email';
            pName.title = p.email;
          }
          pName.textContent = capitalizeFirst(p.name) + (p.guests ? ' +' + p.guests : '');
          namesWrap.appendChild(pName);
        });
        participants.appendChild(namesWrap);
      }
    }

    // «Событие» может опционально нести список настольных игр, которые там будут --
    // каждая со своими жанром/сложностью/ссылками, теми же полями, что и у обычного анонса
    var eventGamesBlock = null;
    if (isEventType && ev.games && ev.games.length) {
      eventGamesBlock = renderEventGamesBlock(ev.games);
    }

    var interestLine = null;
    if (!isEventType && ev.interestCount) {
      interestLine = document.createElement('div');
      interestLine.className = 'card-interest';
      interestLine.textContent = '🙋 ещё ' + ev.interestCount + ' ' + pluralizeWant(ev.interestCount) + ' сыграть в другое время';
    }

    // организатор может вручную отметить места как занятые (+/-), без имени/почты --
    // например, если часть игроков договорилась вне сайта. Виден только самому организатору.
    var reservedRow = null;
    var me = getMe();
    if (!isEventType && ev.status !== 'Отменено' && ev.organizerEmail && me && me.email && me.email === ev.organizerEmail) {
      reservedRow = renderReservedStepper(ev);
    }

    var isRegistered = state.registeredIds.indexOf(ev.id) !== -1;
    var actions = document.createElement('div');
    actions.className = 'card-actions';
    var actionBtn = renderActionButton(ev);
    if (actionBtn) actions.appendChild(actionBtn);
    // "проявить интерес" -- for people this exact date/time/place doesn't suit, but who'd
    // like to play the game some other time; not shown once already signed up, for
    // past/cancelled events, not-yet-published (Запланировано) ones, closed events
    // (which don't take open signups at all, so "interest" doesn't apply either), or
    // «события» (нет самой концепции записи/партии в другое время)
    if (!isEventType && !past && ev.status !== 'Отменено' && ev.status !== 'Запланировано' && !ev.isClosed && !isRegistered) {
      actions.appendChild(renderInterestButton(ev));
    }

    card.appendChild(top);
    if (image) card.appendChild(image);
    card.appendChild(game);
    card.appendChild(tags);
    card.appendChild(meta);
    if (links) card.appendChild(links);
    if (eventGamesBlock) card.appendChild(eventGamesBlock);
    if (participants) card.appendChild(participants);
    if (interestLine) card.appendChild(interestLine);
    if (reservedRow) card.appendChild(reservedRow);
    if (actions.children.length) card.appendChild(actions);
    return card;
  }

  // список настольных игр, прикреплённых к «Событию» -- у каждой свои жанр/сложность/ссылки,
  // те же поля, что и у обычного анонса игры (см. organizer.js/Code.gs serializeEventGames)
  function renderEventGamesBlock(games) {
    var wrap = document.createElement('div');
    wrap.className = 'card-event-games';

    var label = document.createElement('div');
    label.className = 'cap mut';
    label.textContent = '🎲 Игры на событии:';
    wrap.appendChild(label);

    games.forEach(function (g) {
      var row = document.createElement('div');
      row.className = 'card-event-game';

      var name = document.createElement('span');
      name.className = 'n';
      name.textContent = capitalizeFirst(g.game);
      row.appendChild(name);

      var tagValues = [];
      splitList(g.format).forEach(function (t) { tagValues.push(t); });
      if (g.difficulty) tagValues.push(g.difficulty);
      if (g.maxDuration) tagValues.push('~' + g.maxDuration + ' мин');
      if (g.setting) splitList(g.setting).forEach(function (s) { tagValues.push(s); });

      if (tagValues.length) {
        var tagsRow = document.createElement('div');
        tagsRow.className = 'card-tags';
        tagValues.forEach(function (t) {
          var tag = document.createElement('span');
          tag.className = 'tag';
          tag.textContent = t;
          tagsRow.appendChild(tag);
        });
        row.appendChild(tagsRow);
      }

      if (g.teseraUrl || g.bggUrl) {
        var linksRow = document.createElement('div');
        linksRow.className = 'card-links';
        if (g.teseraUrl) linksRow.appendChild(externalLink('Тесера', g.teseraUrl));
        if (g.bggUrl) linksRow.appendChild(externalLink('BGG', g.bggUrl));
        row.appendChild(linksRow);
      }

      wrap.appendChild(row);
    });

    return wrap;
  }

  // счётчик +/- для организатора: помечает места как занятые без указания имени/почты
  // (например, кто-то договорился вне сайта). Считается наравне с именными записями.
  function renderReservedStepper(ev) {
    var row = document.createElement('div');
    row.className = 'card-reserved';

    var label = document.createElement('span');
    label.textContent = 'Занято без записи: ' + (ev.reservedCount || 0);
    row.appendChild(label);

    var minusBtn = document.createElement('button');
    minusBtn.type = 'button';
    minusBtn.className = 'stepper-btn';
    minusBtn.textContent = '−';
    minusBtn.disabled = !(ev.reservedCount > 0);
    minusBtn.addEventListener('click', function () { adjustReserved(ev, -1); });
    row.appendChild(minusBtn);

    var plusBtn = document.createElement('button');
    plusBtn.type = 'button';
    plusBtn.className = 'stepper-btn';
    plusBtn.textContent = '+';
    row.appendChild(plusBtn);
    plusBtn.addEventListener('click', function () { adjustReserved(ev, 1); });

    return row;
  }

  function adjustReserved(ev, delta) {
    var me = getMe();
    if (!me || !me.email) return;
    apiPost({ action: 'adjustReserved', date: ev.date, time: ev.time, game: ev.game, email: me.email, delta: delta })
      .then(function (res) {
        if (!res.ok) {
          if (res.error === 'full') alert('Мест больше нет — увеличьте макс. участников или уменьшите резерв');
          else alert('Не получилось изменить счётчик, попробуйте ещё раз');
          return;
        }
        refresh();
      });
  }

  function pluralizeWant(n) {
    var mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return 'хочет';
    return 'хотят';
  }

  function renderInterestButton(ev) {
    var btn = document.createElement('button');
    btn.className = 'btn-ghost';
    btn.type = 'button';
    btn.textContent = 'Проявить интерес';
    btn.addEventListener('click', function () { openInterestModal(ev); });
    return btn;
  }

  function metaLine(label, value, hoverEmail) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(label + ': '));
    var b = document.createElement('b');
    if (hoverEmail) {
      b.className = 'hoverable-email';
      b.title = hoverEmail;
    }
    b.textContent = value;
    div.appendChild(b);
    return div;
  }

  function externalLink(label, url) {
    var a = document.createElement('a');
    a.className = 'card-link';
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = label + ' ↗';
    return a;
  }

  function renderActionButton(ev) {
    var isRegistered = state.registeredIds.indexOf(ev.id) !== -1;

    // if the server included a "Запланировано" event in our list at all, it's because we're
    // either its creator (by email) or logged in as an ambassador -- in both cases we're
    // allowed to publish it, so there's no extra permission check needed on the client
    if (ev.status === 'Запланировано') {
      var publishBtn = document.createElement('button');
      publishBtn.className = 'btn-primary';
      publishBtn.textContent = 'Опубликовать';
      publishBtn.addEventListener('click', function () { doPublish(ev); });
      return publishBtn;
    }

    if (ev.status === 'Отменено') {
      var btn = document.createElement('button');
      btn.className = 'btn-primary';
      btn.disabled = true;
      btn.textContent = 'Отменено';
      return btn;
    }

    if (isPastEvent(ev)) {
      var pastBtn = document.createElement('button');
      pastBtn.className = 'btn-primary';
      pastBtn.disabled = true;
      pastBtn.textContent = 'Уже прошло';
      return pastBtn;
    }

    // «Событие» -- без записи, показывать нечего (кнопка не нужна вовсе)
    if (ev.type === 'event') {
      return null;
    }

    if (isRegistered) {
      var cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn-secondary';
      cancelBtn.textContent = 'Отменить запись';
      cancelBtn.addEventListener('click', function () { doCancel(ev); });
      return cancelBtn;
    }

    // закрытое мероприятие -- самостоятельная запись недоступна, только организатор
    // добавляет участников (по почте); если мы вообще видим эту карточку, но не входим
    // в список участников, кнопка просто неактивна
    if (ev.isClosed) {
      var closedBtn = document.createElement('button');
      closedBtn.className = 'btn-primary';
      closedBtn.disabled = true;
      closedBtn.textContent = 'Закрытое — запись через организатора';
      return closedBtn;
    }

    var signBtn = document.createElement('button');
    signBtn.className = 'btn-primary';
    if (!ev.isOpen) {
      signBtn.disabled = true;
      signBtn.textContent = 'Мест нет';
    } else {
      signBtn.textContent = 'Записаться';
      signBtn.addEventListener('click', function () { openSignupModal(ev); });
    }
    return signBtn;
  }

  // ---------- data load ----------
  function loadEvents() {
    // registeredIds is bundled into the same response as events (when an email is known)
    // instead of a second round trip to action=myStatus -- halves the network wait on load
    var me = getMe();
    var params = {};
    if (me && me.email) params.email = me.email;
    return apiGet('events', params).then(function (res) {
      if (!res.ok) throw new Error(res.error || 'load failed');
      state.events = res.events;
      state.registeredIds = res.registeredIds || [];
    });
  }

  function refresh() {
    return loadEvents().then(function () {
      renderStats();
      renderFilters();
      renderGrid();
      renderWhoAmI();
      highlightFromHash();
    });
  }

  // if the URL has #ev-... (e.g. from an announcement link), scroll to that card and flash it
  function highlightFromHash() {
    var raw = window.location.hash.replace('#', '');
    if (!raw || state.hashHandled) return;
    // links built via the URL API percent-encode non-ASCII (Cyrillic) characters in the
    // fragment, while the card's id attribute holds the raw, un-encoded slug -- decode first
    // so both forms of the hash (encoded or already-decoded) resolve to the same element.
    var decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch (e) { /* malformed, fall back to raw */ }
    var el = document.getElementById(decoded) || document.getElementById(raw);
    if (!el) return;
    state.hashHandled = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('is-highlighted');
    setTimeout(function () { el.classList.remove('is-highlighted'); }, 2200);
  }

  // ---------- modals ----------
  function showOverlay(id) { document.getElementById(id).hidden = false; }
  function hideOverlay(id) { document.getElementById(id).hidden = true; }

  document.querySelectorAll('[data-close]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      hideOverlay('whoAmIOverlay');
      hideOverlay('signupOverlay');
      hideOverlay('interestOverlay');
    });
  });
  document.querySelectorAll('.modal-overlay').forEach(function (overlay) {
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.hidden = true;
    });
  });

  document.getElementById('whoAmIBtn').addEventListener('click', function () {
    var me = getMe();
    document.getElementById('inputName').value = (me && me.name) || '';
    document.getElementById('inputEmail').value = (me && me.email) || '';
    document.getElementById('inputPin').value = '';
    document.getElementById('whoAmIError').hidden = true;
    showOverlay('whoAmIOverlay');
  });

  // PIN проверяется только здесь, при подтверждении личности -- дальше сайт доверяет уже
  // сохранённому в localStorage имени/почте (см. openSignupModal/openInterestModal)
  document.getElementById('saveWhoAmI').addEventListener('click', function () {
    var name = document.getElementById('inputName').value.trim();
    var email = document.getElementById('inputEmail').value.trim();
    var pin = document.getElementById('inputPin').value.trim();
    var errEl = document.getElementById('whoAmIError');
    errEl.hidden = true;

    if (!name || !email.includes('@')) {
      errEl.textContent = 'Укажите имя и корпоративную почту';
      errEl.hidden = false;
      return;
    }
    if (!/^\d{4}$/.test(pin)) {
      errEl.textContent = 'Код должен состоять из 4 цифр';
      errEl.hidden = false;
      return;
    }

    var btn = document.getElementById('saveWhoAmI');
    btn.disabled = true;
    btn.textContent = 'Проверяем…';

    apiPost({ action: 'identify', name: name, email: email, pin: pin })
      .then(function (res) {
        btn.disabled = false;
        btn.textContent = 'Сохранить';
        if (!res.ok) {
          if (res.error === 'wrong_pin') {
            errEl.textContent = 'Неверный код для этой почты. Если не помните его — напишите амбассадору Дарье: ddkolesnik@beeline.ru';
          } else if (res.error === 'invalid_pin') {
            errEl.textContent = 'Код должен состоять из 4 цифр';
          } else if (res.error === 'accounts_sheet_missing') {
            errEl.textContent = 'В таблице не найден лист «Аккаунты» — напишите Дарье: ddkolesnik@beeline.ru';
          } else {
            errEl.textContent = 'Не получилось сохранить, попробуйте ещё раз';
          }
          errEl.hidden = false;
          return;
        }
        setMe({ name: name, email: email });
        hideOverlay('whoAmIOverlay');
        refresh();
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = 'Сохранить';
        errEl.textContent = 'Ошибка сети, попробуйте ещё раз';
        errEl.hidden = false;
      });
  });

  // limits the "с гостями" dropdown to however many spots are actually left, so people
  // can't pick +3 when only 2 seats remain (server still enforces this too, as a backstop)
  function renderGuestOptions(ev) {
    var select = document.getElementById('signupGuests');
    var remaining = ev.maxParticipants ? Math.max(0, ev.maxParticipants - ev.participantsCount) : 5;
    var maxGuests = Math.max(0, Math.min(4, remaining - 1));
    var options = ['<option value="0">без гостей</option>'];
    for (var g = 1; g <= maxGuests; g++) {
      options.push('<option value="' + g + '">+' + g + '</option>');
    }
    select.innerHTML = options.join('');
  }

  // личность (имя+почта) уже подтверждена через "это вы" -- если она ещё не задана,
  // сразу открываем эту модалку вместо формы записи; после подтверждения человек просто
  // нажимает «Записаться» ещё раз
  function openSignupModal(ev) {
    var me = getMe();
    if (!me || !me.email) {
      document.getElementById('whoAmIBtn').click();
      return;
    }
    state.pendingSignupEvent = ev;
    document.getElementById('signupTitle').textContent = 'Записаться: ' + ev.game;
    document.getElementById('signupSubtitle').textContent = fmtDate(ev.date) + (ev.time ? ', ' + ev.time : '') + (ev.place ? ' · ' + ev.place : '');
    document.getElementById('signupAsWhom').textContent = 'Записываемся как: ' + me.name + ' · ' + me.email;
    document.getElementById('signupError').hidden = true;
    renderGuestOptions(ev);
    showOverlay('signupOverlay');
  }

  document.getElementById('confirmSignup').addEventListener('click', function () {
    var ev = state.pendingSignupEvent;
    var me = getMe();
    if (!ev || !me || !me.email) return;
    var errEl = document.getElementById('signupError');
    errEl.hidden = true;

    var btn = document.getElementById('confirmSignup');
    btn.disabled = true;
    btn.textContent = 'Записываем…';

    var guests = Number(document.getElementById('signupGuests').value) || 0;
    apiPost({ action: 'signup', date: ev.date, time: ev.time, game: ev.game, name: me.name, email: me.email, guests: guests })
      .then(function (res) {
        btn.disabled = false;
        btn.textContent = 'Записаться';
        if (!res.ok) {
          errEl.textContent = res.error === 'full' ? 'Увы, места уже закончились' : 'Не получилось записаться, попробуйте ещё раз';
          errEl.hidden = false;
          return;
        }
        hideOverlay('signupOverlay');
        refresh();
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = 'Записаться';
        errEl.textContent = 'Ошибка сети, попробуйте ещё раз';
        errEl.hidden = false;
      });
  });

  function doCancel(ev) {
    var me = getMe();
    if (!me || !me.email) return;
    if (!confirm('Отменить запись на «' + ev.game + '»?')) return;
    apiPost({ action: 'cancel', date: ev.date, time: ev.time, game: ev.game, email: me.email })
      .then(function (res) {
        if (!res.ok) {
          alert('Не получилось отменить запись, попробуйте ещё раз');
          return;
        }
        refresh();
      });
  }

  // публикация запланированного мероприятия -- сервер сам проверяет право (создатель по
  // email или амбассадор -- роль ищется в листе «Аккаунты» по этому же email), клиент
  // просто отправляет то, что у него уже сохранено
  function doPublish(ev) {
    var me = getMe();
    apiPost({ action: 'publish', date: ev.date, time: ev.time, game: ev.game, email: (me && me.email) || '' })
      .then(function (res) {
        if (!res.ok) {
          alert('Не получилось опубликовать, попробуйте ещё раз');
          return;
        }
        refresh();
      });
  }

  function openInterestModal(ev) {
    var me = getMe();
    if (!me || !me.email) {
      document.getElementById('whoAmIBtn').click();
      return;
    }
    state.pendingInterestEvent = ev;
    document.getElementById('interestTitle').textContent = 'Проявить интерес: ' + ev.game;
    document.getElementById('interestAsWhom').textContent = 'Отправляем как: ' + me.name + ' · ' + me.email;
    document.getElementById('interestError').hidden = true;
    showOverlay('interestOverlay');
  }

  document.getElementById('confirmInterest').addEventListener('click', function () {
    var ev = state.pendingInterestEvent;
    var me = getMe();
    if (!ev || !me || !me.email) return;
    var errEl = document.getElementById('interestError');
    errEl.hidden = true;

    var btn = document.getElementById('confirmInterest');
    btn.disabled = true;
    btn.textContent = 'Отправляем…';

    apiPost({ action: 'interest', date: ev.date, time: ev.time, game: ev.game, name: me.name, email: me.email })
      .then(function (res) {
        btn.disabled = false;
        btn.textContent = 'Отправить';
        if (!res.ok) {
          errEl.textContent = 'Не получилось отправить, попробуйте ещё раз';
          errEl.hidden = false;
          return;
        }
        hideOverlay('interestOverlay');
        refresh();
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = 'Отправить';
        errEl.textContent = 'Ошибка сети, попробуйте ещё раз';
        errEl.hidden = false;
      });
  });

  document.getElementById('togglePastBtn').addEventListener('click', function () {
    state.showPast = !state.showPast;
    renderPastToggle();
    renderGrid();
  });

  // ---------- init ----------
  function showStatus(msg) {
    var el = document.getElementById('status');
    el.textContent = msg;
    el.hidden = false;
  }

  renderWhoAmI(); // show any saved identity immediately, even before the network call resolves
  renderPastToggle();

  if (!API_URL || API_URL.indexOf('ВСТАВЬТЕ') !== -1) {
    document.getElementById('loadingState').textContent = 'Сайт ещё не подключён к таблице. Заполните APPS_SCRIPT_URL в config.js — см. SETUP.md.';
  } else {
    refresh().catch(function (err) {
      showStatus('Не удалось загрузить анонсы: ' + err.message);
      document.getElementById('loadingState').textContent = 'Ошибка загрузки. Обновите страницу позже.';
    });
  }
})();
