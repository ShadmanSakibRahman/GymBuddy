'use strict';
const assert=require('assert');
const {loadApp}=require('./harness');
const HTML=process.argv[2]||require('path').resolve(__dirname,'../index.html');
let passed=0,failed=0;
function test(name,fn){try{fn();passed++;console.log('  ok   '+name)}catch(e){failed++;console.log('  FAIL '+name+'\n       '+String(e.message||e).split('\n').slice(0,12).join('\n       '))}}
function countEntries(html){return (html.match(/class="h-entry"/g)||[]).length}
function bootGuest(app){app.run(`state=loadLocal();initSession();render();`)}
function mkSession(over){return Object.assign({date:'2026-10-20T10:00:00.000Z',cycleDay:1,cycleCount:1,dayName:'Push A',exercises:[
  {name:'Bench Press',targetSets:4,targetReps:'6-8',rest:'150s',startWeight:57,originalWeight:57,unit:'kg',progression:'',sets:[{weight:'60',reps:'8'},{weight:'60',reps:'8'},{weight:'60',reps:'7'},{weight:'60',reps:'6'}],completed:true},
  {name:'Incline Dumbbell Press',targetSets:3,targetReps:'8-10',rest:'100s',startWeight:17,originalWeight:17,unit:'kg',progression:'',sets:[{weight:'',reps:''},{weight:'',reps:''},{weight:'',reps:''}],completed:false}
]},over)}
// Simulate a signed-in user: fire onAuthStateChanged, then deliver a Firebase snapshot.
function signIn(app,uid,remote){
  app.sandbox.__fireAuth({uid,displayName:'Test User',email:'t@example.com',photoURL:null});
  app.sandbox.__fireValue(remote);
}

console.log('Testing: '+HTML);

test('legacy data: archived sessions with checkmarks become logged, active session stays in progress',()=>{
  const app=loadApp(HTML);
  // old-format localStorage: no `logged` flags anywhere
  const active='2026-10-27_C1_D1';
  const legacy={currentCycleDay:1,cycleCount:1,todaySession:active,customWorkouts:{},_pplMigrated:true,sessions:{
    [active]:mkSession({date:new Date().toISOString()}),                      // in-progress (auto-ticked, never logged)
    ['2026-10-20_C1_D1_1760000000000']:mkSession({}),                       // archived copy from old code → was shown in history
    ['2026-10-13_C1_D1']:mkSession({date:'2026-10-13T10:00:00.000Z'}),     // genuinely logged via button in old code
    ['2026-10-06_C1_D1']:mkSession({date:'2026-10-06T10:00:00.000Z',exercises:[{name:'Bench Press',unit:'kg',sets:[{weight:'50',reps:''}],completed:false}]}) // partial, never shown before
  }};
  app.sandbox.__store.set('gb_data',JSON.stringify(legacy));
  app.run(`setStorageKey('gb_data_guest')`); // adoption of the pre-per-account key
  bootGuest(app);
  const s=app.get('state.sessions');
  assert.strictEqual(app.get('state.todaySession'),active);
  assert.strictEqual(s[active].logged,false,'active session not logged');
  assert.strictEqual(s[active].exercises[0].sets[0].weight,'60','active data kept');
  assert.strictEqual(s['2026-10-20_C1_D1_1760000000000'].logged,true,'archived copy logged');
  assert.strictEqual(s['2026-10-13_C1_D1'].logged,true,'old logged session logged');
  assert.strictEqual(s['2026-10-06_C1_D1'].logged,false,'partial unlogged session stays unlogged');
  app.run('renderHistory()');
  assert.strictEqual(countEntries(app.get(`document.getElementById('historyTab').innerHTML`)),2,'history shows exactly the two previously-visible sessions');
  assert.strictEqual(app.sandbox.__store.get('gb_data'),undefined,'legacy key removed after adoption');
  // last-session placeholder comes from the most recent LOGGED one
  const ls=app.get('lastSession(1)');
  assert.strictEqual(ls.date,'2026-10-20T10:00:00.000Z');
});

