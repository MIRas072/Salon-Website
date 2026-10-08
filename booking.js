// Форма записи на сайте.
// Если подключён Firebase: заявка сохраняется в базу и появляется в кабинете администратора.
// Если нет: открывается WhatsApp с готовым сообщением.
(function () {
  var form = document.getElementById('booking-form');
  if (!form) return;

  var cfg = window.SALON_FIREBASE || {};
  var configured = !!cfg.apiKey;
  var schedule = window.SalonSchedule;
  var SDK = 'https://www.gstatic.com/firebasejs/10.14.1/';

  function $(id) { return document.getElementById(id); }
  var nameEl = $('f-name');
  var phoneEl = $('f-phone');
  var serviceEl = $('f-service');
  var masterEl = $('f-master');
  var dateEl = $('f-date');
  var timeEl = $('f-time');
  var commentEl = $('f-comment');
  var hpEl = $('f-site');
  var errorEl = $('form-error');
  var submitEl = $('form-submit');
  var hintEl = $('form-hint');
  var successEl = $('booking-success');

  schedule.fillMasters(masterEl);
  dateEl.min = schedule.today();
  var occupied = {};
  var availabilityReady = false;
  var availabilityVersion = 0;
  var unsubscribe = null;
  var sending = false;
  var slotButtons = $('time-slots');
  var availabilityHint = $('availability-hint');

  function renderTimes() {
    var chosen = timeEl.value;
    timeEl.replaceChildren(new Option('Выберите время', ''));
    slotButtons.replaceChildren();
    timeEl.disabled = !availabilityReady || sending;
    schedule.times.forEach(function (t) {
      var past = dateEl.value && schedule.isPast(dateEl.value, t);
      var busy = !!occupied[t];
      var fits = schedule.fits(serviceEl.value, t);
      var overlap = !schedule.available(serviceEl.value, t, occupied);
      var disabled = !availabilityReady || overlap || past;
      var label = t + (busy ? ' — Занято' : !fits ? ' — Не успеем до закрытия' : overlap ? ' — Нет часа подряд' : past ? ' — Прошло' : configured && availabilityReady ? ' — Свободно' : '');
      var option = new Option(label, t);
      option.disabled = disabled;
      timeEl.appendChild(option);
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'time-slot' + (busy ? ' busy' : '');
      button.textContent = label;
      if (busy) button.title = 'На это время уже записан другой клиент';
      else if (overlap && fits) button.title = 'Следующие 30 минут заняты другим клиентом';
      button.disabled = disabled || sending;
      button.setAttribute('aria-pressed', String(chosen === t && !disabled));
      button.addEventListener('click', function () {
        timeEl.value = t;
        errorEl.hidden = true;
        renderTimes();
      });
      slotButtons.appendChild(button);
      if (chosen === t && !disabled) timeEl.value = t;
    });
    if (chosen && !timeEl.value) showError('Выбранное время недоступно. Выберите свободное окно');
    if (configured && availabilityReady) {
      var free = schedule.times.filter(function (t) {
        return schedule.available(serviceEl.value, t, occupied) && !schedule.isPast(dateEl.value, t);
      }).length;
      availabilityHint.textContent = (schedule.duration(serviceEl.value) === 60 ? 'Окрашивание занимает 1 час. ' : '') +
        (free ? 'Свободных окон: ' + free + '. Занятые окна выбрать нельзя.' : 'На эту дату свободных окон нет. Выберите другую дату или мастера.');
    }
    submitEl.disabled = sending || (configured && !availabilityReady);
  }

  function refreshAvailability() {
    var version = ++availabilityVersion;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    occupied = {};
    availabilityReady = false;
    if (!masterEl.value || !dateEl.value || dateEl.value < schedule.today()) {
      availabilityHint.textContent = 'Выберите мастера и дату не раньше сегодняшней.';
      renderTimes();
      return;
    }
    if (!configured) {
      availabilityReady = true;
      availabilityHint.textContent = 'Это желаемое время. Свободные окна пока не подключены — уточните у администратора в WhatsApp.';
      renderTimes();
      return;
    }
    availabilityHint.textContent = 'Проверяем свободные окна…';
    renderTimes();
    var masterId = masterEl.value;
    var date = dateEl.value;
    getDb().then(function (db) {
      if (version !== availabilityVersion) return;
      unsubscribe = db.collection('availability').where('masterId', '==', masterId).where('date', '==', date)
        .onSnapshot({ includeMetadataChanges: true }, function (snap) {
          if (version !== availabilityVersion) return;
          // Кэш может не знать о новых записях. Разрешаем выбор только после ответа сервера.
          availabilityReady = !snap.metadata.fromCache;
          occupied = {};
          snap.docs.forEach(function (doc) { occupied[doc.data().time] = true; });
          if (!availabilityReady) availabilityHint.textContent = 'Ожидаем актуальное расписание. Проверьте интернет.';
          renderTimes();
        }, function () {
          if (version !== availabilityVersion) return;
          availabilityReady = false;
          availabilityHint.textContent = 'Не удалось загрузить расписание. Выберите дату повторно или свяжитесь с салоном.';
          renderTimes();
        });
    }).catch(function () {
      if (version !== availabilityVersion) return;
      availabilityHint.textContent = 'Не удалось подключиться к расписанию. Выберите дату повторно или свяжитесь с салоном.';
    });
  }
  masterEl.addEventListener('change', refreshAvailability);
  serviceEl.addEventListener('change', function () {
    schedule.fillMasters(masterEl, serviceEl.value);
    refreshAvailability();
  });
  dateEl.addEventListener('change', refreshAvailability);
  timeEl.addEventListener('change', renderTimes);
  setInterval(function () { dateEl.min = schedule.today(); renderTimes(); }, 60000);
  renderTimes();

  if (configured) {
    hintEl.textContent = 'Оставьте заявку, и администратор свяжется с вами, чтобы подтвердить время.';
    submitEl.textContent = 'Отправить заявку';
  }

  function showError(text) {
    errorEl.textContent = text;
    errorEl.hidden = false;
  }

  [nameEl, phoneEl, serviceEl, masterEl, dateEl, timeEl, commentEl].forEach(function (el) {
    el.addEventListener('input', function () { errorEl.hidden = true; });
  });

  function formatDate(value) {
    var p = value.split('-');
    return p[2] + '.' + p[1] + '.' + p[0];
  }

  // Подключение к Firebase загружается только когда оно нужно
  var dbPromise = null;
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Не загрузился ' + src)); };
      document.head.appendChild(s);
    });
  }
  function getDb() {
    if (!dbPromise) {
      var ready = (window.firebase && firebase.firestore)
        ? Promise.resolve()
        : loadScript(SDK + 'firebase-app-compat.js').then(function () {
            return loadScript(SDK + 'firebase-firestore-compat.js');
          });
      dbPromise = ready.then(function () {
        if (!firebase.apps.length) firebase.initializeApp(cfg);
        return firebase.firestore();
      }).catch(function (err) {
        dbPromise = null;
        throw err;
      });
    }
    return dbPromise;
  }
  if (configured) {
    form.addEventListener('focusin', function () { getDb().catch(function () {}); }, { once: true });
  }

  function showSuccess(name, phone, details) {
    details = details || { service: serviceEl.value, date: dateEl.value, time: timeEl.value, masterId: masterEl.value };
    $('success-text').textContent =
      'Спасибо, ' + name + '! Заявка на «' + details.service + '», ' + formatDate(details.date) +
      ' в ' + details.time + ', ' + schedule.masterName(details.masterId) +
      (schedule.duration(details.service) === 60 ? ' (1 час)' : '') + ', принята. Мы позвоним или напишем на номер ' + phone +
      ', чтобы подтвердить запись.';
    form.hidden = true;
    successEl.hidden = false;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = nameEl.value.trim();
    var phone = phoneEl.value.trim();
    var digits = phone.replace(/\D/g, '');

    if (!name) { showError('Введите ваше имя'); nameEl.focus(); return; }
    if (!serviceEl.value) { showError('Выберите услугу'); serviceEl.focus(); return; }
    if (!masterEl.value) { showError('Выберите мастера'); masterEl.focus(); return; }
    if (!schedule.canServe(masterEl.value, serviceEl.value)) { showError('Мастер не оказывает выбранную услугу'); return; }

    // Запасной вариант, пока Firebase не подключён: запись через WhatsApp
    if (!configured) {
      errorEl.hidden = true;
      var lines = ['Здравствуйте! Хочу записаться в салон «11».',
                   'Имя: ' + name,
                   'Услуга: ' + serviceEl.value,
                   'Мастер: ' + schedule.masterName(masterEl.value)];
      if (phone) lines.push('Телефон: ' + phone);
      if (dateEl.value) lines.push('Дата: ' + formatDate(dateEl.value));
      if (timeEl.value) lines.push('Время: ' + timeEl.value);
      window.open('https://wa.me/77779487708?text=' + encodeURIComponent(lines.join('\n')), '_blank', 'noopener');
      return;
    }

    if (digits.length < 10 || digits.length > 15) { showError('Введите номер телефона, например 8 777 123 45 67'); phoneEl.focus(); return; }
    if (!dateEl.value) { showError('Выберите дату'); dateEl.focus(); return; }
    if (!timeEl.value) { showError('Выберите время'); timeEl.focus(); return; }
    if (!availabilityReady || !schedule.available(serviceEl.value, timeEl.value, occupied) || schedule.isPast(dateEl.value, timeEl.value)) {
      showError('Это время недоступно. Выберите свободное окно'); return;
    }
    if (sending) return;
    errorEl.hidden = true;

    // Скрытое поле-ловушка для ботов: люди его не видят и не заполняют
    if (hpEl && hpEl.value) { showSuccess(name, phone); return; }

    // Защита от случайных повторных отправок
    try {
      var last = Number(localStorage.getItem('salonLastBooking') || 0);
      if (Date.now() - last < 20000) { showError('Заявка уже отправляется. Подождите несколько секунд'); return; }
    } catch (err) { /* без хранилища продолжаем */ }

    sending = true;
    var details = { service: serviceEl.value, date: dateEl.value, time: timeEl.value, masterId: masterEl.value };
    [nameEl, phoneEl, serviceEl, masterEl, dateEl, commentEl].forEach(function (el) { el.disabled = true; });
    renderTimes();
    submitEl.textContent = 'Отправляем…';

    getDb().then(function (db) {
      return schedule.reserve(db, {
        name: name.slice(0, 80),
        phone: phone.slice(0, 20),
        service: details.service,
        masterId: details.masterId,
        date: details.date,
        time: details.time,
        comment: commentEl.value.trim().slice(0, 300),
        status: 'new',
        source: 'site',
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }).then(function () {
      try { localStorage.setItem('salonLastBooking', String(Date.now())); } catch (err) { /* ничего */ }
      showSuccess(name, phone, details);
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    }).catch(function (err) {
      sending = false;
      [nameEl, phoneEl, serviceEl, masterEl, dateEl, commentEl].forEach(function (el) { el.disabled = false; });
      renderTimes();
      showError(err && err.code === 'permission-denied'
        ? 'Время могло занять другое лицо. Выберите другое окно. Если ошибка повторяется, свяжитесь с салоном.'
        : 'Не удалось отправить заявку. Позвоните нам или напишите в WhatsApp.');
      submitEl.textContent = 'Отправить заявку';
    });
  });
})();
