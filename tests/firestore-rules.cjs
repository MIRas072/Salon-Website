// Run with Firestore emulator (see tests/README.md).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {initializeTestEnvironment, assertSucceeds, assertFails} = require('@firebase/rules-unit-testing');
const firebase = require('firebase/compat/app');
require('firebase/compat/firestore');
// Firestore rejects objects created in another VM realm. Load the browser
// helper in this realm so the SDK sees ordinary JavaScript objects.
global.window = {};
vm.runInThisContext(fs.readFileSync(path.join(__dirname,'../schedule.js'),'utf8'));
const schedule = global.window.SalonSchedule;
delete global.window;
const data = overrides => ({name:'Тест',phone:'87771234567',service:'Женская стрижка',masterId:'master-1',date:'2099-10-09',time:'16:00',status:'new',source:'site',createdAt:firebase.firestore.FieldValue.serverTimestamp(),...overrides});
function rawReserve(db, d, times = [d.time]) {
  const ref = db.collection('bookings').doc();
  const batch = db.batch();
  batch.set(ref,d);
  times.forEach(time => {
    const slot = {masterId:d.masterId,date:d.date,time,bookingId:ref.id};
    batch.set(db.collection('availability').doc(schedule.slotId(slot)),slot);
  });
  return batch.commit();
}
(async () => {
  const env = await initializeTestEnvironment({
    projectId:'demo-salon',
    firestore:{host:'127.0.0.1',port:8080,rules:fs.readFileSync(path.join(__dirname,'../firestore.rules'),'utf8').replace(/request\.auth\.token\.email == "[^"]+"/, 'request.auth.token.email == "admin@test.example"')}
  });
  try {
    const client1 = env.unauthenticatedContext().firestore();
    const client2 = env.unauthenticatedContext().firestore();
    const admin = env.authenticatedContext('admin',{email:'admin@test.example'}).firestore();
    await env.clearFirestore();
    const results = await Promise.allSettled([schedule.reserve(client1,data()),schedule.reserve(client2,data())]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal((await admin.collection('bookings').get()).size,1);
    console.log('PASS: concurrent clients cannot reserve the same window');
    await assertSucceeds(schedule.reserve(client2,data({masterId:'master-2'})));
    const publicSlots = await assertSucceeds(client1.collection('availability').get());
    assert.equal(publicSlots.size,2);
    for (const doc of publicSlots.docs) assert.deepEqual(Object.keys(doc.data()).sort(),['bookingId','date','masterId','time']);
    await assertFails(client1.collection('bookings').get());
    const booked = (await admin.collection('bookings').where('masterId','==','master-1').get()).docs[0];
    await assertFails(client1.collection('bookings').doc(booked.id).get());
    await assertFails(client1.collection('bookings').doc(booked.id).update({status:'cancelled'}));
    await assertFails(client1.collection('availability').doc(schedule.slotId(data())).delete());
    console.log('PASS: public occupancy contains no client details; bookings and changes are private');
    await assertFails(client1.collection('bookings').add(data({time:'17:00'})));
    await assertFails(client1.collection('availability').doc('master-1_2099-10-09_17:00').set({masterId:'master-1',date:'2099-10-09',time:'17:00',bookingId:booked.id}));
    await assertFails(schedule.reserve(client1,data({masterId:'master-2',service:'Свадебный образ',time:'17:00'})));
    await assertFails(schedule.reserve(client1,data({masterId:'master-3',time:'17:00'})));
    await assertFails(schedule.reserve(client1,data({masterId:'unknown',time:'17:00'})));
    await assertFails(rawReserve(client1,data({time:'22:00'})));
    await assertFails(schedule.reserve(client1,data({time:'17:00',status:'confirmed'})));
    await assertFails(schedule.reserve(client1,data({time:'17:00',comment:'x'.repeat(301)})));
    assert.equal((await admin.collection('bookings').get()).size,2);
    console.log('PASS: standalone writes, incompatible services, forged status, invalid masters/time and oversized comments denied');
    await assertFails(admin.collection('bookings').doc(booked.id).update({status:'cancelled'}));
    await assertFails(admin.collection('availability').doc(schedule.slotId(data())).delete());
    await assertSucceeds(schedule.saveAdmin(admin,booked.id,{time:'17:00'},false));
    assert.equal((await client1.collection('availability').doc(schedule.slotId(data())).get()).exists,false);
    await assert.rejects(()=>schedule.saveAdmin(admin,booked.id,{masterId:'master-2',time:'16:00'},false),/занято/);
    await assertSucceeds(schedule.saveAdmin(admin,booked.id,{status:'cancelled'},false));
    assert.equal((await client1.collection('availability').doc('master-1_2099-10-09_17:00').get()).exists,false);
    await assertSucceeds(schedule.reserve(client1,data({time:'17:00'})));
    await assert.rejects(()=>schedule.saveAdmin(admin,booked.id,{status:'confirmed'},false),/занято/);
    await assertSucceeds(schedule.saveAdmin(admin,booked.id,{time:'18:00',status:'confirmed'},false));
    await assertSucceeds(schedule.saveAdmin(admin,booked.id,null,true));
    assert.equal((await client1.collection('availability').doc('master-1_2099-10-09_18:00').get()).exists,false);
    console.log('PASS: move/cancel/delete release slots, partial changes denied, occupied restore blocked');
    // Legacy records can be assigned a master without exposing their details.
    await env.withSecurityRulesDisabled(async context => {
      const legacy=data(); delete legacy.masterId;
      await context.firestore().collection('bookings').doc('legacy').set(legacy);
    });
    await assertSucceeds(schedule.saveAdmin(admin,'legacy',{masterId:'master-3',service:'Мужская стрижка',time:'19:00'},false));
    await assertSucceeds(schedule.saveAdmin(admin,'legacy',{status:'done'},false));
    assert.equal((await client1.collection('availability').doc('master-3_2099-10-09_19:00').get()).exists,false);
    console.log('PASS: legacy migration and completed appointment release');
    await env.clearFirestore();
    const coloring = data({service:'Окрашивание в один тон'});
    const slotRef = time => admin.collection('availability').doc('master-1_2099-10-09_'+time);
    // A forged client may skip normalization or omit the second reservation.
    async function forgedColor(durationMinutes, times) {
      const ref = client1.collection('bookings').doc();
      const batch = client1.batch();
      batch.set(ref,{...coloring,durationMinutes});
      times.forEach(time=>batch.set(client1.collection('availability').doc('master-1_2099-10-09_'+time),
        {masterId:'master-1',date:coloring.date,time,bookingId:ref.id}));
      return batch.commit();
    }
    await assertFails(forgedColor(60,['16:00']));
    await assertFails(forgedColor(30,['16:00','16:30']));
    await assertFails(forgedColor(60,['16:00','17:00']));
    await assert.rejects(()=>schedule.reserve(client1,{...coloring,time:'19:30'}),/20:00/);
    await assertSucceeds(schedule.reserve(client1,data({time:'16:30'})));
    await assertFails(schedule.reserve(client2,coloring));
    assert.equal((await slotRef('16:00').get()).exists,false);
    await env.clearFirestore();
    const overlap = await Promise.allSettled([
      schedule.reserve(client1,coloring),schedule.reserve(client2,data({time:'16:30'}))
    ]);
    assert.equal(overlap.filter(r=>r.status==='fulfilled').length,1);
    assert.equal((await admin.collection('bookings').get()).size,1);
    console.log('PASS: coloring requires a full hour; forged durations, partial reservations, closing overrun and overlapping concurrent bookings blocked');
    await env.clearFirestore();
    await assertSucceeds(schedule.reserve(client1,coloring));
    const colorDoc = (await admin.collection('bookings').get()).docs[0];
    assert.equal(colorDoc.data().durationMinutes,60);
    assert.equal((await slotRef('16:30').get()).data().bookingId,colorDoc.id);
    await assertSucceeds(schedule.saveAdmin(admin,colorDoc.id,{status:'confirmed'},false));
    await assertSucceeds(schedule.saveAdmin(admin,colorDoc.id,{masterId:'master-2',date:'2099-10-10',time:'18:00'},false));
    assert.equal((await slotRef('16:00').get()).exists,false);
    assert.equal((await slotRef('16:30').get()).exists,false);
    await assertSucceeds(schedule.saveAdmin(admin,colorDoc.id,{masterId:'master-1',date:coloring.date,time:'16:00'},false));
    assert.equal((await admin.collection('availability').doc('master-2_2099-10-10_18:30').get()).exists,false);
    await assertFails(schedule.reserve(client2,data({time:'16:30'})));
    await assertFails(schedule.reserve(client2,{...coloring,time:'15:30'}));
    await assertSucceeds(schedule.reserve(client2,data({masterId:'master-2',time:'16:30'})));
    await assertSucceeds(schedule.reserve(client2,data({time:'17:00'})));
    await assert.rejects(()=>schedule.saveAdmin(admin,colorDoc.id,{time:'16:30'},false),/занято/);
    // Releasing only one half must fail even when the admin changes/deletes the booking.
    for (const remaining of ['16:00','16:30']) {
      const batch = admin.batch();
      batch.update(admin.collection('bookings').doc(colorDoc.id),{status:'cancelled'});
      batch.delete(slotRef(remaining === '16:00' ? '16:30' : '16:00'));
      await assertFails(batch.commit());
    }
    const partialDelete = admin.batch();
    partialDelete.delete(admin.collection('bookings').doc(colorDoc.id));
    partialDelete.delete(slotRef('16:00'));
    await assertFails(partialDelete.commit());
    await assertSucceeds(schedule.saveAdmin(admin,colorDoc.id,{time:'15:30'},false));
    assert.equal((await slotRef('16:30').get()).exists,false);
    assert.equal((await slotRef('16:00').get()).data().bookingId,colorDoc.id);
    await assertSucceeds(schedule.saveAdmin(admin,colorDoc.id,{service:'Женская стрижка'},false));
    assert.equal((await slotRef('16:00').get()).exists,false);
    await assertSucceeds(schedule.saveAdmin(admin,colorDoc.id,{service:coloring.service},false));
    await assertSucceeds(schedule.saveAdmin(admin,colorDoc.id,{status:'cancelled'},false));
    assert.equal((await slotRef('15:30').get()).exists,false);
    assert.equal((await slotRef('16:00').get()).exists,false);
    await assertSucceeds(schedule.saveAdmin(admin,colorDoc.id,{time:'19:00',status:'confirmed'},false));
    assert.equal((await slotRef('19:30').get()).data().bookingId,colorDoc.id);
    await assertSucceeds(schedule.saveAdmin(admin,colorDoc.id,null,true));
    assert.equal((await slotRef('19:00').get()).exists,false);
    assert.equal((await slotRef('19:30').get()).exists,false);
    console.log('PASS: both halves occupied; moves sharing a half-hour, service changes, cancel, restore and delete preserve atomic reservations');
    await env.withSecurityRulesDisabled(async context=>{
      const db = context.firestore();
      await db.collection('bookings').doc('old-color').set({...coloring,createdAt:null});
      await db.collection('availability').doc('master-1_2099-10-09_16:00').set({masterId:'master-1',date:coloring.date,time:'16:00',bookingId:'old-color'});
    });
    await assertSucceeds(schedule.reserve(client1,data({time:'16:30'})));
    await assert.rejects(()=>schedule.saveAdmin(admin,'old-color',{},false),/занято/);
    await assertSucceeds(schedule.saveAdmin(admin,'old-color',{time:'18:00'},false));
    assert.equal((await slotRef('16:00').get()).exists,false);
    assert.equal((await slotRef('18:30').get()).data().bookingId,'old-color');
    await assertSucceeds(schedule.saveAdmin(admin,'old-color',{status:'done'},false));
    assert.equal((await slotRef('18:30').get()).exists,false);
    console.log('PASS: old coloring bookings upgrade safely; existing neighbouring reservations cannot be overwritten');
  } finally {await env.cleanup();}
})().catch(error=>{console.error(error);process.exitCode=1;});
