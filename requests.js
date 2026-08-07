(function () {
  'use strict';

  var API_URL = (window.APP_CONFIG && window.APP_CONFIG.APPS_SCRIPT_URL) || '';

  var state = { requests: [] };

  // defensive, client-side mirror of Code.gs's capitalizeFirst()
  function capitalizeFirst(s) {
    s = String(s || '').trim();
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // офисы разделяются точкой с запятой (а не запятой), потому что сам адрес внутри одного
  // офиса обычно и так содержит запятые ("Москва (локер 5, 2 этаж)") -- запятая как
  // разделитель между офисами сломала бы такие адреса на лишние куски
  function splitList(s) {
    return String(s || '').split(';').map(function (x) { return x.trim(); }).filter(Boolean);
  }

  // ---------- persistence of "who am I" -- same localStorage key as index.html/organizer.html,
  // so an identity set on any page is immediately recognized here too ----------
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
    url += '&_ts=' + Date.now(); // avoid a stale cached response
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

  function showStatus(msg) {
    var el = document.getElementById('status');
    el.textContent = msg;
    el.hidden = false;
  }

  // ---------- filtering / sorting (purely client-side over the already-fetched list --
  // no need to hit the server again just to change the city filter or the sort order) ----------
  function matchesCity(req, city) {
    if (!city) return true;
    var needle = city.toLowerCase();
    return (req.office && req.office.toLowerCase().indexOf(needle) !== -1) ||
      (req.hosts && req.hosts.toLowerCase().indexOf(needle) !== -1);
  }

  function getVisibleRequests() {
    var city = document.getElementById('cityFilter').value;
    var sort = document.getElementById('sortSelect').value;
    var list = state.requests.filter(function (req) { return matchesCity(req, city); });
    if (sort === 'az' || sort === 'za') {
      list = list.slice().sort(function (a, b) {
        return capitalizeFirst(a.game).localeCompare(capitalizeFirst(b.game), 'ru');
      });
      if (sort === 'za') list.reverse();
    }
    // sort === 'votes' -- keep the server order as-is (already sorted by votes desc)
    return list;
  }

  // ---------- rendering ----------
  function renderList() {
    var el = document.getElementById('requestsList');
    var head = document.getElementById('requestsHead');
    Array.from(el.querySelectorAll('.requests-row, .empty')).forEach(function (n) { n.remove(); });

    if (!state.requests.length) {
      head.hidden = true;
      el.appendChild(makeEmpty('Список пока пуст 🎲'));
      return;
    }

    var visible = getVisibleRequests();
    if (!visible.length) {
      head.hidden = true;
      el.appendChild(makeEmpty('Ничего не нашлось для этого города — попробуйте другой фильтр'));
      return;
    }

    head.hidden = false;
    visible.forEach(function (req) {
      el.appendChild(renderRow(req));
    });
  }

  function makeEmpty(text) {
    var empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = text;
    return empty;
  }

  // small mobile-only caption shown above a cell's value once the table collapses to
  // stacked cards on narrow screens (see .req-cell-label in styles.css)
  function cellLabel(text) {
    var span = document.createElement('span');
    span.className = 'req-cell-label';
    span.textContent = text;
    return span;
  }

  function renderChipList(items, emptyText, chipClass) {
    var wrap = document.createElement('div');
    wrap.className = 'req-chips';
    if (items.length) {
      items.forEach(function (t) {
        var chip = document.createElement('span');
        chip.className = chipClass;
        chip.textContent = t;
        wrap.appendChild(chip);
      });
    } else {
      var none = document.createElement('span');
      none.className = 'req-chips-empty';
      none.textContent = emptyText;
      wrap.appendChild(none);
    }
    return wrap;
  }

  function renderRow(req) {
    var row = document.createElement('div');
    row.className = 'requests-row';

    var gameCell = document.createElement('div');
    gameCell.className = 'req-cell req-cell-game';
    gameCell.appendChild(cellLabel('Игра'));
    var name = document.createElement('span');
    name.className = 'req-game';
    name.textContent = capitalizeFirst(req.game);
    gameCell.appendChild(name);
    row.appendChild(gameCell);

    var officeCell = document.createElement('div');
    officeCell.className = 'req-cell req-cell-office';
    officeCell.appendChild(cellLabel('Доступность в офисе'));
    officeCell.appendChild(renderChipList(splitList(req.office), 'пока нет ни в одном офисе', 'req-office'));
    row.appendChild(officeCell);

    var hostsCell = document.createElement('div');
    hostsCell.className = 'req-cell req-cell-hosts';
    hostsCell.appendChild(cellLabel('Кто может провести'));
    hostsCell.appendChild(renderChipList(splitList(req.hosts), 'пока не указано', 'req-host'));
    row.appendChild(hostsCell);

    var bgaCell = document.createElement('div');
    bgaCell.className = 'req-cell req-cell-bga';
    bgaCell.appendChild(cellLabel('BGA'));
    var bgaBadge = document.createElement('span');
    bgaBadge.className = 'req-bga' + (req.bgaAvailable ? ' is-yes' : ' is-no');
    bgaBadge.textContent = req.bgaAvailable ? '🕹 да' : '—';
    bgaCell.appendChild(bgaBadge);
    row.appendChild(bgaCell);

    var voteCell = document.createElement('div');
    voteCell.className = 'req-cell req-cell-vote';
    var voteBtn = document.createElement('button');
    voteBtn.type = 'button';
    voteBtn.className = 'vote-btn' + (req.iVoted ? ' active' : '');
    voteBtn.innerHTML = (req.iVoted ? '✓ Поддержано' : '+ Поддержать') +
      ' <span class="vote-count">(' + req.votes + ')</span>';
    voteBtn.addEventListener('click', function () { toggleVote(req); });
    voteCell.appendChild(voteBtn);
    row.appendChild(voteCell);

    return row;
  }

  // один плюсик на игру на человека -- повторный клик снимает голос; сколько разных игр
  // поддержать, не ограничено
  function toggleVote(req) {
    var me = getMe();
    if (!me || !me.email) {
      document.getElementById('whoAmIBtn').click();
      return;
    }
    var action = req.iVoted ? 'unvote' : 'vote';
    apiPost({ action: action, game: req.game, email: me.email, name: me.name })
      .then(function (res) {
        if (!res.ok) {
          showStatus('Не получилось изменить голос, попробуйте ещё раз');
          return;
        }
        refresh();
      })
      .catch(function () {
        showStatus('Ошибка сети, попробуйте ещё раз');
      });
  }

  function refresh() {
    var me = getMe();
    var params = {};
    if (me && me.email) params.email = me.email;
    return apiGet('requests', params).then(function (res) {
      if (!res.ok) throw new Error(res.error || 'load failed');
      state.requests = res.requests;
      renderList();
      renderWhoAmI();
    });
  }

  // ---------- modals ----------
  function showOverlay(id) { document.getElementById(id).hidden = false; }
  function hideOverlay(id) { document.getElementById(id).hidden = true; }

  document.querySelectorAll('[data-close]').forEach(function (btn) {
    btn.addEventListener('click', function () { hideOverlay('whoAmIOverlay'); });
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

  document.getElementById('cityFilter').addEventListener('change', renderList);
  document.getElementById('sortSelect').addEventListener('change', renderList);

  // ---------- init ----------
  renderWhoAmI();

  if (!API_URL || API_URL.indexOf('ВСТАВЬТЕ') !== -1) {
    document.getElementById('loadingState').textContent = 'Сайт ещё не подключён к таблице. Заполните APPS_SCRIPT_URL в config.js — см. SETUP.md.';
  } else {
    refresh().catch(function (err) {
      showStatus('Не удалось загрузить список: ' + err.message);
      document.getElementById('loadingState').textContent = 'Ошибка загрузки. Обновите страницу позже.';
    });
  }
})();
