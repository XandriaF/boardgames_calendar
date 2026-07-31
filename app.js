(function () {
  'use strict';

  var API_URL = (window.APP_CONFIG && window.APP_CONFIG.APPS_SCRIPT_URL) || '';

  var state = {
    events: [],
    registeredIds: [],     // event ids current user is signed up for
    activeCity: 'Все',
    activeFormat: 'Все',
    pendingSignupEvent: null,
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
    var formats = uniqueSorted(state.events.map(function (e) { return e.format; }));
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
    el.appendChild(statCard('мероприятий', String(total), 'в открытом доступе'));
    el.appendChild(statCard('городов', String(cities), 'участвует в программе'));
    el.appendChild(statCard('ближайшее', nearestLabel, nearestSub));
  }

  function passesFilter(ev) {
    var cityOk = state.activeCity === 'Все' || ev.city === state.activeCity;
    var formatOk = state.activeFormat === 'Все' || ev.format === state.activeFormat;
    return cityOk && formatOk;
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
    if (ev.status === 'Отменено') {
      badgeClass = 'badge-cancelled';
      badgeText = STATUS_LABEL[ev.status] || ev.status;
    } else if (past) {
      badgeClass = 'badge-past';
      badgeText = 'Уже прошло';
    } else {
      badgeClass = ev.isOpen ? 'badge-open' : 'badge-full';
      badgeText = STATUS_LABEL[ev.status] || ev.status;
    }
    badge.className = 'badge ' + badgeClass;
    badge.textContent = badgeText;
    top.appendChild(dateEl);
    top.appendChild(badge);

    var game = document.createElement('div');
    game.className = 'card-game';
    game.textContent = ev.game;

    var tags = document.createElement('div');
    tags.className = 'card-tags';
    [ev.city, ev.format, ev.difficulty].filter(Boolean).forEach(function (t) {
      var tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = t;
      tags.appendChild(tag);
    });

    var meta = document.createElement('div');
    meta.className = 'card-meta';
    if (ev.place) meta.appendChild(metaLine('Где', ev.place));
    if (ev.organizer) meta.appendChild(metaLine('Организатор', ev.organizer));
    if (ev.maxDuration) meta.appendChild(metaLine('Время партии', '~' + ev.maxDuration + ' мин (при полном столе)'));

    var links = null;
    if (ev.teseraUrl || ev.bggUrl) {
      links = document.createElement('div');
      links.className = 'card-links';
      if (ev.teseraUrl) links.appendChild(externalLink('Тесера', ev.teseraUrl));
      if (ev.bggUrl) links.appendChild(externalLink('BGG', ev.bggUrl));
    }

    var participants = document.createElement('div');
    participants.className = 'card-participants';
    var countText = ev.maxParticipants ? (ev.participantsCount + ' из ' + ev.maxParticipants) : (ev.participantsCount + ' записалось');
    var namesText = ev.participantNames && ev.participantNames.length ? ' — ' + ev.participantNames.join(', ') : '';
    participants.innerHTML = '<b>' + countText + '</b><span class="names">' + escapeHtml(namesText) + '</span>';

    var actions = document.createElement('div');
    actions.className = 'card-actions';
    actions.appendChild(renderActionButton(ev));

    card.appendChild(top);
    card.appendChild(game);
    card.appendChild(tags);
    card.appendChild(meta);
    if (links) card.appendChild(links);
    card.appendChild(participants);
    card.appendChild(actions);
    return card;
  }

  function metaLine(label, value) {
    var div = document.createElement('div');
    div.innerHTML = escapeHtml(label + ': ') + '<b>' + escapeHtml(value) + '</b>';
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

  function escapeHtml(s) {
    var div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function renderActionButton(ev) {
    var isRegistered = state.registeredIds.indexOf(ev.id) !== -1;

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

    if (isRegistered) {
      var cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn-secondary';
      cancelBtn.textContent = 'Отменить запись';
      cancelBtn.addEventListener('click', function () { doCancel(ev); });
      return cancelBtn;
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
    var params = (me && me.email) ? { email: me.email } : {};
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
    showOverlay('whoAmIOverlay');
  });

  document.getElementById('saveWhoAmI').addEventListener('click', function () {
    var name = document.getElementById('inputName').value.trim();
    var email = document.getElementById('inputEmail').value.trim();
    if (!name || !email.includes('@')) {
      alert('Укажите имя и корпоративную почту');
      return;
    }
    setMe({ name: name, email: email });
    hideOverlay('whoAmIOverlay');
    refresh();
  });

  function openSignupModal(ev) {
    state.pendingSignupEvent = ev;
    var me = getMe();
    document.getElementById('signupTitle').textContent = 'Записаться: ' + ev.game;
    document.getElementById('signupSubtitle').textContent = fmtDate(ev.date) + (ev.time ? ', ' + ev.time : '') + (ev.place ? ' · ' + ev.place : '');
    document.getElementById('signupName').value = (me && me.name) || '';
    document.getElementById('signupEmail').value = (me && me.email) || '';
    document.getElementById('signupError').hidden = true;
    showOverlay('signupOverlay');
  }

  document.getElementById('confirmSignup').addEventListener('click', function () {
    var ev = state.pendingSignupEvent;
    if (!ev) return;
    var name = document.getElementById('signupName').value.trim();
    var email = document.getElementById('signupEmail').value.trim();
    var errEl = document.getElementById('signupError');
    if (!name || !email.includes('@')) {
      errEl.textContent = 'Укажите имя и корпоративную почту';
      errEl.hidden = false;
      return;
    }
    var btn = document.getElementById('confirmSignup');
    btn.disabled = true;
    btn.textContent = 'Записываем…';

    apiPost({ action: 'signup', date: ev.date, time: ev.time, game: ev.game, name: name, email: email })
      .then(function (res) {
        btn.disabled = false;
        btn.textContent = 'Записаться';
        if (!res.ok) {
          errEl.textContent = res.error === 'full' ? 'Увы, места уже закончились' : 'Не получилось записаться, попробуйте ещё раз';
          errEl.hidden = false;
          return;
        }
        setMe({ name: name, email: email });
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

  // ---------- init ----------
  function showStatus(msg) {
    var el = document.getElementById('status');
    el.textContent = msg;
    el.hidden = false;
  }

  if (!API_URL || API_URL.indexOf('ВСТАВЬТЕ') !== -1) {
    document.getElementById('loadingState').textContent = 'Сайт ещё не подключён к таблице. Заполните APPS_SCRIPT_URL в config.js — см. SETUP.md.';
  } else {
    refresh().catch(function (err) {
      showStatus('Не удалось загрузить анонсы: ' + err.message);
      document.getElementById('loadingState').textContent = 'Ошибка загрузки. Обновите страницу позже.';
    });
  }
})();
