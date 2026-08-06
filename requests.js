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

  function splitList(s) {
    return String(s || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
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

  // ---------- rendering ----------
  function renderList() {
    var el = document.getElementById('requestsList');
    el.innerHTML = '';

    if (!state.requests.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Список пока пуст 🎲';
      el.appendChild(empty);
      return;
    }

    state.requests.forEach(function (req) {
      el.appendChild(renderRow(req));
    });
  }

  function renderRow(req) {
    var row = document.createElement('div');
    row.className = 'requests-row';

    var main = document.createElement('div');
    main.className = 'req-main';

    var name = document.createElement('div');
    name.className = 'req-game';
    name.textContent = capitalizeFirst(req.game);
    main.appendChild(name);

    var meta = document.createElement('div');
    meta.className = 'req-meta';
    if (req.office) {
      splitList(req.office).forEach(function (o) {
        var span = document.createElement('span');
        span.textContent = '📍 ' + o;
        meta.appendChild(span);
      });
    } else {
      var noOffice = document.createElement('span');
      noOffice.textContent = 'пока нет ни в одном офисе';
      meta.appendChild(noOffice);
    }
    if (req.bggUrl) {
      var bgg = document.createElement('a');
      bgg.href = req.bggUrl;
      bgg.target = '_blank';
      bgg.rel = 'noopener noreferrer';
      bgg.className = 'card-link';
      bgg.textContent = 'Об игре на BGG ↗';
      meta.appendChild(bgg);
    }
    main.appendChild(meta);
    row.appendChild(main);

    var voteBtn = document.createElement('button');
    voteBtn.type = 'button';
    voteBtn.className = 'vote-btn' + (req.iVoted ? ' active' : '');
    voteBtn.innerHTML = (req.iVoted ? '✓ Поддержано' : '+ Поддержать') +
      ' <span class="vote-count">(' + req.votes + ')</span>';
    voteBtn.addEventListener('click', function () { toggleVote(req); });
    row.appendChild(voteBtn);

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
