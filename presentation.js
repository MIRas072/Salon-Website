// Client presentation controls share the existing booking and availability logic.
(function () {
  var service = document.getElementById('f-service');
  var master = document.getElementById('f-master');
  function change(el) { el.dispatchEvent(new Event('change', { bubbles: true })); }
  document.querySelectorAll('[data-service]').forEach(function (button) {
    button.addEventListener('click', function () {
      service.value = button.dataset.service;
      change(service);
      document.getElementById('booking').scrollIntoView({behavior:'smooth'});
    });
  });
  document.querySelectorAll('[data-master]').forEach(function (button) {
    button.addEventListener('click', function () {
      if (service.value && !window.SalonSchedule.canServe(button.dataset.master, service.value)) {
        service.value = '';
        change(service);
      }
      master.value = button.dataset.master;
      change(master);
      document.getElementById('booking').scrollIntoView({behavior:'smooth'});
    });
  });
})();
