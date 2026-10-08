// Run: node tests/booking-browser.cjs (requires Playwright and Chromium).
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH || (require('node:fs').existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined)});
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://fonts.googleapis.com/**', route => route.abort());
    await page.route('https://fonts.gstatic.com/**', route => route.abort());
    await page.route('**/firebase-config.js', route => route.fulfill({contentType:'application/javascript', body:'window.SALON_FIREBASE = {};'}));
    const base = process.env.SALON_TEST_URL || 'http://127.0.0.1:8000';
    await page.goto(base);
    await page.locator('#f-service').selectOption('Свадебный образ');
    assert.deepEqual(await page.locator('#f-master option').evaluateAll(options => options.filter(o => o.value).map(o => o.textContent)), ['Назигуль']);
    await page.locator('#f-service').selectOption('Женская стрижка');
    assert.deepEqual(await page.locator('#f-master option').evaluateAll(options => options.filter(o => o.value).map(o => o.textContent)), ['Назигуль', 'Арай']);
    await page.locator('#f-service').selectOption('Мужская стрижка');
    assert.equal(await page.locator('#f-master option').count(), 4);
    await page.locator('#f-master').selectOption('master-3');
    await page.locator('#f-date').fill('2099-10-09');
    await page.locator('#f-name').fill('Тест');
    await page.locator('#f-time').selectOption('16:00');
    await page.evaluate(() => { window.open = url => { window.waUrl = url; }; });
    await page.locator('#form-submit').click();
    assert.match(decodeURIComponent(await page.evaluate(() => window.waUrl)), /Мастер: Жазира/);
    assert.match(await page.locator('#availability-hint').innerText(), /желаемое время/);
    await page.setViewportSize({width: 390, height: 844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    console.log('PASS: master service restrictions, WhatsApp, mobile layout');

    // A deterministic Firebase double exercises the UI, including realtime changes
    // and write failures. Actual security/race semantics are tested in rules tests.
    await page.route('**/firebase-config.js', route => route.fulfill({contentType:'application/javascript', body:'window.SALON_FIREBASE = {apiKey:"test"};'}));
    await page.addInitScript(() => {
      window.testState = {time: '16:00', masterId: 'master-1', commitFails: false, subscriptions: [], batches: []};
      function snap(subscription) {
        const times = window.testState.times || [window.testState.time];
        const rows = subscription.masterId === window.testState.masterId
          ? times.filter(Boolean).map(time=>({data: () => ({time})})) : [];
        return {metadata: {fromCache: !!window.testState.fromCache}, docs: rows};
      }
      const db = {
        collection: name => {
          const query = {name, masterId: '', date: '',
            where(key, op, value) { this[key] = value; return this; },
            doc(id) { return {id: id || 'new-booking', collection: name}; },
            onSnapshot(options, next, error) {
              const sub = {masterId:this.masterId, date:this.date, next, error, active:true};
              window.testState.subscriptions.push(sub);
              setTimeout(() => { if (sub.active) next(snap(sub)); }, 0);
              return () => { sub.active = false; };
            }
          };
          return query;
        },
        batch: () => {
          const ops = [];
          return {set: (ref, data) => ops.push({ref, data}), commit: () => {
            window.testState.batches.push(ops);
            if (window.testState.commitFails) return Promise.reject({code:'permission-denied'});
            window.testState.time = ops[1].data.time;
            window.testState.times = ops.slice(1).map(op=>op.data.time);
            window.testState.masterId = ops[1].data.masterId;
            window.emitAvailability();
            return Promise.resolve();
          }};
        }
      };
      window.emitAvailability = () => window.testState.subscriptions.forEach(sub => {if(sub.active) sub.next(snap(sub));});
      window.firebase = {apps:[{}], firestore:() => db};
      window.firebase.firestore.FieldValue = {serverTimestamp:() => 'server-time'};
    });
    await page.goto(base);
    await page.locator('#f-service').selectOption('Женская стрижка');
    await page.locator('#f-master').selectOption('master-1');
    await page.locator('#f-date').fill('2099-10-09');
    await page.waitForFunction(() => !document.querySelector('#f-time').disabled);
    assert.equal(await page.locator('#f-time option[value="16:00"]').evaluate(o => o.disabled), true);
    assert.match(await page.locator('#f-time option[value="16:00"]').innerText(), /Занято/);
    await page.evaluate(() => { window.testState.fromCache = true; window.emitAvailability(); });
    assert.equal(await page.locator('#f-time').isDisabled(), true);
    assert.equal(await page.locator('#form-submit').isDisabled(), true);
    await page.evaluate(() => { window.testState.fromCache = false; window.emitAvailability(); });
    assert.equal(await page.locator('#f-time').isDisabled(), false);
    await page.locator('#f-time').selectOption('16:30');
    await page.evaluate(() => { window.testState.time = '16:30'; window.emitAvailability(); });
    assert.equal(await page.locator('#f-time').inputValue(), '');
    assert.equal(await page.locator('#f-time option[value="16:30"]').evaluate(o => o.disabled), true);
    await page.locator('#f-master').selectOption('master-2');
    await page.waitForFunction(() => !document.querySelector('#f-time').disabled);
    assert.equal(await page.locator('#f-time option[value="16:30"]').evaluate(o => o.disabled), false);
    await page.evaluate(() => {
      // Late callbacks from a previously selected master must be ignored.
      const old = window.testState.subscriptions[0];
      old.next({metadata:{fromCache:false},docs:[{data:()=>({time:'16:30'})}]});
    });
    assert.equal(await page.locator('#f-time option[value="16:30"]').evaluate(o => o.disabled), false);
    await page.locator('#f-name').fill('Клиент');
    await page.locator('#f-phone').fill('87771234567');
    await page.locator('#f-time').selectOption('16:30');
    await page.evaluate(() => { window.testState.commitFails = true; });
    await page.locator('#form-submit').click();
    await page.waitForFunction(() => !document.querySelector('#form-submit').disabled);
    assert.equal(await page.locator('#booking-success').isVisible(), false);
    assert.match(await page.locator('#form-error').innerText(), /Выберите другое окно/);
    await page.evaluate(() => { window.testState.commitFails = false; });
    await page.locator('#form-submit').click();
    await page.locator('#booking-success').waitFor({state:'visible'});
    assert.match(await page.locator('#success-text').innerText(), /16:30, Арай/);
    assert.equal(await page.evaluate(() => window.testState.batches.at(-1).length), 2);
    console.log('PASS: occupied window disabled, realtime invalidation, independent masters, cached data blocked, stale callbacks ignored, failure recovery, atomic booking payload');
    await page.goto(base);
    await page.evaluate(()=>localStorage.removeItem('salonLastBooking'));
    await page.locator('#f-service').selectOption('Окрашивание в один тон');
    await page.locator('#f-master').selectOption('master-1');
    await page.locator('#f-date').fill('2099-10-09');
    await page.waitForFunction(()=>!document.querySelector('#f-time').disabled);
    assert.match(await page.locator('#availability-hint').innerText(),/1 час/);
    assert.equal(await page.locator('#f-time option[value="15:30"]').evaluate(o=>o.disabled),true);
    assert.equal(await page.locator('#f-time option[value="16:30"]').evaluate(o=>o.disabled),false);
    assert.equal(await page.locator('#f-time option[value="19:30"]').evaluate(o=>o.disabled),true);
    await page.locator('#f-time').selectOption('17:00');
    await page.evaluate(()=>{window.testState.time='17:30';window.emitAvailability();});
    assert.equal(await page.locator('#f-time').inputValue(),'');
    assert.equal(await page.locator('#f-time option[value="17:00"]').evaluate(o=>o.disabled),true);
    await page.locator('#f-service').selectOption('Женская стрижка');
    await page.waitForFunction(()=>!document.querySelector('#f-time').disabled);
    assert.equal(await page.locator('#f-time option[value="17:00"]').evaluate(o=>o.disabled),false);
    await page.locator('#f-service').selectOption('Окрашивание в один тон');
    await page.locator('#f-master').selectOption('master-2');
    await page.waitForFunction(()=>!document.querySelector('#f-time').disabled);
    await page.locator('#f-name').fill('Окрашивание');
    await page.locator('#f-phone').fill('87771234567');
    await page.locator('#f-time').selectOption('17:00');
    await page.locator('#form-submit').click();
    await page.locator('#booking-success').waitFor({state:'visible'});
    assert.match(await page.locator('#success-text').innerText(),/1 час/);
    const payload = await page.evaluate(()=>window.testState.batches.at(-1));
    assert.equal(payload[0].data.durationMinutes,60);
    assert.deepEqual(payload.slice(1).map(op=>op.data.time),['17:00','17:30']);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth > innerWidth),false);
    console.log('PASS: coloring needs consecutive windows; next-half realtime conflicts invalidate selection, closing limits apply, submission reserves one hour');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
