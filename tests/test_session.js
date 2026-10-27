'use strict';
const assert=require('assert');
const path=require('path');
const {loadApp}=require('./harness');

const HTML=process.argv[2]||path.resolve(__dirname,'../index.html');
let passed=0,failed=0;
function test(name,fn){
  try{fn();passed++;console.log('  ok   '+name)}
  catch(e){failed++;console.log('  FAIL '+name+'\n       '+(e.message||e).split('\n').join('\n       '))}
}
function countEntries(html){return (html.match(/class="h-entry"/g)||[]).length}

// Simulate the guest bootstrap: load local state, init today's session, render.
function bootGuest(app){
  app.run(`state=loadLocal();initSession();render();`);
}
// Simulate a page reload in guest mode (fresh script run against the same localStorage).
function reload(app){
  const {loadApp}=require('./harness');
  const fresh=loadApp(HTML);
  // a real reload fires pagehide first (that is what flushes pending local writes), then storage carries over
  app.sandbox.__winDispatch('pagehide');
  for(const [k,v] of app.sandbox.__store)fresh.sandbox.__store.set(k,v);
  bootGuest(fresh);
  return fresh;
}

console.log('Testing: '+HTML);

test('typed numbers + auto-tick survive a reload (not archived, not wiped)',()=>{
  const app=loadApp(HTML);bootGuest(app);
  const key=app.get('state.todaySession');
  assert.ok(key,'todaySession key set');
  // user types weight+reps into every set of exercise 0 → app auto-ticks it
  app.run(`(function(){const s=state.sessions[state.todaySession];s.exercises[0].sets.forEach(x=>{x.weight='57';x.reps='8'});s.exercises[0].completed=true;saveState();})()`);
  const app2=reload(app);
  const key2=app2.get('state.todaySession');
  const sess=app2.get('state.sessions[state.todaySession]');
  assert.strictEqual(key2,key,'same session key after reload (got '+key2+')');
  assert.strictEqual(sess.exercises[0].sets[0].reps,'8','reps still present after reload');
  assert.strictEqual(sess.exercises[0].sets[0].weight,'57','weight still present after reload');
  assert.strictEqual(sess.exercises[0].completed,true,'checkmark state preserved');
});

test('history shows nothing until LOG SESSION is pressed',()=>{
  const app=loadApp(HTML);bootGuest(app);
  app.run(`(function(){const s=state.sessions[state.todaySession];s.exercises[0].sets.forEach(x=>{x.weight='57';x.reps='8'});s.exercises[0].completed=true;saveState();})()`);
  const app2=reload(app);
  app2.run('renderHistory()');
  const html=app2.get(`document.getElementById('historyTab').innerHTML`);
  assert.strictEqual(countEntries(html),0,'no logged entries before manual log');
  // no archived copies either
  const keys=Object.keys(app2.get('state.sessions'));
  assert.strictEqual(keys.length,1,'exactly one session in state, got: '+keys.join(', '));
});

test('manual LOG SESSION moves session to history and advances the day',()=>{
  const app=loadApp(HTML);bootGuest(app);
  app.run(`(function(){const s=state.sessions[state.todaySession];s.exercises[0].sets.forEach(x=>{x.weight='57';x.reps='8'});s.exercises[0].completed=true;saveState();})()`);
  const dayBefore=app.get('state.currentCycleDay');
  // press LOG SESSION and confirm the modal
  app.run(`document.getElementById('saveBtn').dispatch('click');document.getElementById('modalConfirm').dispatch('click');`);
  assert.strictEqual(app.get('state.currentCycleDay'),dayBefore+1,'advanced to next day');
  app.run('renderHistory()');
  const html=app.get(`document.getElementById('historyTab').innerHTML`);
  assert.strictEqual(countEntries(html),1,'one logged entry after manual log');
  // and it still looks the same after a reload
  const app2=reload(app);
  app2.run('renderHistory()');
  assert.strictEqual(countEntries(app2.get(`document.getElementById('historyTab').innerHTML`)),1,'still one entry after reload');
  assert.strictEqual(app2.get('state.currentCycleDay'),dayBefore+1,'day persisted');
  const cur=app2.get('state.sessions[state.todaySession]');
  assert.strictEqual(cur.cycleDay,dayBefore+1,'fresh session is for the new day');
  assert.ok(cur.exercises.every(e=>!e.completed&&e.sets.every(s=>!s.weight&&!s.reps)),'fresh session is empty');
});

test('switching day and back keeps unlogged numbers',()=>{
  const app=loadApp(HTML);bootGuest(app);
  const day=app.get('state.currentCycleDay');
  app.run(`(function(){const s=state.sessions[state.todaySession];s.exercises[1].sets[0].weight='40';s.exercises[1].sets[0].reps='10';saveState();})()`);
  app.run(`state.currentCycleDay=${day===7?1:day+1};initSession();render();`);
  app.run(`state.currentCycleDay=${day};initSession();render();`);
  const s=app.get('state.sessions[state.todaySession]');
  assert.strictEqual(s.cycleDay,day);
  assert.strictEqual(s.exercises[1].sets[0].weight,'40','weight kept after switching away and back');
});

test('"last session" placeholder only comes from logged sessions',()=>{
  const app=loadApp(HTML);bootGuest(app);
  const day=app.get('state.currentCycleDay');
  app.run(`(function(){const s=state.sessions[state.todaySession];s.exercises[0].sets.forEach(x=>{x.weight='99';x.reps='8'});s.exercises[0].completed=true;saveState();})()`);
  const app2=reload(app);
  const ls=app2.get(`lastSession(${day})`);
  assert.strictEqual(ls,null,'unlogged in-progress session must not be treated as last session');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed?1:0);
