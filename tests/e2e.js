'use strict';
// End-to-end test: drives a real headless Chrome/Edge over the DevTools Protocol against the app.
// usage: node tests/e2e.js [chrome.exe path] [app url]
// With no url, a tiny static server for the repo root is started automatically.
const {spawn}=require('child_process');
const fs=require('fs');const os=require('os');const path=require('path');const assert=require('assert');const http=require('http');

const CANDIDATES=[
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA||'','Google','Chrome','Application','chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser',
];
const CHROME=process.argv[2]||CANDIDATES.find(p=>p&&fs.existsSync(p));
if(!CHROME){console.error('No Chrome/Edge found. Pass the executable path as the first argument.');process.exit(2)}

const ROOT=path.resolve(__dirname,'..');
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript','.jpg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml','.css':'text/css'};
function startServer(){
  return new Promise(res=>{
    const srv=http.createServer((req,resp)=>{
      let p=decodeURIComponent(req.url.split('?')[0]);if(p==='/')p='/index.html';
      const file=path.join(ROOT,p);
      if(!file.startsWith(ROOT)||!fs.existsSync(file)||fs.statSync(file).isDirectory()){resp.writeHead(404);resp.end();return}
      resp.writeHead(200,{'Content-Type':TYPES[path.extname(file)]||'application/octet-stream'});fs.createReadStream(file).pipe(resp);
    });
    srv.listen(0,'127.0.0.1',()=>res(srv));
  });
}

const PORT=9333+Math.floor(Math.random()*1000);
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'gb-e2e-'));
const chrome=spawn(CHROME,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',`--remote-debugging-port=${PORT}`,`--user-data-dir=${profile}`,'--window-size=480,900','about:blank'],{stdio:'ignore'});
let passed=0,failed=0;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function getJson(p){const r=await fetch(`http://127.0.0.1:${PORT}${p}`);return r.json()}
async function waitForChrome(){for(let i=0;i<60;i++){try{return await getJson('/json/version')}catch(e){await sleep(250)}}throw new Error('chrome did not start')}

class CDP{
  constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();this.handlers={};ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.id&&this.pending.has(m.id)){const{res,rej}=this.pending.get(m.id);this.pending.delete(m.id);m.error?rej(new Error(m.error.message)):res(m.result)}else if(m.method){(this.handlers[m.method]||[]).forEach(h=>h(m.params))}}}
  send(method,params={}){return new Promise((res,rej)=>{const id=++this.id;this.pending.set(id,{res,rej});this.ws.send(JSON.stringify({id,method,params}))})}
  on(method,h){(this.handlers[method]=this.handlers[method]||[]).push(h)}
  once(method){return new Promise(r=>{const h=p=>{this.handlers[method]=this.handlers[method].filter(x=>x!==h);r(p)};this.on(method,h)})}
}
const errors=[];
let cdp;
async function evaluate(expr){
  const r=await cdp.send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true});
  if(r.exceptionDetails)throw new Error('page threw: '+(r.exceptionDetails.exception&&r.exceptionDetails.exception.description||r.exceptionDetails.text));
  return r.result.value;
}
async function navigate(url){const load=cdp.once('Page.loadEventFired');await cdp.send('Page.navigate',{url});await load;await sleep(300)}
async function reload(){const load=cdp.once('Page.loadEventFired');await cdp.send('Page.reload');await load;await sleep(300)}
async function test(name,fn){try{await fn();passed++;console.log('  ok   '+name)}catch(e){failed++;console.log('  FAIL '+name+'\n       '+String(e.message||e).split('\n').slice(0,8).join('\n       '))}}
// type into an input like a user: focus, select-all, real key insertion → real 'input' events
async function typeInto(selector,text){
  await evaluate(`(function(){const el=document.querySelector(${JSON.stringify(selector)});el.focus();el.select();return true})()`);
  await cdp.send('Input.insertText',{text});
}
async function enterGuest(){await evaluate(`document.getElementById('guestBtn').click();true`);await sleep(200)}
const weightSel=(i,si)=>`.ex-sets input[data-i="${i}"][data-si="${si}"][data-f="w"]`;
const repsSel=(i,si)=>`.ex-sets input[data-i="${i}"][data-si="${si}"][data-f="r"]`;

