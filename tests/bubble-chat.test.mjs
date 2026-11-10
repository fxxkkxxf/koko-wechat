import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../lib/store.mjs';
import {ChatController} from '../lib/chat.mjs';
import {CHAT_BUBBLE_STYLE} from '../lib/reply-style.mjs';
const text='今天忙了一天吧\n先坐下来歇歇\n我陪你聊一会';
const confirmed=args=>({status:'confirmed',parts:args.messages.map((text,index)=>({text,index,status:'confirmed'}))});
function fixture(t,{reply=text,deliver=confirmed,group=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'koko-bubbles-')),store=new Store(dir,'原角色');
 Object.assign(store.data.settings,{enabled:true,accountId:'small',chatId:'friend',groups:group?[{chatId:'miners',name:'群',enabled:true,mode:'addressed',aliases:['可可']}]:[]});
 const calls=[],modelCalls=[],memoryCalls=[],resets=[];
 const bridge={call:async(method,args)=>{calls.push({method,args});if(method==='send_batch')return deliver(args);if(method==='send')return {status:'confirmed'};return {};}};
 const model={resetSessions:key=>resets.push(key),reply:async args=>{modelCalls.push(args);return {should_reply:true,reply,remember:['喜欢蓝色']};}};
 const memory={context:()=>({history:[],memory:[],summary:'',contextVersion:'1'}),remember:x=>memoryCalls.push(x),maintain:async()=>{}};
 const chat=new ChatController({store,bridge,model,memory,delay:3600000});
 const incoming=(id='a')=>({accountId:'small',chatId:group?'miners':'friend',chatType:group?'group':'private',senderId:'alice',senderName:'甲',id,text:'可可，今天有点累'});
 const begin=()=>{chat.receive(incoming());const job=[...chat.jobs.values()][0];assert(job);clearTimeout(job.timer);return chat.run(job);};
 t.after(()=>{for(const j of chat.jobs.values())clearTimeout(j.timer);fs.rmSync(dir,{recursive:true,force:true});});return {store,calls,modelCalls,memoryCalls,resets,chat,incoming,begin};
}
test('short replies become separate confirmed bubbles in order, without new model calls',async t=>{const f=fixture(t);await f.begin();assert.equal(f.modelCalls.length,1);assert(f.modelCalls[0].persona.includes(CHAT_BUBBLE_STYLE));const batch=f.calls.find(x=>x.method==='send_batch');assert.deepEqual(batch.args.messages,text.split('\n'));assert.deepEqual(f.store.history('small:friend').filter(x=>x.role==='assistant').map(x=>x.content),text.split('\n'));assert.equal(f.memoryCalls.length,1);});

test('normal and split replies default to background without changing their recipient or adding sends',async t=>{
 for(const reply of ['你好呀',text]){
  const f=fixture(t,{reply});await f.begin();const sends=f.calls.filter(x=>['send','send_batch'].includes(x.method));
  assert.equal(sends.length,1);assert.equal(sends[0].args.sendMode,'background');assert.equal(sends[0].args.textEncoding,'auto');
  assert.equal(sends[0].args.accountId,'small');assert.equal(sends[0].args.chatId,'friend');
 }
});

test('explicit foreground compatibility and encoding choice are passed once with the same batch',async t=>{
 const f=fixture(t);Object.assign(f.store.data.settings,{textSendMode:'foreground',textEncoding:'gbk'});await f.begin();
 const sends=f.calls.filter(x=>x.method==='send_batch');assert.equal(sends.length,1);
 assert.equal(sends[0].args.sendMode,'foreground');assert.equal(sends[0].args.textEncoding,'gbk');assert.deepEqual(sends[0].args.messages,text.split('\n'));
});
test('a partial batch records only confirmed words as spoken and resets the unspoken model draft',async t=>{const f=fixture(t,{deliver:args=>({status:'partial',parts:[{index:0,text:args.messages[0],status:'confirmed'},{index:1,text:args.messages[1],status:'unconfirmed'}]})});await f.begin();assert.deepEqual(f.store.history('small:friend').filter(x=>x.role==='assistant').map(x=>x.content),['今天忙了一天吧']);assert.equal(f.store.data.settings.enabled,true);assert.equal(f.chat.recovery.get('small:friend').kind,'review');assert.equal(f.memoryCalls.length,0);assert.equal(f.calls.filter(x=>x.method==='send_batch').length,1);assert.deepEqual(f.resets,['small:friend']);});
test('a blocked batch preserves the group switch and temporarily waits',async t=>{const f=fixture(t,{group:true,deliver:args=>({status:'partial',parts:[{index:0,text:args.messages[0],status:'confirmed'},{index:1,text:args.messages[1],status:'blocked'}]})});await f.begin();assert.equal(f.store.data.settings.enabled,true);assert.equal(f.store.data.settings.groups[0].enabled,true);assert.equal(f.chat.recovery.get('small:miners').kind,'waiting');assert.equal(f.calls.some(x=>x.method==='stop'),false);});
test('new private messages cancel the remaining old bubbles and reset the draft before enqueue',async t=>{let finish;const f=fixture(t,{deliver:()=>new Promise(r=>finish=r)});const running=f.begin();while(!finish)await new Promise(r=>setImmediate(r));f.chat.receive({...f.incoming('b'),text:'先等等，我有补充'});assert(f.calls.some(x=>x.method==='cancel_send'));assert.deepEqual(f.resets,['small:friend']);finish({status:'cancelled',cancelled:true,parts:[{index:0,text:'今天忙了一天吧',status:'confirmed'}]});await running;assert.equal(f.store.data.settings.enabled,true);assert.deepEqual(f.store.history('small:friend').filter(x=>x.role==='assistant').map(x=>x.content),['今天忙了一天吧']);assert.equal(f.chat.jobs.size,1);assert.equal(f.memoryCalls.length,0);assert.equal(f.resets.length,1);});
test('pause stops a batch without losing the prefix that was already confirmed',async t=>{let finish;const f=fixture(t,{deliver:()=>new Promise(r=>finish=r)});const running=f.begin();while(!finish)await new Promise(r=>setImmediate(r));await f.chat.pause();finish({status:'cancelled',cancelled:true,parts:[{index:0,text:'今天忙了一天吧',status:'confirmed'}]});await running;assert.equal(f.store.data.settings.enabled,false);assert.equal(f.store.history('small:friend').filter(x=>x.role==='assistant').length,1);});
test('necessary long explanations remain one message and local preview shows actual separate bubbles',async t=>{const long='这是一段需要完整解释的内容。'.repeat(20);const f=fixture(t,{reply:long});await f.begin();assert.equal(f.calls.find(x=>x.method==='send').args.text,long);const p=fixture(t);await p.chat.test('你好');assert.equal(p.calls.length,0);assert.equal(p.store.data.conversations.filter(x=>x.sessionKey==='local-preview'&&x.role==='assistant').length,3);});
