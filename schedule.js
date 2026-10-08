// Общие настройки сайта и кабинета. Список услуг также проверяется в firestore.rules.
(function () {
  'use strict';
  var services = ['Женская стрижка', 'Детская стрижка (женский зал)', 'Окрашивание в один тон',
    'Омбре / Шатуш / Балаяж', 'Тонировка', 'Укладка', 'Локоны', 'Причёска',
    'Мужская стрижка', 'Детская стрижка (мужской зал)', 'Модельная стрижка', 'Свадебный образ'];
  var masters = [
    { id: 'master-1', name: 'Назигуль', services: services.slice() },
    { id: 'master-2', name: 'Арай', services: services.filter(function (s) { return s !== 'Свадебный образ'; }) },
    { id: 'master-3', name: 'Жазира', services: ['Мужская стрижка', 'Детская стрижка (мужской зал)', 'Модельная стрижка'] }
  ];
  var times = [];
  for (var hour = 10; hour < 20; hour++) {
    times.push(hour + ':00', hour + ':30');
  }
  var timezone = 'Asia/Almaty';
  function localParts() {
    var result = {};
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date()).forEach(function (p) { result[p.type] = p.value; });
    return result;
  }
  function duration(service) { return service === 'Окрашивание в один тон' ? 60 : 30; }
  function slotTimes(b) {
    var index = times.indexOf(b.time);
    // Старые записи без длительности резервировали только одно окно.
    var count = b.durationMinutes === 60 ? 2 : 1;
    return index < 0 ? [] : times.slice(index, index + count);
  }
  function fits(service, time) {
    var index = times.indexOf(time);
    return index >= 0 && index + duration(service) / 30 <= times.length;
  }
  window.SalonSchedule = {
    masters: masters,
    times: times,
    duration: duration,
    slotTimes: slotTimes,
    fits: fits,
    available: function (service, time, occupied) {
      return fits(service, time) && slotTimes({time: time, durationMinutes: duration(service)})
        .every(function (t) { return !occupied[t]; });
    },
    today: function () {
      var p = localParts();
      return p.year + '-' + p.month + '-' + p.day;
    },
    isPast: function (date, time) {
      var p = localParts();
      var today = p.year + '-' + p.month + '-' + p.day;
      return date < today || (date === today && time <= p.hour + ':' + p.minute);
    },
    masterName: function (id) {
      var master = masters.find(function (m) { return m.id === id; });
      return master ? master.name : 'Мастер не назначен';
    },
    slotId: function (b) { return b.masterId + '_' + b.date + '_' + b.time; },
    active: function (b) { return b.status === 'new' || b.status === 'confirmed'; },
    canServe: function (id, service) {
      return masters.some(function (m) { return m.id === id && m.services.indexOf(service) !== -1; });
    },
    fillMasters: function (select, service) {
      var previous = select.value;
      var placeholder = Array.from(select.options).find(function (o) { return o.value === ''; });
      select.replaceChildren();
      if (placeholder) select.appendChild(placeholder);
      masters.filter(function (m) { return !service || m.services.indexOf(service) !== -1; }).forEach(function (m) {
        var option = document.createElement('option');
        option.value = m.id;
        option.textContent = m.name;
        select.appendChild(option);
      });
      if (Array.from(select.options).some(function (o) { return o.value === previous; })) select.value = previous;
    },
    reserve: function (db, data) {
      data = Object.assign({}, data, { durationMinutes: duration(data.service) });
      if (!fits(data.service, data.time)) return Promise.reject(new Error('Услуга должна закончиться до 20:00'));
      var booking = db.collection('bookings').doc();
      var batch = db.batch();
      batch.set(booking, data);
      var self = this;
      slotTimes(data).forEach(function (time) {
        var slotData = { masterId: data.masterId, date: data.date, time: time, bookingId: booking.id };
        batch.set(db.collection('availability').doc(self.slotId(slotData)), slotData);
      });
      return batch.commit();
    },
    // Чтение актуальной записи и слотов внутри транзакции защищает от гонок
    // между переносом, отменой и одновременной записью другого клиента.
    saveAdmin: function (db, id, changes, remove) {
      var ref = id ? db.collection('bookings').doc(id) : db.collection('bookings').doc();
      var self = this;
      return db.runTransaction(async function (tx) {
        var before = id ? await tx.get(ref) : null;
        if (id && !before.exists) throw new Error('Запись уже удалена');
        var old = before ? before.data() : null;
        var next = remove ? null : Object.assign({}, old || {}, changes);
        if (next) next.durationMinutes = duration(next.service);
        if (next && self.active(next) && !next.masterId) {
          throw new Error('Сначала назначьте мастера через «Изменить»');
        }
        if (next && self.active(next) && next.masterId && !self.canServe(next.masterId, next.service)) throw new Error('Мастер не оказывает выбранную услугу');
        if (next && self.active(next) && !fits(next.service, next.time)) throw new Error('Услуга должна закончиться до 20:00');
        function reservations(b) {
          return b && b.masterId && self.active(b) ? slotTimes(b).map(function (time) {
            return { masterId: b.masterId, date: b.date, time: time, bookingId: ref.id };
          }) : [];
        }
        var oldSlots = reservations(old);
        var nextSlots = reservations(next);
        var refs = {};
        oldSlots.concat(nextSlots).forEach(function (s) {
          var key = self.slotId(s);
          refs[key] = db.collection('availability').doc(key);
        });
        var snaps = {};
        // Все чтения происходят до первой записи, включая вторую половину часа.
        for (var key of Object.keys(refs)) snaps[key] = await tx.get(refs[key]);
        nextSlots.forEach(function (s) {
          var snap = snaps[self.slotId(s)];
          if (snap.exists && snap.data().bookingId !== ref.id) throw new Error('Это время у мастера уже занято. Выберите другое окно');
        });
        oldSlots.forEach(function (s) {
          var key = self.slotId(s);
          if (snaps[key].exists && snaps[key].data().bookingId === ref.id &&
              !nextSlots.some(function (n) { return self.slotId(n) === key; })) tx.delete(refs[key]);
        });
        nextSlots.forEach(function (s) {
          var key = self.slotId(s);
          if (!snaps[key].exists) tx.set(refs[key], s);
        });
        if (remove) tx.delete(ref);
        else tx.set(ref, next);
      });
    }
  };
})();
