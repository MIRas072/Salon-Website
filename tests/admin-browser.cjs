const assert = require('node:assert/strict');
const {chromium} = require('playwright');
(async () => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_PATH || (require('node:fs').existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined)});
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://fonts.googleapis.com/**', route => route.abort());
    await page.route('https://fonts.gstatic.com/**', route => route.abort());
    await page.route('**/firebase-config.js', route => route.fulfill({contentType:'application/javascript', body:'window.SALON_FIREBASE={apiKey:"test"};'}));
    await page.addInitScript(() => {
      const store = new Map();
      const date = '2099-10-09';
      const a = {name:'Первый клиент',phone:'87771234567',service:'Женская стрижка',masterId:'master-1',date,time:'16:00',status:'confirmed',source:'site'};
      const b = {...a,name:'Второй клиент',time:'16:30'};
      const c = {...a,name:'У другого мастера',masterId:'master-2'};
      [a,b,c].forEach((data,i) => {
        const id = 'booking-'+i;
        store.set('bookings/'+id, data);
        store.set('availability/'+data.masterId+'_'+date+'_'+data.time, {masterId:data.masterId,date,time:data.time,bookingId:id});
      });
      let onBookings;
      const snapshot = ref => ({id:ref.id, exists:store.has(ref.path),data:()=>({...store.get(ref.path)})});
      const emit = () => onBookings && onBookings({docs:Array.from(store.keys()).filter(k=>k.startsWith('bookings/')).map(path=>snapshot({path,id:path.split('/')[1]})),docChanges:()=>[]});
      const db = {
        collection: name => ({doc:id=>({id:id||'new-booking',path:name+'/'+(id||'new-booking')}),onSnapshot: next=>{onBookings=next; setTimeout(emit,0); return ()=>{onBookings=null;};}}),
        runTransaction: async fn => {
          const ops = [];
          const tx = {get:async ref=>snapshot(ref),set:(ref,data)=>ops.push(()=>store.set(ref.path,{...data})),delete:ref=>ops.push(()=>store.delete(ref.path))};
          await fn(tx);
          ops.forEach(op=>op()); emit();
        }
      };
      const auth = {onAuthStateChanged: fn=>setTimeout(()=>fn({email:'admin@test.example'}),0),signOut:()=>Promise.resolve()};
      window.firebase={apps:[{}],auth:()=>auth,firestore:()=>db};
      window.firebase.firestore.FieldValue={serverTimestamp:()=> 'server-time'};
      window.testStore=store;
      window.testDb=db;
    });
    await page.goto((process.env.SALON_TEST_URL || 'http://127.0.0.1:8000')+'/admin.html');
    await page.locator('#app').waitFor({state:'visible'});
    await page.waitForFunction(()=>document.querySelectorAll('#list .card').length===3);
    await page.locator('#schedule-date').fill('2099-10-09');
    assert.equal(await page.locator('#list .warn').count(), 0);
    await page.locator('#schedule-slots button').filter({hasText:'16:00'}).click();
    await page.locator('#editor').waitFor({state:'visible'});
    assert.equal(await page.locator('#e-master').inputValue(),'master-1');
    assert.equal(await page.locator('#e-time option[value="16:30"]').evaluate(o=>o.disabled),true);
    await page.locator('#e-time').selectOption('17:00');
    await page.locator('#editor-save').click();
    await page.locator('#editor').waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>window.testStore.has('availability/master-1_2099-10-09_16:00')),false);
    assert.equal(await page.evaluate(()=>window.testStore.get('availability/master-1_2099-10-09_17:00').bookingId),'booking-0');
    const card = page.locator('#list .card').filter({hasText:'Первый клиент'});
    await card.getByRole('button',{name:'Отменить',exact:true}).click();
    await page.waitForFunction(()=>window.testStore.get('bookings/booking-0').status==='cancelled');
    assert.equal(await page.evaluate(()=>window.testStore.has('availability/master-1_2099-10-09_17:00')),false);
    await page.locator('#chips button').filter({hasText:'Все'}).click();
    // Reoccupation before restoration must be detected from current DB state.
    await page.evaluate(()=>window.testStore.set('availability/master-1_2099-10-09_17:00',{bookingId:'someone-else'}));
    await card.getByRole('button',{name:'Вернуть в подтверждённые',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('у мастера уже занято'));
    assert.equal(await page.evaluate(()=>window.testStore.get('bookings/booking-0').status),'cancelled');
    // A stale status action reads the current booking after a different admin moved it.
    await page.evaluate(async () => {
      window.testStore.delete('availability/master-1_2099-10-09_17:00');
      await window.SalonSchedule.saveAdmin(window.testDb,'booking-0',{masterId:'master-2',time:'18:00',status:'confirmed'},false);
      await window.SalonSchedule.saveAdmin(window.testDb,'booking-0',{status:'cancelled'},false);
    });
    assert.equal(await page.evaluate(()=>window.testStore.has('availability/master-2_2099-10-09_18:00')),false);
    await page.locator('#schedule-master').selectOption('master-3');
    await page.locator('#schedule-slots button').filter({hasText:'15:00'}).click();
    await page.locator('#e-service').selectOption('Мужская стрижка');
    await page.locator('#e-name').fill('Новый клиент');
    await page.locator('#e-phone').fill('87771234567');
    await page.locator('#editor-save').click();
    await page.locator('#editor').waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>window.testStore.get('availability/master-3_2099-10-09_15:00').bookingId),'new-booking');
    await page.evaluate(async()=>window.SalonSchedule.saveAdmin(window.testDb,'new-booking',null,true));
    assert.equal(await page.evaluate(()=>window.testStore.has('availability/master-3_2099-10-09_15:00')),false);
    assert.deepEqual(errors, []);
    console.log('PASS: admin schedule, master separation, move, cancel, blocked restore, current-state reads, add and delete');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
