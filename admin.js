// Кабинет администратора салона «11».
// Показывает заявки в реальном времени, позволяет подтверждать, переносить,
// отменять записи и добавлять новые вручную.
(function () {
  'use strict';

  var cfg = window.SALON_FIREBASE || {};
  var SDK = 'https://www.gstatic.com/firebasejs/10.14.1/';
  var schedule = window.SalonSchedule;

  var STATUS = { new: 'Новая', confirmed: 'Подтверждена', done: 'Выполнена', cancelled: 'Отменена' };
  var SERVICES = [
    ['Женский зал', ['Женская стрижка', 'Детская стрижка (женский зал)', 'Окрашивание в один тон',
                     'Омбре / Шатуш / Балаяж', 'Тонировка', 'Укладка', 'Локоны', 'Причёска']],
    ['Мужской зал', ['Мужская стрижка', 'Детская стрижка (мужской зал)', 'Модельная стрижка']],
    ['Макияж', ['Свадебный образ']]
  ];
  var FILTERS = [
    { id: 'new', label: 'Новые' },
    { id: 'today', label: 'Сегодня' },
    { id: 'upcoming', label: 'Предстоящие' },
    { id: 'all', label: 'Все' }
  ];

  var db = null;
  var auth = null;
  var unsubscribe = null;
  var bookings = [];
  var filter = 'upcoming';
  var searchText = '';
  var firstLoad = true;
  var editing = null;
  var toastTimer = null;

  function $(s) { return document.querySelector(s); }

  // Создаёт элемент с безопасным текстом (данные клиентов никогда не вставляются как HTML)
  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function todayStr() { return schedule.today(); }
  function tomorrowStr() {
    var d = new Date(todayStr() + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  function fmtDate(s) {
    var p = String(s).split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    var base = d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' });
    if (s === todayStr()) return 'Сегодня, ' + base;
    if (s === tomorrowStr()) return 'Завтра, ' + base;
    return base;
  }

  function fmtShort(s) {
    var p = String(s).split('-');
    return p[2] + '.' + p[1] + '.' + p[0];
  }

  function fmtCreated(b) {
    var ts = b.createdAt;
    if (!ts || typeof ts.toDate !== 'function') return '';
    var d = ts.toDate();
    return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function phoneDigits(p) {
    var d = String(p || '').replace(/\D/g, '');
    if (d.length === 11 && d.charAt(0) === '8') d = '7' + d.slice(1);
    if (d.length === 10) d = '7' + d;
    return d;
  }

  function waText(b) {
    var when = fmtShort(b.date) + ' в ' + b.time;
    if (b.status === 'confirmed') {
      return 'Здравствуйте, ' + b.name + '! Подтверждаем вашу запись в салон красоты «11»: ' + b.service +
        ', ' + when + ', ' + schedule.masterName(b.masterId) + '. Адрес: Айтматова 36, Астана. Ждём вас!';
    }
    return 'Здравствуйте, ' + b.name + '! Это салон красоты «11». Получили вашу заявку: ' + b.service +
      ', ' + when + '. Подскажите, пожалуйста, подходит ли вам это время?';
  }

  function toast(text) {
    var t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }

  function showPanel(name) {
    ['setup', 'login', 'app'].forEach(function (id) {
      $('#' + id).hidden = id !== name;
    });
  }

  // ===== Подключение Firebase =====
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Не загрузился ' + src)); };
      document.head.appendChild(s);
    });
  }

  function ensureFirebase() {
    if (window.firebase && firebase.auth && firebase.firestore) return Promise.resolve();
    return loadScript(SDK + 'firebase-app-compat.js')
      .then(function () { return loadScript(SDK + 'firebase-auth-compat.js'); })
      .then(function () { return loadScript(SDK + 'firebase-firestore-compat.js'); });
  }

  // ===== Отрисовка =====
  function conflictIds() {
    var groups = {};
    bookings.forEach(function (b) {
      if (b.status === 'new' || b.status === 'confirmed') {
        var key = (b.masterId || 'unassigned') + ' ' + b.date + ' ' + b.time;
        (groups[key] = groups[key] || []).push(b.id);
      }
    });
    var set = {};
    Object.keys(groups).forEach(function (k) {
      if (groups[k].length > 1) groups[k].forEach(function (id) { set[id] = true; });
    });
    return set;
  }

  function matches(b, id, today) {
    if (id === 'new') return b.status === 'new';
    if (id === 'today') return b.date === today && b.status !== 'cancelled';
    if (id === 'upcoming') return b.date >= today && (b.status === 'new' || b.status === 'confirmed');
    return true;
  }

  function slot(b) { return b.date + ' ' + b.time; }

  function renderChips(counts) {
    var box = $('#chips');
    while (box.firstChild) box.removeChild(box.firstChild);
    FILTERS.forEach(function (f) {
      var chip = h('button', 'chip');
      chip.type = 'button';
      chip.setAttribute('role', 'tab');
      chip.setAttribute('aria-selected', f.id === filter ? 'true' : 'false');
      if (f.id === 'new' && counts.new > 0) chip.classList.add('attention');
      chip.appendChild(h('span', null, f.label));
      chip.appendChild(h('em', null, String(counts[f.id])));
      chip.addEventListener('click', function () { filter = f.id; render(); });
      box.appendChild(chip);
    });
  }

  function actionButton(label, cls, handler) {
    var b = h('button', 'btn ' + cls, label);
    b.type = 'button';
    b.addEventListener('click', handler);
    return b;
  }

  function buildCard(b, conflict) {
    var card = h('article', 'card status-' + b.status);

    var top = h('div', 'card-top');
    var when = h('div', 'when');
    when.appendChild(h('span', 'time', b.time));
    when.appendChild(h('span', 'date', fmtDate(b.date)));
    top.appendChild(when);
    top.appendChild(h('span', 'badge badge-' + b.status, STATUS[b.status] || b.status));
    card.appendChild(top);

    card.appendChild(h('div', 'who-line', b.name));
    card.appendChild(h('div', 'service', b.service));
    card.appendChild(h('div', 'sub', schedule.masterName(b.masterId)));

    var phone = h('div', 'sub');
    var tel = h('a', null, b.phone);
    tel.href = 'tel:+' + phoneDigits(b.phone);
    phone.appendChild(tel);
    card.appendChild(phone);

    if (b.comment) card.appendChild(h('div', 'comment', b.comment));
    if (conflict) card.appendChild(h('div', 'warn', 'Это время уже занято другой записью'));

    var meta = (b.source === 'site' ? 'Заявка с сайта' : 'Добавлено вручную');
    var created = fmtCreated(b);
    if (created) meta += ' · ' + created;
    card.appendChild(h('div', 'sub', meta));

    var actions = h('div', 'actions');
    if (b.status === 'new') {
      actions.appendChild(actionButton('Подтвердить', 'btn-ok', function () { setStatus(b, 'confirmed'); }));
      actions.appendChild(actionButton('Отменить', 'btn-danger', function () { setStatus(b, 'cancelled'); }));
    } else if (b.status === 'confirmed') {
      actions.appendChild(actionButton('Выполнено', 'btn-ok', function () { setStatus(b, 'done'); }));
      actions.appendChild(actionButton('Отменить', 'btn-danger', function () { setStatus(b, 'cancelled'); }));
    } else {
      actions.appendChild(actionButton('Вернуть в подтверждённые', '', function () { setStatus(b, 'confirmed'); }));
    }

    var wa = h('a', 'btn', 'WhatsApp');
    wa.href = 'https://wa.me/' + phoneDigits(b.phone) + '?text=' + encodeURIComponent(waText(b));
    wa.target = '_blank';
    wa.rel = 'noopener';
    actions.appendChild(wa);

    var call = h('a', 'btn', 'Позвонить');
    call.href = 'tel:+' + phoneDigits(b.phone);
    actions.appendChild(call);

    actions.appendChild(actionButton('Изменить', '', function () { openEditor(b); }));
    actions.appendChild(actionButton('Удалить', 'btn-danger', function () { removeBooking(b); }));
    card.appendChild(actions);

    return card;
  }

  function render() {
    renderSchedule();
    var today = todayStr();
    var counts = { new: 0, today: 0, upcoming: 0, all: bookings.length };
    bookings.forEach(function (b) {
      ['new', 'today', 'upcoming'].forEach(function (id) {
        if (matches(b, id, today)) counts[id]++;
      });
    });
    renderChips(counts);

    var q = searchText.trim().toLowerCase();
    var qDigits = q.replace(/\D/g, '');
    var items = bookings.filter(function (b) {
      if (!matches(b, filter, today)) return false;
      if (!q) return true;
      var byName = String(b.name).toLowerCase().indexOf(q) !== -1;
      var byPhone = qDigits.length > 1 && String(b.phone).replace(/\D/g, '').indexOf(qDigits) !== -1;
      return byName || byPhone;
    });

    items.sort(function (a, b) {
      if (filter === 'all') return slot(b).localeCompare(slot(a));
      return slot(a).localeCompare(slot(b));
    });

    var conflicts = conflictIds();
    var list = $('#list');
    while (list.firstChild) list.removeChild(list.firstChild);
    items.forEach(function (b) { list.appendChild(buildCard(b, !!conflicts[b.id])); });
    $('#empty').hidden = items.length > 0;
  }

  // ===== Действия =====
  function setStatus(b, status) {
    schedule.saveAdmin(db, b.id, { status: status }, false)
      .then(function () { toast('Статус: ' + STATUS[status]); })
      .catch(function (err) { toast(err.message || 'Не удалось сохранить'); });
  }

  function removeBooking(b) {
    if (!window.confirm('Удалить запись «' + b.name + ', ' + fmtShort(b.date) + ' ' + b.time + '»? Это нельзя отменить.')) return;
    schedule.saveAdmin(db, b.id, null, true)
      .then(function () { toast('Запись удалена'); })
      .catch(function () { toast('Не удалось удалить. Проверьте интернет'); });
  }

  // ===== Окно записи =====
  function fillSelects() {
    schedule.fillMasters($('#e-master'));
    schedule.fillMasters($('#schedule-master'));
    $('#schedule-date').value = todayStr();
    var service = $('#e-service');
    var first = h('option', null, 'Выберите услугу');
    first.value = '';
    service.appendChild(first);
    SERVICES.forEach(function (group) {
      var og = document.createElement('optgroup');
      og.label = group[0];
      group[1].forEach(function (name) {
        var o = h('option', null, name);
        o.value = name;
        og.appendChild(o);
      });
      service.appendChild(og);
    });

    var time = $('#e-time');
    schedule.times.forEach(function (t) {
        var o = h('option', null, t);
        o.value = t;
        time.appendChild(o);
    });
  }

  function ensureOption(select, value) {
    var found = Array.prototype.some.call(select.options, function (o) { return o.value === value; });
    if (!found && value) {
      var o = h('option', null, value);
      o.value = value;
      select.appendChild(o);
    }
  }

  function openEditor(b) {
    editing = b || null;
    $('#editor-title').textContent = b ? 'Изменить запись' : 'Новая запись';
    $('#editor-error').hidden = true;

    $('#e-name').value = b ? b.name : '';
    $('#e-phone').value = b ? b.phone : '';
    if (b) { ensureOption($('#e-service'), b.service); ensureOption($('#e-time'), b.time); }
    $('#e-service').value = b ? b.service : '';
    schedule.fillMasters($('#e-master'), $('#e-service').value);
    if (b) ensureOption($('#e-master'), b.masterId);
    $('#e-master').value = b ? (b.masterId || '') : $('#schedule-master').value;
    $('#e-date').value = b ? b.date : todayStr();
    $('#e-time').value = b ? b.time : '10:00';
    $('#e-status').value = b ? b.status : 'confirmed';
    $('#e-comment').value = b ? (b.comment || '') : '';

    $('#editor').showModal();
    renderEditorTimes();
  }

  function renderEditorTimes() {
    var masterId = $('#e-master').value;
    var date = $('#e-date').value;
    Array.from($('#e-time').options).forEach(function (o) {
      var busy = bookings.some(function (b) {
        return schedule.active(b) && b.masterId === masterId && b.date === date && b.time === o.value &&
          (!editing || b.id !== editing.id);
      });
      o.textContent = o.value + (busy ? ' — Занято' : '');
      o.disabled = busy;
      if (busy && o.selected) $('#e-time').value = '';
    });
  }

  function renderSchedule() {
    var masterId = $('#schedule-master').value;
    var date = $('#schedule-date').value;
    var box = $('#schedule-slots');
    box.replaceChildren();
    if (!date) { $('#schedule-hint').textContent = 'Выберите дату расписания'; return; }
    var unassigned = bookings.filter(function (b) { return schedule.active(b) && b.date === date && !b.masterId; }).length;
    $('#schedule-hint').textContent = unassigned
      ? 'Есть записей без мастера: ' + unassigned + '. Назначьте мастера через «Изменить», чтобы учесть их в расписании.'
      : 'Выберите свободное окно, чтобы добавить запись. Занятое окно открывает запись.';
    schedule.times.forEach(function (time) {
      var booked = bookings.find(function (b) {
        return schedule.active(b) && b.masterId === masterId && b.date === date && b.time === time;
      });
      var button = h('button', 'time-slot' + (booked ? ' busy' : ''), time + (booked ? ' · ' + booked.name : ' · Свободно'));
      button.type = 'button';
      button.addEventListener('click', function () {
        openEditor(booked || null);
        if (!booked) {
          $('#e-date').value = date;
          $('#e-time').value = time;
          renderEditorTimes();
        }
      });
      box.appendChild(button);
    });
    if ($('#editor').open) renderEditorTimes();
  }

  function saveEditor(e) {
    e.preventDefault();
    var err = $('#editor-error');
    var data = {
      name: $('#e-name').value.trim(),
      phone: $('#e-phone').value.trim(),
      service: $('#e-service').value,
      masterId: $('#e-master').value,
      date: $('#e-date').value,
      time: $('#e-time').value,
      status: $('#e-status').value,
      comment: $('#e-comment').value.trim().slice(0, 300)
    };

    var problem = '';
    if (!data.name) problem = 'Введите имя клиента';
    else if (data.phone.replace(/\D/g, '').length < 6) problem = 'Введите телефон клиента';
    else if (!data.service) problem = 'Выберите услугу';
    else if (!data.masterId) problem = 'Выберите мастера';
    else if (!data.date) problem = 'Выберите дату';
    else if (!data.time) problem = 'Выберите время';
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    err.hidden = true;

    var save = $('#editor-save');
    save.disabled = true;

    var editId = editing ? editing.id : null;
    if (!editing) {
      data.source = 'admin';
      data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    }
    var request = schedule.saveAdmin(db, editId, data, false);

    request.then(function () {
      $('#editor').close();
      toast(editId ? 'Запись обновлена' : 'Запись добавлена');
    }).catch(function (error) {
      err.textContent = error.message || 'Не удалось сохранить. Проверьте интернет и попробуйте снова';
      err.hidden = false;
    }).then(function () {
      save.disabled = false;
    });
  }

  // ===== Подписка на заявки =====
  function loginError(text) {
    var el = $('#login-error');
    el.textContent = text;
    el.hidden = false;
  }

  function subscribe() {
    if (unsubscribe) unsubscribe();
    firstLoad = true;
    unsubscribe = db.collection('bookings').onSnapshot(function (snap) {
      var fresh = [];
      snap.docChanges().forEach(function (ch) {
        var d = ch.doc.data();
        if (ch.type === 'added' && !firstLoad && d.source === 'site' && !ch.doc.metadata.hasPendingWrites) fresh.push(d);
      });
      bookings = snap.docs.map(function (doc) {
        var x = doc.data();
        x.id = doc.id;
        return x;
      });
      firstLoad = false;
      render();
      fresh.forEach(function (d) { toast('Новая заявка: ' + d.name + ', ' + d.service); });
    }, function (error) {
      if (error && error.code === 'permission-denied') {
        loginError('У этого аккаунта нет доступа к записям. Проверьте почту администратора в правилах базы.');
        auth.signOut();
      } else {
        toast('Не удалось загрузить записи. Проверьте интернет');
      }
    });
  }

  function init() {
    if (!firebase.apps.length) firebase.initializeApp(cfg);
    auth = firebase.auth();
    db = firebase.firestore();

    auth.onAuthStateChanged(function (user) {
      if (user) {
        $('#who').textContent = user.email || '';
        showPanel('app');
        subscribe();
      } else {
        if (unsubscribe) { unsubscribe(); unsubscribe = null; }
        bookings = [];
        showPanel('login');
      }
    });
  }

  // ===== Обработчики =====
  function bind() {
    fillSelects();
    $('#schedule-master').addEventListener('change', renderSchedule);
    $('#schedule-date').addEventListener('change', renderSchedule);
    $('#e-master').addEventListener('change', renderEditorTimes);
    $('#e-service').addEventListener('change', function () {
      schedule.fillMasters($('#e-master'), $('#e-service').value);
      renderEditorTimes();
    });
    $('#e-date').addEventListener('change', renderEditorTimes);

    $('#login-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var email = $('#login-email').value.trim();
      var pass = $('#login-pass').value;
      var btn = $('#login-submit');
      $('#login-error').hidden = true;
      if (!email || !pass) { loginError('Введите почту и пароль'); return; }
      if (!auth) { loginError('Облако ещё подключается. Подождите секунду и повторите'); return; }
      btn.disabled = true;
      auth.signInWithEmailAndPassword(email, pass).catch(function (error) {
        var code = error && error.code;
        if (code === 'auth/too-many-requests') loginError('Слишком много попыток. Подождите несколько минут');
        else if (code === 'auth/network-request-failed') loginError('Нет связи с интернетом');
        else loginError('Неверная почта или пароль');
      }).then(function () {
        btn.disabled = false;
      });
    });

    $('#logout').addEventListener('click', function () { auth.signOut(); });
    $('#add').addEventListener('click', function () { openEditor(null); });
    $('#search').addEventListener('input', function (e) { searchText = e.target.value; render(); });
    $('#editor-form').addEventListener('submit', saveEditor);
    $('#editor-cancel').addEventListener('click', function () { $('#editor').close(); });
  }

  // ===== Запуск =====
  if (!cfg.apiKey) {
    showPanel('setup');
    return;
  }

  bind();
  ensureFirebase().then(init).catch(function () {
    showPanel('login');
    loginError('Не удалось подключиться к облаку. Проверьте интернет и обновите страницу.');
  });
})();