test('mergeSessions: logged copy beats unlogged, more typed sets beats fewer',()=>{
  const app=loadApp(HTML);
  const k='2026-10-27_C1_D1';
  const local={[k]:mkSession({logged:false})};
  const remote={[k]:mkSession({logged:true,exercises:[{name:'Bench Press',unit:'kg',sets:[{weight:'1',reps:'1'}],completed:true}]})};
  app.run(`globalThis.__m=mergeSessions(${JSON.stringify(local)},${JSON.stringify(remote)})`);
  assert.strictEqual(app.get('__m["'+k+'"].logged'),true,'logged remote wins over richer unlogged local');
  const local2={[k]:mkSession({logged:false})};
  const remote2={[k]:mkSession({logged:false,exercises:[{name:'Bench Press',unit:'kg',sets:[{weight:'1',reps:'1'}],completed:true}]})};
  app.run(`globalThis.__m=mergeSessions(${JSON.stringify(local2)},${JSON.stringify(remote2)})`);
  assert.strictEqual(app.get('__m["'+k+'"].exercises[0].sets.length'),4,'local with more typed sets wins');
  // a session only on one side is kept
  app.run(`globalThis.__m=mergeSessions({a:${JSON.stringify(mkSession({}))}},{b:${JSON.stringify(mkSession({}))}})`);
  assert.deepStrictEqual(Object.keys(app.get('__m')).sort(),['a','b']);
});

test('signed-in: offline-typed numbers survive initial cloud merge; cloud write has no undefined and is echo-skipped',()=>{
  const app=loadApp(HTML);
  app.sandbox.__fireAuth({uid:'u1',displayName:'T',email:'t@e.com',photoURL:null});
  // user types before the first snapshot arrives
  app.run(`(function(){const s=state.sessions[state.todaySession];s.exercises[0].sets[0].weight='62.5';s.exercises[0].sets[0].reps='8';saveState();})()`);
  assert.strictEqual(app.sandbox.__fbWrites.length,0,'no cloud write before first snapshot');
  const key=app.get('state.todaySession');
  // cloud has an older logged session + different cycle position
  const remote={currentCycleDay:1,cycleCount:1,todaySession:null,customWorkouts:{},_pplMigrated:true,sessions:{'2026-10-13_C1_D1':mkSession({date:'2026-10-13T10:00:00.000Z',logged:true})}};
  app.sandbox.__fireValue(remote);
  assert.strictEqual(app.get('state.todaySession'),key,'same active key after merge');
  assert.strictEqual(app.get('state.sessions[state.todaySession].exercises[0].sets[0].weight'),'62.5','typed data kept');
  assert.strictEqual(app.sandbox.__fbWrites.length,1,'merged state pushed once');
  const w=app.sandbox.__fbWrites[0];
  assert.ok(w.sessions['2026-10-13_C1_D1'].logged,'cloud session kept');
  assert.ok(w.sessions[key],'local session pushed');
  assert.ok(!JSON.stringify(w).includes('undefined'));
  // the stub echoed that write back synchronously; it must have been skipped, not processed
  assert.strictEqual(app.get('_writeCount'),1);
  assert.strictEqual(app.get('_listenCount'),1,'echo consumed');
  // a later local write + echo also leaves state untouched
  app.run(`state.sessions[state.todaySession].exercises[0].sets[1].reps='7';saveState(true)`);
  assert.strictEqual(app.get('_listenCount'),2,'second echo consumed');
  assert.strictEqual(app.get('state.sessions[state.todaySession].exercises[0].sets[1].reps'),'7','local state untouched');
});

test('signed-in: another device logs the session → this device starts the next day fresh, nothing lost',()=>{
  const app=loadApp(HTML);
  signIn(app,'u1',{currentCycleDay:1,cycleCount:1,todaySession:null,customWorkouts:{},_pplMigrated:true,sessions:{}});
  const key=app.get('state.todaySession');
  app.sandbox.__fbWrites.length=0;
  // other device: same session, logged, day advanced
  const other=JSON.parse(JSON.stringify(app.get('state')));
  other.sessions[key].exercises[0].sets[0].weight='70';other.sessions[key].exercises[0].sets[0].reps='5';other.sessions[key].exercises[0].completed=true;other.sessions[key].logged=true;
  other.currentCycleDay=2;
  app.sandbox.__fireValue(other);
  assert.strictEqual(app.get('state.currentCycleDay'),2);
  assert.strictEqual(app.get('state.sessions["'+key+'"].logged'),true,'logged copy kept');
  assert.notStrictEqual(app.get('state.todaySession'),key,'new active session');
  assert.strictEqual(app.get('state.sessions[state.todaySession].cycleDay'),2);
});

test('signed-in: remote update does not clobber a richer local in-progress session',()=>{
  const app=loadApp(HTML);
  signIn(app,'u1',{currentCycleDay:1,cycleCount:1,todaySession:null,customWorkouts:{},_pplMigrated:true,sessions:{}});
  const key=app.get('state.todaySession');
  app.run(`(function(){const s=state.sessions[state.todaySession];s.exercises[0].sets.forEach(x=>{x.weight='60';x.reps='8'});s.exercises[0].completed=true;saveState(true);})()`);
  const remote=JSON.parse(JSON.stringify(app.get('state')));
  remote.sessions[key].exercises[0].sets.forEach(x=>{x.weight='';x.reps=''});remote.sessions[key].exercises[0].completed=false;
  assert.strictEqual(app.get('_listenCount'),app.get('_writeCount'),'no pending echo');
  app.sandbox.__fireValue(remote); // genuine remote update with LESS data
  assert.strictEqual(app.get('state.sessions[state.todaySession].exercises[0].sets[0].weight'),'60','local richer session kept');
  assert.strictEqual(app.get('state.sessions[state.todaySession].exercises[0].completed'),true);
});

