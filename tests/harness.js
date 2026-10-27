// Minimal DOM/Firebase/localStorage stubs so the GymBuddy inline script can run in Node.
'use strict';
const fs = require('fs');
const vm = require('vm');

function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}

class FakeEl {
  constructor(id){
    this.id=id||'';this._text='';this.innerHTML='';this.style={};this.dataset={};this.value='';this.placeholder='';
    this.className='';this.title='';this.children=[];this.listeners={};this.parentElement=null;this.scrollTop=0;this.scrollHeight=0;
    const self=this;
    this.classList={
      _s:new Set(),
      add(c){this._s.add(c)},remove(c){this._s.delete(c)},
      toggle(c,f){if(f===undefined)f=!this._s.has(c);if(f)this._s.add(c);else this._s.delete(c);return f},
      contains(c){return this._s.has(c)}
    };
  }
  get textContent(){return this._text}
  set textContent(v){this._text=String(v);this.innerHTML=escHtml(v)}
  addEventListener(t,fn){(this.listeners[t]=this.listeners[t]||[]).push(fn)}
  removeEventListener(){}
  dispatch(t,ev){(this.listeners[t]||[]).forEach(fn=>fn(ev||{}))}
  querySelectorAll(){return []}
  querySelector(){return new FakeEl()}
  matches(){return false}
  setAttribute(k,v){this[k]=v}
  getAttribute(k){return this[k]}
  appendChild(c){this.children.push(c);c.parentElement=this;return c}
  replaceWith(){}
  closest(){return null}
  remove(){}
  click(){this.dispatch('click')}
  scrollIntoView(){}
  focus(){}
}

function makeSandbox(){
  const els={};
  const store=new Map();
  const docListeners={};
  const document={
    readyState:'complete',
    getElementById(id){if(!els[id])els[id]=new FakeEl(id);return els[id]},
    querySelectorAll(){return []},
    querySelector(){return null},
    createElement(tag){return new FakeEl()},
    createElementNS(ns,tag){return new FakeEl()},
    addEventListener(t,fn){(docListeners[t]=docListeners[t]||[]).push(fn)},
    removeEventListener(){},
    activeElement:null,
    visibilityState:'visible',
    body:new FakeEl('body'),
    head:new FakeEl('head'),
  };
  const localStorage={
    getItem(k){return store.has(k)?store.get(k):null},
    setItem(k,v){store.set(k,String(v))},
    removeItem(k){store.delete(k)},
    clear(){store.clear()},
    get length(){return store.size},
    key(i){return [...store.keys()][i]},
  };
  const fbWrites=[];
  let valueCb=null,errCb=null;
  const ref={
    on(ev,cb,err){valueCb=cb;errCb=err;return cb},
    off(){valueCb=null},
    // Like the real SDK: a local write immediately raises a 'value' event (optimistic echo) before the server acks.
    set(v){const copy=JSON.parse(JSON.stringify(v));fbWrites.push(copy);if(valueCb)valueCb({val(){return JSON.parse(JSON.stringify(copy))}});return Promise.resolve()},
  };
  let authCb=null;
  const authObj={
    getRedirectResult(){return Promise.resolve()},
    onAuthStateChanged(cb){authCb=cb},
    signInWithPopup(){return Promise.resolve()},
    signInWithRedirect(){},
    signOut(){return Promise.resolve()},
    createUserWithEmailAndPassword(){return Promise.resolve()},
    signInWithEmailAndPassword(){return Promise.resolve()},
  };
  const firebase={
    initializeApp(){},
    auth(){return authObj},
    database(){return {ref(){return ref}}},
  };
  firebase.auth.GoogleAuthProvider=class{};
  const win={
    addEventListener(t,fn){(docListeners['win:'+t]=docListeners['win:'+t]||[]).push(fn)},
    removeEventListener(){},
    location:{reload(){}},
  };
  const sandbox={
    document,localStorage,firebase,
    window:win,navigator:{userAgent:'node'},
    console,setTimeout,clearTimeout,Promise,Date,Math,JSON,Object,Array,String,Number,parseInt,parseFloat,isNaN,Set,Map,RegExp,Error,
    XLSX:undefined,
    __els:els,__store:store,__fbWrites:fbWrites,
    __fireValue(d){if(valueCb)valueCb({val(){return d}})},
    __fireAuth(u){if(authCb)authCb(u)},
    __docDispatch(t,ev){(docListeners[t]||[]).forEach(fn=>fn(ev||{}))},
    __winDispatch(t,ev){(docListeners['win:'+t]||[]).forEach(fn=>fn(ev||{}))},
  };
  sandbox.globalThis=sandbox;sandbox.self=sandbox;
  return sandbox;
}

function loadApp(htmlPath){
  const html=fs.readFileSync(htmlPath,'utf8');
  // last inline <script> block is the app
  const blocks=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if(!blocks.length)throw new Error('no inline script found');
  const src=blocks[blocks.length-1][1];
  const sandbox=makeSandbox();
  const ctx=vm.createContext(sandbox);
  vm.runInContext(src,ctx,{filename:'index.html'});
  // accessor into the script's top-level lexical scope
  const get=(expr)=>vm.runInContext(expr,ctx);
  const run=(code)=>vm.runInContext(code,ctx);
  return {ctx,sandbox,get,run};
}

module.exports={loadApp,FakeEl};
