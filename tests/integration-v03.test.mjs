import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../lib/store.mjs';
import {MemoryEngine} from '../lib/memory.mjs';
import {ChatController,bindingTargets} from '../lib/chat.mjs';

function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'koko-v03-'));const store=new Store(dir,'PRIVATE');
 Object.assign(store.data.settings,{accountId:'small',chatId:'old',enabled:true,contacts:[{chatId:'old',enabled:false},{chatId:'new',enabled:true,name:'新朋友'}],groups:[{chatId:'miners',name:'矿工群',enabled:true,mode:'addressed',aliases:['可可']}],webSearchEnabled:true});
 const calls=[],sends=[],queries=[];const model={reply:async x=>{calls.push(x);return {should_reply:true,reply:'知道了',remember:['喜欢蓝色']};},resetSessions(){}};
 const memory=new MemoryEngine({store,model});const search={run:async(query)=>{queries.push(query);return {answer:'官方资料',sources:[{title:'官方',url:'https://example.com/official'}]};}};
 const bridge={call:async(method,args)=>{if(method==='send')sends.push(args);return {status:'confirmed'};}};
 const chat=new ChatController({store,model,bridge,memory,search,delay:3600000});
 const run=async()=>{const job=[...chat.jobs.values()][0];assert(job);clearTimeout(job.timer);await chat.run(job);};
 t.after(()=>{for(const j of chat.jobs.values())clearTimeout(j.timer);memory.close();fs.rmSync(dir,{recursive:true,force:true});});return {store,calls,sends,queries,chat,run};
}
test('explicit private selections route new contacts and do not silently retain old primary',async t=>{const f=fixture(t);assert.deepEqual(bindingTargets(f.store.data.settings).map(x=>x.chatId),['new','miners']);f.chat.receive({accountId:'small',chatId:'old',id:'1',text:'你好'});assert.equal(f.chat.jobs.size,0);f.chat.receive({accountId:'small',chatId:'new',id:'2',text:'我喜欢蓝色'});await f.run();assert.equal(f.sends[0].chatId,'new');assert.equal(f.store.data.memory[0].sessionKey,'small:new');assert.equal(f.queries.length,0);});
test('search evidence is passed to reply and sources appended without importing web facts as memory',async t=>{const f=fixture(t);f.chat.receive({accountId:'small',chatId:'miners',senderId:'alice',senderName:'甲',chatType:'group',id:'3',text:'可可，查一下官方文档'});await f.run();assert.equal(f.queries.length,1);assert(f.calls[0].text.includes('官方资料'));assert(f.calls[0].text.includes('https://example.com/official'));assert.notEqual(f.calls[0].persona,'PRIVATE');assert(f.sends[0].text.includes('https://example.com/official'));assert.equal(f.store.data.memory.length,0);});
test('disabling a chosen contact cancels its pending model result',async t=>{const f=fixture(t);f.chat.receive({accountId:'small',chatId:'new',id:'4',text:'你好'});f.store.data.settings.contacts[1].enabled=false;await f.run();assert.equal(f.calls.length,0);assert.equal(f.sends.length,0);});