test('storage is per account: guest and user data do not mix; sign-out shows login',()=>{
  const app=loadApp(HTML);
  app.run(`document.getElementById('guestBtn').dispatch('click')`);
  app.run(`(function(){state.sessions[state.todaySession].exercises[0].sets[0].weight='11';saveState();})()`);
  // the guest write is still pending (coalesced); switching account must flush it under the GUEST key first
  signIn(app,'userA',{currentCycleDay:3,cycleCount:2,todaySession:null,customWorkouts:{},_pplMigrated:true,sessions:{}});
  assert.ok(app.sandbox.__store.has('gb_data_guest'),'pending guest write flushed under guest key');
  assert.ok(app.sandbox.__store.get('gb_data_guest').includes('"11"'),'guest numbers landed in guest storage');
  assert.strictEqual(app.get('state.currentCycleDay'),3,'user sees own cloud state');
  assert.ok(app.sandbox.__store.has('gb_data_userA'));
  const guestData=JSON.parse(app.sandbox.__store.get('gb_data_guest'));
  assert.strictEqual(guestData.currentCycleDay,1,'guest data untouched');
  assert.ok(!JSON.stringify(app.get('state')).includes('"11"'),'guest numbers did not leak into the account');
  app.sandbox.__fireAuth(null);
  assert.strictEqual(app.get(`document.getElementById('mainApp').classList.contains('on')`),false,'app hidden on sign-out');
  assert.strictEqual(app.get('userRef'),null);
});

test('guest: initial "no user" auth event does not kick the guest out',()=>{
  const app=loadApp(HTML);
  app.run(`document.getElementById('guestBtn').dispatch('click')`);
  app.sandbox.__fireAuth(null);
  assert.strictEqual(app.get(`document.getElementById('mainApp').classList.contains('on')`),true);
});

test('logging day 1 then revisiting day 1 the same date gives a fresh session; the logged one is untouched',()=>{
  const app=loadApp(HTML);bootGuest(app);
  const key=app.get('state.todaySession');
  app.run(`(function(){const s=state.sessions[state.todaySession];s.exercises[0].sets[0].weight='60';s.exercises[0].sets[0].reps='8';s.exercises[0].completed=true;})()`);
  app.run(`document.getElementById('saveBtn').dispatch('click');document.getElementById('modalConfirm').dispatch('click');`);
  app.run(`switchDay(1)`);
  const k2=app.get('state.todaySession');
  assert.notStrictEqual(k2,key);
  assert.ok(k2.startsWith(key),'new key derived from base key: '+k2);
  assert.strictEqual(app.get('state.sessions["'+key+'"].logged'),true);
  assert.strictEqual(app.get('state.sessions["'+key+'"].exercises[0].sets[0].weight'),'60');
  assert.strictEqual(app.get('state.sessions[state.todaySession].exercises[0].sets[0].weight'),'','fresh');
  // placeholder for the new session comes from the logged one
  const html=app.get(`document.getElementById('exerciseList').innerHTML`);
  assert.ok(html.includes('placeholder="60"'),'last-session weight used as placeholder');
});

test('session started yesterday is still the active one today (midnight crossing)',()=>{
  const app=loadApp(HTML);
  const key='2026-10-26_C1_D1';
  const data={currentCycleDay:1,cycleCount:1,todaySession:key,customWorkouts:{},_pplMigrated:true,sessions:{[key]:mkSession({date:'2026-10-26T22:30:00.000Z',logged:false})}};
  app.sandbox.__store.set('gb_data_guest',JSON.stringify(data));
  bootGuest(app);
  assert.strictEqual(app.get('state.todaySession'),key);
  assert.strictEqual(app.get('state.sessions[state.todaySession].exercises[0].sets[0].weight'),'60');
  assert.strictEqual(Object.keys(app.get('state.sessions')).length,1,'no duplicate session created');
});

test('reset clears today only; empty leftover sessions are pruned',()=>{
  const app=loadApp(HTML);bootGuest(app);
  const key=app.get('state.todaySession');
  app.run(`state.sessions[state.todaySession].exercises[0].sets[0].weight='60'`);
  app.run(`document.getElementById('resetBtn').dispatch('click');document.getElementById('modalConfirm').dispatch('click');`);
  assert.strictEqual(app.get('state.sessions[state.todaySession].exercises[0].sets[0].weight'),'');
  assert.strictEqual(Object.keys(app.get('state.sessions')).length,1);
  // switch away from an empty day and back: no accumulation
  app.run('switchDay(2);switchDay(3);switchDay(1)');
  assert.strictEqual(Object.keys(app.get('state.sessions')).length,1,'empty sessions pruned');
});

