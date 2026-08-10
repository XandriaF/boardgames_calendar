(function () {
  'use strict';

  // «Мои игры» -- личный кабинет: «Мои анонсы» (мероприятия, где я организатор, включая
  // свои черновики/запланированные/закрытые -- ровно то же, что уже отдаёт action=events по
  // email) и «Мои записи» (игры, где я записан как участник, через уже готовый bundled
  // registeredIds). Никаких новых серверных экшенов не нужно -- то же самое GET /events,
  // что использует index.html, просто отфильтрованное по-другому на клиенте. Карточка и все
  // её кнопки (записаться/отменить/опубликовать/интерес/резерв) -- дословно те же функции,
  // что и в app.js, чтобы поведение и здесь, и на календаре не расходилось.

  var API_URL = (window.APP_CONFIG && window.APP_CONFIG.APPS_SCRIPT_URL) || '';

  var state = {
    events: [],
    registeredIds: [],
    activeView: 'announcements', // 'announcements' | 'signups'
    pendingSignupEvent: null,
    pendingInterestEvent: null
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

  function capitalizeFirst(s) {
    s = String(s || '').trim();
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function splitList(s) {
    return String(s || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  }

  // same algorithm as app.js/organizer.js -- kept identical so a card here shares its id
  // with the matching card on the calendar (not actually linked to from here, but no reason
  // to let the two drift apart)
  function slugifyEventId(date, time, game) {
    var raw = (date + '-' + (time || '') + '-' + game).toLowerCase();
    return 'ev-' + raw.replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-+|-+$/g, '');
  }

  function isPastEvent(ev, now) {
    now = now || new Date();
    var dt = ev.time ? new Date(ev.date + 'T' + ev.time + ':00') : new Date(ev.date + 'T23:59:59');
    if (isNaN(dt)) return false;
    return dt.getTime() < now.getTime();
  }

  // ---------- persistence of "who am I" -- same localStorage key as every other page ----------
  function getMe() {
    try { return JSON.parse(localStorage.getItem('nastolki_me') || 'null'); } catch (e) { return null; }
  }
  function setMe(me) {
    localStorage.setItem('nastolki_me', JSON.stringify(me));
  }
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
    url += '&_ts=' + Date.now();
    return fetch(url, { cache: 'no-store' }).then(function (r) { return r.json(); });
  }
  function apiPost(payload) {
    return fetch(API_URL, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); });
  }

  // ---------- view toggle (Мои анонсы / Мои записи) ----------
  function setView(view) {
    state.activeView = view;
    document.querySelectorAll('#viewToggle .chip').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-view') === view);
    });
    renderGrid();
  }
  document.querySelectorAll('#viewToggle .chip').forEach(function (btn) {
    btn.addEventListener('click', function () { setView(btn.getAttribute('data-view')); });
  });

  function passesView(ev, me) {
    if (state.activeView === 'signups') return state.registeredIds.indexOf(ev.id) !== -1;
    // 'announcements'
    return !!me && !!ev.organizerEmail && ev.organizerEmail === me.email;
  }

  // ---------- rendering ----------
  function makeEmpty(text, withButton) {
    var wrap = document.createElement('div');
    wrap.className = 'empty';
    var p = document.createElement('div');
    p.textContent = text;
    wrap.appendChild(p);
    if (withButton) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-primary';
      btn.style.width = 'auto';
      btn.style.marginTop = '14px';
      btn.textContent = 'указать имя и почту';
      btn.addEventListener('click', function () { document.getElementById('whoAmIBtn').click(); });
      wrap.appendChild(btn);
    }
    return wrap;
  }

  function renderGrid() {
    var grid = document.getElementById('myGrid');
    grid.innerHTML = '';
    var me = getMe();

    if (!me || !me.email) {
      grid.appendChild(makeEmpty('Сначала укажите, кто вы — тогда здесь появятся ваши анонсы и записи 🎲', true));
      return;
    }

    var list = state.events.filter(function (ev) { return passesView(ev, me); }).slice().sort(function (a, b) {
      var aPast = isPastEvent(a), bPast = isPastEvent(b);
      if (aPast !== bPast) return aPast ? 1 : -1; // upcoming events always float above past ones
      var key = function (e) { return e.date + (e.time || ''); };
      return aPast
        ? key(b).localeCompare(key(a))  // past: most recently happened first
        : key(a).localeCompare(key(b)); // upcoming: soonest first
    });

    if (!list.length) {
      var msg = state.activeView === 'signups'
        ? 'Вы пока никуда не записались 🎲'
        : 'Вы пока ничего не анонсировали 🎲';
      grid.appendChild(makeEmpty(msg, false));
      return;
    }

    list.forEach(function (ev) { grid.appendChild(renderCard(ev)); });
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
    if (ev.setting) splitList(ev.setting).forEach(function (s) { tagValues.push(s); });
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

    if (ev.type === 'event') return null;

    if (isRegistered) {
      var cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn-secondary';
      cancelBtn.textContent = 'Отменить запись';
      cancelBtn.addEventListener('click', function () { doCancel(ev); });
      return cancelBtn;
    }

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
    var me = getMe();
    if (!me || !me.email) {
      state.events = [];
      state.registeredIds = [];
      return Promise.resolve();
    }
    return apiGet('events', { email: me.email }).then(function (res) {
      if (!res.ok) throw new Error(res.error || 'load failed');
      state.events = res.events;
      state.registeredIds = res.registeredIds || [];
    });
  }

  function refresh() {
    return loadEvents().then(function () {
      renderGrid();
      renderWhoAmI();
    });
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

  document.getElementById('saveWhoAmI').addEventListener('click', function () {
    var name = document.getElementById('inputName').value.trim();
    var email = document.getElementById('inputEmail').value.trim();
    var pin = document.getElementById('inputPin').value.trim();
    var errEl = document.getElementById('whoAmIError');
    errEl.hidden = true;

    if (!email.includes('@')) {
      errEl.textContent = 'Укажите корпоративную почту';
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
          } else if (res.error === 'name_required') {
            errEl.textContent = 'Это ваш первый вход с этой почты — укажите, пожалуйста, и имя';
          } else {
            errEl.textContent = 'Не получилось сохранить, попробуйте ещё раз';
          }
          errEl.hidden = false;
          return;
        }
        setMe({ name: res.name || name, email: email });
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

  // ---------- init ----------
  function showStatus(msg) {
    var el = document.getElementById('status');
    el.textContent = msg;
    el.hidden = false;
  }

  renderWhoAmI();

  if (!API_URL || API_URL.indexOf('ВСТАВЬТЕ') !== -1) {
    document.getElementById('myGrid').innerHTML = '';
    document.getElementById('myGrid').appendChild(makeEmpty('Сайт ещё не подключён к таблице. Заполните APPS_SCRIPT_URL в config.js — см. SETUP.md.', false));
  } else {
    refresh().catch(function (err) {
      showStatus('Не удалось загрузить список: ' + err.message);
      renderGrid();
    });
  }
})();
