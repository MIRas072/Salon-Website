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
  window.SalonSchedule = {
    masters: masters,
    times: times,
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
      var booking = db.collection('bookings').doc();
      var slot = db.collection('availability').doc(this.slotId(data));
      var batch = db.batch();
      batch.set(booking, data);
      batch.set(slot, { masterId: data.masterId, date: data.date, time: data.time, bookingId: booking.id });
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
        if (next && self.active(next) && !next.masterId) {
          throw new Error('Сначала назначьте мастера через «Изменить»');
        }
        if (next && self.active(next) && next.masterId && !self.canServe(next.masterId, next.service)) throw new Error('Мастер не оказывает выбранную услугу');
        var oldSlot = old && old.masterId && self.active(old)
          ? db.collection('availability').doc(self.slotId(old)) : null;
        var nextSlot = next && self.active(next)
          ? db.collection('availability').doc(self.slotId(next)) : null;
        var oldSnap = oldSlot ? await tx.get(oldSlot) : null;
        var nextSnap = nextSlot ? await tx.get(nextSlot) : null;
        if (nextSnap && nextSnap.exists && nextSnap.data().bookingId !== ref.id) {
          throw new Error('Это время у мастера уже занято. Выберите другое окно');
        }
        if (oldSnap && oldSnap.exists && oldSnap.data().bookingId === ref.id &&
            (!nextSlot || oldSlot.id !== nextSlot.id)) tx.delete(oldSlot);
        if (nextSlot && !nextSnap.exists) {
          tx.set(nextSlot, { masterId: next.masterId, date: next.date, time: next.time, bookingId: ref.id });
        }
        if (remove) tx.delete(ref);
        else tx.set(ref, next);
      });
    }
  };
})();