test('editing the plan keeps typed numbers by exercise name and applies set-count changes',()=>{
  const app=loadApp(HTML);bootGuest(app);
  app.run(`(function(){const s=state.sessions[state.todaySession];s.exercises[0].sets[0].weight='60';s.exercises[0].sets[0].reps='8';s.exercises[1].sets[0].weight='20';})()`);
  app.run(`(function(){const l=getWorkouts(1).map(x=>Object.assign({},x));l[0].s=2;l.splice(1,1);l.push({n:'Dips',s:3,r:'8-12',rest:'90s',w:0,u:'BW',p:''});state.customWorkouts[1]=l;initSession();saveState(true);render();})()`);
  const s=app.get('state.sessions[state.todaySession]');
  assert.strictEqual(s.exercises[0].name,'Bench Press');
  assert.strictEqual(s.exercises[0].sets.length,2,'set count reduced');
  assert.strictEqual(s.exercises[0].sets[0].weight,'60','data kept');
  assert.ok(!s.exercises.some(e=>e.name==='Incline Dumbbell Press'),'removed exercise gone');
  assert.strictEqual(s.exercises[s.exercises.length-1].name,'Dips');
  assert.strictEqual(s.exercises[s.exercises.length-1].sets.length,3);
});

test('import: text dates are keyed by local date (no timezone shift) and imported sessions are logged',()=>{
  const app=loadApp(HTML);bootGuest(app);
  const d=app.get(`parseRowDate('10/27/2026')`);
  assert.strictEqual(app.get(`fmtDate(parseRowDate('10/27/2026'))`),'2026-10-27');
  assert.strictEqual(app.get(`parseRowDate('')`),null);
  assert.strictEqual(app.get(`parseRowDate('garbage')`),null);
});

test('auto-fill on manual tick only uses plain numeric placeholders',()=>{
  const app=loadApp(HTML);
  assert.strictEqual(app.get(`NUM_RE.test('57')`),true);
  assert.strictEqual(app.get(`NUM_RE.test('62.5')`),true);
  assert.strictEqual(app.get(`NUM_RE.test('6-8')`),false);
  assert.strictEqual(app.get(`NUM_RE.test('AMRAP')`),false);
  assert.strictEqual(app.get(`NUM_RE.test('BW')`),false);
});

test('validateSession flags bad values and empty completed exercises',()=>{
  const app=loadApp(HTML);bootGuest(app);
  app.run(`(function(){const s=state.sessions[state.todaySession];s.exercises[0].completed=true;})()`);
  assert.ok(app.get('validateSession(state.sessions[state.todaySession])')[0].includes('add data'));
  app.run(`(function(){const s=state.sessions[state.todaySession];s.exercises[0].sets[0].weight='1500';s.exercises[0].sets[0].reps='8';})()`);
  assert.ok(app.get('validateSession(state.sessions[state.todaySession])')[0].includes('invalid weight'));
  app.run(`(function(){const s=state.sessions[state.todaySession];s.exercises[0].sets[0].weight='60';})()`);
  assert.strictEqual(app.get('validateSession(state.sessions[state.todaySession]).length'),0);
});

test('esc() escapes HTML and tolerates numbers/null',()=>{
  const app=loadApp(HTML);
  assert.strictEqual(app.get(`esc('<b>"x"&\\'y\\'</b>')`),'&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/b&gt;');
  assert.strictEqual(app.get('esc(57)'),'57');
  assert.strictEqual(app.get('esc(null)'),'');
  assert.strictEqual(app.get('esc(undefined)'),'');
});

test('corrupt/odd stored data normalizes without crashing',()=>{
  const app=loadApp(HTML);
  app.sandbox.__store.set('gb_data_guest','{"currentCycleDay":99,"cycleCount":"x","sessions":{"bad":null,"k":{"exercises":"nope"}},"customWorkouts":[],"todaySession":5}');
  bootGuest(app);
  assert.strictEqual(app.get('state.currentCycleDay'),1);
  assert.strictEqual(app.get('state.cycleCount'),1);
  assert.ok(!('bad' in app.get('state.sessions')));
  assert.ok(app.get('state.todaySession'));
  app.sandbox.__store.set('gb_data_guest','not json');
  bootGuest(app);
  assert.strictEqual(app.get('state.currentCycleDay'),1);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed?1:0);