let server=null;
(async()=>{
  let URL=process.argv[3];
  if(!URL){server=await startServer();URL=`http://127.0.0.1:${server.address().port}/`}
  await waitForChrome();
  const list=await getJson('/json/list');
  const page=list.find(t=>t.type==='page');
  const ws=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
  cdp=new CDP(ws);
  await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Log.enable');
  cdp.on('Runtime.exceptionThrown',p=>errors.push('exception: '+(p.exceptionDetails.exception&&p.exceptionDetails.exception.description||p.exceptionDetails.text)));
  cdp.on('Runtime.consoleAPICalled',p=>{if(p.type==='error')errors.push('console.error: '+p.args.map(a=>a.value||a.description).join(' '))});
  cdp.on('Log.entryAdded',p=>{if(p.entry.level==='error')errors.push('log: '+p.entry.text+' @ '+(p.entry.url||''))});

  console.log('E2E against '+URL+' using '+CHROME);
  await navigate(URL);

  await test('page loads: login visible, deferred Firebase SDK booted, no errors',async()=>{
    assert.strictEqual(await evaluate(`document.getElementById('loginScreen').classList.contains('out')`),false);
    assert.strictEqual(await evaluate(`typeof firebase`),'object','firebase SDK loaded (needs internet)');
    assert.strictEqual(await evaluate(`auth!==null&&typeof auth.onAuthStateChanged==='function'`),true,'boot() ran after deferred scripts');
    assert.strictEqual(await evaluate(`!!document.querySelector('script[src*="xlsx"]')`),false,'XLSX not loaded up front');
  });

  await test('guest mode renders the workout with inputs',async()=>{
    await evaluate(`localStorage.clear();true`);
    await enterGuest();
    assert.strictEqual(await evaluate(`document.getElementById('mainApp').classList.contains('on')`),true);
    assert.ok(await evaluate(`document.querySelectorAll('.exc').length`)>=5,'exercise cards rendered');
    assert.strictEqual(await evaluate(`document.querySelectorAll('.cd').length`),7,'cycle bar');
    assert.strictEqual(await evaluate(`document.getElementById('dayBanner').textContent.includes('Day 1')`),true);
  });

  await test('typing with real keystrokes stores numbers and auto-ticks when all reps are filled',async()=>{
    const n=await evaluate(`document.querySelectorAll('${repsSel(0,0).replace('[data-si="0"]','')}').length`);
    for(let si=0;si<n;si++){await typeInto(weightSel(0,si),'60');await typeInto(repsSel(0,si),'8')}
    await typeInto(weightSel(1,0),'20'); // partial on exercise 2, no reps
    assert.strictEqual(await evaluate(`document.querySelector('.exc[data-i="0"]').classList.contains('done')`),true,'auto-ticked');
    assert.strictEqual(await evaluate(`document.querySelector('.exc[data-i="1"]').classList.contains('done')`),false);
    assert.strictEqual(await evaluate(`state.sessions[state.todaySession].exercises[0].sets[0].weight`),'60');
    await sleep(250);
    assert.strictEqual(await evaluate(`JSON.parse(localStorage.getItem('gb_data_guest')).sessions[state.todaySession].exercises[0].sets[${n-1}].reps`),'8','persisted within the coalescing window');
  });

  await test('reload immediately after the last keystroke still keeps it (pagehide flush)',async()=>{
    await typeInto(weightSel(2,0),'35');
    await reload();await enterGuest(); // no wait between typing and reload
    assert.strictEqual(await evaluate(`document.querySelector('${weightSel(2,0)}').value`),'35');
  });

  await test('refresh keeps every typed number and the checkmark; nothing was logged',async()=>{
    await reload();await enterGuest();
    assert.strictEqual(await evaluate(`document.querySelector('${weightSel(0,0)}').value`),'60');
    assert.strictEqual(await evaluate(`document.querySelector('${repsSel(0,0)}').value`),'8');
    assert.strictEqual(await evaluate(`document.querySelector('${weightSel(1,0)}').value`),'20');
    assert.strictEqual(await evaluate(`document.querySelector('.exc[data-i="0"]').classList.contains('done')`),true);
    assert.strictEqual(await evaluate(`Object.keys(state.sessions).length`),1,'no archived copy');
    await evaluate(`document.querySelector('.tabs button[data-tab="history"]').click();true`);
    assert.strictEqual(await evaluate(`document.querySelectorAll('.h-entry').length`),0,'history empty');
    assert.strictEqual(await evaluate(`getComputedStyle(document.getElementById('bottomBar')).display`),'none','log button hidden on history tab');
    await evaluate(`document.querySelector('.tabs button[data-tab="workout"]').click();true`);
    assert.strictEqual(await evaluate(`getComputedStyle(document.getElementById('bottomBar')).display`),'block');
  });

  await test('switching day and back keeps the numbers',async()=>{
    await evaluate(`document.querySelector('.cd[data-day="3"]').click();true`);
    assert.strictEqual(await evaluate(`document.getElementById('modal').classList.contains('show')`),true,'confirm shown');
    await evaluate(`document.getElementById('modalConfirm').click();true`);
    assert.strictEqual(await evaluate(`document.getElementById('dayBanner').textContent.includes('Day 3')`),true);
    await evaluate(`document.querySelector('.cd[data-day="1"]').click();true`);
    assert.strictEqual(await evaluate(`document.querySelector('${weightSel(0,0)}').value`),'60');
  });

  await test('LOG SESSION moves it to history and advances the day; survives refresh',async()=>{
    await evaluate(`document.getElementById('saveBtn').click();true`);
    assert.strictEqual(await evaluate(`document.getElementById('modalText').textContent`).then(t=>/Log 1\/\d+ exercises/.test(t)),true);
    await evaluate(`document.getElementById('modalConfirm').click();true`);
    await sleep(100);
    assert.strictEqual(await evaluate(`document.getElementById('dayBanner').textContent.includes('Day 2')`),true);
    assert.strictEqual(await evaluate(`document.getElementById('saveBtn').textContent`),'SESSION LOGGED \u2713');
    await evaluate(`document.querySelector('.tabs button[data-tab="history"]').click();true`);
    assert.strictEqual(await evaluate(`document.querySelectorAll('.h-entry').length`),1);
    assert.ok(await evaluate(`document.querySelector('.h-entry').textContent`).then(t=>t.includes('60x8')));
    await reload();await enterGuest();
    assert.strictEqual(await evaluate(`document.getElementById('dayBanner').textContent.includes('Day 2')`),true);
    assert.strictEqual(await evaluate(`document.querySelector('${weightSel(0,0)}').value`),'','new day starts empty');
    await evaluate(`document.querySelector('.tabs button[data-tab="history"]').click();true`);
    assert.strictEqual(await evaluate(`document.querySelectorAll('.h-entry').length`),1);
    await evaluate(`document.querySelector('.tabs button[data-tab="progress"]').click();true`);
    assert.ok(await evaluate(`document.getElementById('progressTab').textContent`).then(t=>t.includes('Bench Press')));
  });

  await test('manual tick adopts last-session numbers only when they are plain numbers',async()=>{
    await evaluate(`document.querySelector('.tabs button[data-tab="workout"]').click();document.querySelector('.cd[data-day="1"]').click();true`);
    await evaluate(`document.querySelector('.chk[data-i="0"]').click();true`);
    assert.strictEqual(await evaluate(`document.querySelector('${weightSel(0,0)}').value`),'60');
    assert.strictEqual(await evaluate(`document.querySelector('${repsSel(0,0)}').value`),'8');
    await evaluate(`document.querySelector('.chk[data-i="1"]').click();true`); // placeholder reps "8-10" must NOT be adopted
    assert.strictEqual(await evaluate(`document.querySelector('${repsSel(1,0)}').value`),'');
    assert.strictEqual(await evaluate(`state.sessions[state.todaySession].exercises[1].sets[0].reps`),'');
  });

  await test('edit panel: move/add keep typed edits; save applies plan; close with changes asks',async()=>{
    await evaluate(`document.getElementById('editWorkoutBtn').click();true`);
    assert.strictEqual(await evaluate(`document.getElementById('editPanel').classList.contains('open')`),true);
    await typeInto('#editContent .edit-ex[data-i="0"] [data-f="n"]','Paused Bench');
    await evaluate(`document.querySelector('#editContent .edit-ex[data-i="1"] .edit-move-btn[data-dir="up"]').click();true`);
    assert.strictEqual(await evaluate(`document.querySelector('#editContent .edit-ex[data-i="1"] [data-f="n"]').value`),'Paused Bench','rename kept across move');
    await evaluate(`document.getElementById('editAdd').click();true`);
    assert.strictEqual(await evaluate(`document.querySelectorAll('#editContent .edit-ex').length`),8);
    await evaluate(`document.getElementById('editClose').click();true`);
    assert.strictEqual(await evaluate(`document.getElementById('modalTitle').textContent`),'Discard Changes');
    await evaluate(`document.getElementById('modalCancel').click();document.getElementById('editSave').click();true`);
    assert.strictEqual(await evaluate(`document.getElementById('editPanel').classList.contains('open')`),false,'saved and closed');
    assert.strictEqual(await evaluate(`state.sessions[state.todaySession].exercises[1].name`),'Paused Bench');
    assert.strictEqual(await evaluate(`state.sessions[state.todaySession].exercises.length`),8);
    assert.strictEqual(await evaluate(`document.querySelectorAll('.exc').length`),8);
  });

  await test('no JavaScript errors during the whole run',async()=>{assert.deepStrictEqual(errors,[])});

  console.log(`\n${passed} passed, ${failed} failed`);
  ws.close();chrome.kill();if(server)server.close();
  setTimeout(()=>{try{fs.rmSync(profile,{recursive:true,force:true})}catch(e){}process.exit(failed?1:0)},500);
})().catch(e=>{console.error('E2E harness error:',e);chrome.kill();if(server)server.close();process.exit(2)});
