import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../lib/store.mjs';
import {ChatController} from '../lib/chat.mjs';
import {normalizeGroup,toggleGroupProactive} from '../lib/groups.mjs';
import {usefulGroupTopic,participationGate} from '../lib/proactive.mjs';

const gid='miners@chatroom',route='small:'+gid;
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function fixture(t,{group={},reply,send}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'koko-proactive-'));
  const store=new Store(dir,'PRIVATE_PERSONA');
  Object.assign(store.data.settings,{enabled:true,accountId:'small',chatId:'owner',groupPersona:'PUBLIC_PERSONA',groups:[normalizeGroup({chatId:gid,name:'矿工群',mode:'smart',aliases:['可可'],...group})]});
  let time=10_000_000;const modelCalls=[],bridgeCalls=[],controllers=[];
  const model={resetSessions(){},reply:async args=>{modelCalls.push(args);return reply?reply(args):{should_reply:true,reply:'可以试试侦察兵',remember:[]};}};
  const bridge={call:async(method,args)=>{bridgeCalls.push({method,args});return ['send','send_batch'].includes(method)?send?send(args,method):{status:'confirmed'}:{};}};
  const make=(localStore=store)=>{const value=new ChatController({store:localStore,model,bridge,now:()=>time,delay:3_600_000});controllers.push(value);return value;};
  const chat=make(),message=(id,text='今晚深岩银河玩哪个职业好',extra={})=>({accountId:'small',chatId:gid,chatType:'group',senderId:'alice',senderName:'甲',id,text,receivedAt:time,...extra});
  const jobs=()=>[...chat.jobs.values()];
  const run=async(job=jobs()[0],controller=chat)=>{assert(job,'queued job expected');clearTimeout(job.timer);await controller.run(job);};
  t.after(()=>{for(const controller of controllers)for(const job of controller.jobs.values()){clearTimeout(job.timer);job.abort.abort();}fs.rmSync(dir,{recursive:true,force:true});});
  return {store,dir,chat,message,jobs,run,make,modelCalls,bridgeCalls,advance:ms=>time+=ms,now:()=>time,sends:()=>bridgeCalls.filter(x=>['send','send_batch'].includes(x.method))};
}

test('participation is opt-in and quick toggle preserves the prior direct rule and disabled state',()=>{
  const base=normalizeGroup({chatId:gid,mode:'mention',enabled:false});
  assert.equal(normalizeGroup({chatId:gid}).mode,'addressed');
  const on=toggleGroupProactive(base,true),off=toggleGroupProactive(on,false);
  assert.equal(on.mode,'smart');assert.equal(on.enabled,false);assert.equal(on.proactiveIntervalSeconds,120);assert.equal(on.proactiveMaxPerHour,3);
  assert.equal(off.mode,'mention');assert.equal(off.enabled,false);
  assert.throws(()=>toggleGroupProactive(null,true));assert.throws(()=>toggleGroupProactive(base,'yes'));
});
test('rate settings reject malformed values and survive ordinary group edits',()=>{
  for(const input of [{proactiveIntervalSeconds:0},{proactiveIntervalSeconds:3601},{proactiveIntervalSeconds:'120'},{proactiveMaxPerHour:0},{proactiveMaxPerHour:21},{proactiveBaseMode:'always',mode:'smart'}])assert.throws(()=>normalizeGroup({chatId:gid,...input}));
  const base=normalizeGroup({chatId:gid,mode:'smart',proactiveIntervalSeconds:300,proactiveMaxPerHour:2});
  const changed=normalizeGroup({chatId:gid,aliases:['可可']},base);
  assert.equal(changed.proactiveIntervalSeconds,300);assert.equal(changed.proactiveMaxPerHour,2);
});
test('low-information messages do not spend a model request',t=>{
  const f=fixture(t);
  for(const text of ['[图片]','[动画表情]','哈哈哈哈','嗯','对啊','好！','🫧🫧','666']){assert.equal(usefulGroupTopic(text),false,text);f.chat.receive(f.message(text,text));}
  assert.equal(f.jobs().length,0);assert.equal(f.modelCalls.length,0);assert.equal(f.sends().length,0);
  assert.ok(f.store.data.events.some(x=>x.proactiveDecision==='low_content'&&x.sourceMessages.length===1));
});
test('only selected groups with fresh incoming events can start participation',t=>{
  const f=fixture(t,{group:{mode:'addressed'}});assert.equal(f.jobs().length,0);
  f.chat.receive(f.message('not-called'));assert.equal(f.jobs().length,0);
  f.store.data.settings.groups[0].mode='smart';
  for(const extra of [{chatId:'other@chatroom'},{accountId:'other'},{isSelf:true},{senderId:'small'}])f.chat.receive(f.message(JSON.stringify(extra),undefined,extra));
  assert.equal(f.jobs().length,0);
  f.chat.receive(f.message('real'));assert.equal(f.jobs().length,1);
});
test('a group burst creates one decision and preserves each speaker in the payload',async t=>{
  const f=fixture(t);f.store.message('small:owner','user','PRIVATE_SECRET');f.store.message('small:other@chatroom','user','OTHER_GROUP_SECRET');
  f.chat.receive(f.message('one','今晚要挑战高难矿洞吗'));
  f.chat.receive(f.message('two','刚入坑选什么职业合适',{senderId:'bob',senderName:'乙'}));
  assert.equal(f.jobs().length,1);const job=f.jobs()[0];assert.equal(job.senderId,'bob');
  await f.run();assert.equal(f.modelCalls.length,1);assert.equal(f.sends().length,1);
  const request=f.modelCalls[0],payload=JSON.parse(request.text.slice(request.text.indexOf('\n')+1));
  assert.deepEqual(payload.messages.map(x=>x.sender_id),['alice','bob']);assert.equal(payload.reply_to.name,'乙');
  assert(request.text.includes('默认可以安静旁听'));assert(request.text.includes('只接当前话题'));
  assert(!JSON.stringify(request).includes('PRIVATE_SECRET'));assert(!JSON.stringify(request).includes('OTHER_GROUP_SECRET'));assert(!request.persona.includes('PRIVATE_PERSONA'));
});
test('a model may choose silence and the decision is linked to the original messages',async t=>{
  const f=fixture(t,{reply:async()=>({should_reply:false,reply:'',remember:[]})});f.chat.receive(f.message('skip'));await f.run();
  assert.equal(f.sends().length,0);assert.equal(f.store.data.groupParticipation[route].attempts.length,0);
  const event=f.store.data.events.find(x=>x.proactiveDecision==='model_skip');assert.deepEqual(event.sourceEventIds,['skip']);assert.equal(event.sourceMessages[0].text,'今晚深岩银河玩哪个职业好');
  f.chat.receive(f.message('skip-next'));assert.equal(f.jobs().length,0);f.advance(20_000);f.chat.receive(f.message('new-topic'));assert.equal(f.jobs().length,1);
});
test('direct calls preempt a pending opener and other mentions cancel it',t=>{
  for(const other of [false,true]){
    const f=fixture(t);f.chat.receive(f.message('topic'));
    f.chat.receive(f.message('direct',other?'@乙 你来决定':'可可，帮我看一下',{senderId:'carol',mentionedIds:other?['bob']:['small']}));
    assert.equal(f.jobs().length,other?0:1);if(!other)assert.equal(f.jobs()[0].trigger,'mentioned');
  }
});
test('a pending direct reply suppresses unrelated proactive chatter',t=>{
  const f=fixture(t);f.chat.receive(f.message('direct','可可，来看看'));f.chat.receive(f.message('topic','今天矿洞难不难',{senderId:'bob'}));
  assert.equal(f.jobs().length,1);assert.equal(f.jobs()[0].trigger,'named');assert(f.store.data.events.some(x=>x.proactiveDecision==='direct_pending'));
});
test('an explicit topic change invalidates a running decision and its late result never sends',async t=>{
  const pending=deferred(),f=fixture(t,{reply:()=>pending.promise});f.chat.receive(f.message('old'));const run=f.run();await flush();
  f.chat.receive(f.message('new','换个话题讨论新游戏',{senderId:'bob'}));pending.resolve({should_reply:true,reply:'旧话题的插话',remember:[]});await run;
  assert.equal(f.sends().length,0);assert.equal(f.jobs().length,0);assert(f.store.data.events.some(x=>x.proactiveDecision==='superseded'));
});
test('ordinary chatter cannot starve an already running decision',async t=>{
  const pending=deferred(),f=fixture(t,{reply:()=>pending.promise});f.chat.receive(f.message('old'));const run=f.run();await flush();
  f.advance(25_000);f.chat.receive(f.message('new','我也想试试侦察兵',{senderId:'bob'}));assert.equal(f.jobs().length,1);
  pending.resolve({should_reply:true,reply:'侦察兵机动性不错',remember:[]});await run;assert.equal(f.sends().length,1);assert.equal(f.modelCalls.length,1);
});
test('public sources stay intact without creating multiline background bubbles',async t=>{
  const f=fixture(t);f.store.data.settings.webSearchEnabled=true;
  f.chat.search={weatherRequest:()=>true,run:async()=>({answer:'已核对官方说明',sources:[{url:'https://example.com/official',title:'官方说明'}],webSearched:true})};
  f.chat.receive(f.message('public'));await f.run();const sent=f.sends()[0];assert(sent);assert(sent.args.text.includes('https://example.com/official'));assert(!sent.args.text.includes('\n'));
});
test('interval and hourly limits apply to unsolicited turns, while direct calls still work',async t=>{
  const f=fixture(t,{group:{proactiveIntervalSeconds:30,proactiveMaxPerHour:1}});
  f.chat.receive(f.message('first'));await f.run();assert.equal(f.sends().length,1);
  f.advance(31_000);f.chat.receive(f.message('limited',undefined,{senderId:'bob'}));assert.equal(f.jobs().length,0);
  assert.equal(f.store.data.events[0].proactiveDecision,'hour_limit');
  f.chat.receive(f.message('direct','可可，解释一下',{senderId:'bob',atMe:true}));await f.run();assert.equal(f.sends().length,2);
  assert.equal(f.store.data.groupParticipation[route].attempts.length,1);
  f.advance(3_600_001);f.chat.receive(f.message('later',undefined,{senderId:'carol'}));assert.equal(f.jobs().length,1);
});
test('the minimum interval is distinct from the hourly quota',async t=>{
  const f=fixture(t);f.chat.receive(f.message('first'));await f.run();f.advance(30_000);
  f.chat.receive(f.message('early',undefined,{senderId:'bob'}));assert.equal(f.jobs().length,0);assert.equal(f.store.data.events[0].proactiveDecision,'interval');
  f.advance(90_000);f.chat.receive(f.message('ready',undefined,{senderId:'bob'}));assert.equal(f.jobs().length,1);
});
test('limits survive restart and reserve one complete turn before bridge I/O',async t=>{
  let f;f=fixture(t,{group:{proactiveMaxPerHour:1},send:async()=>{
    const disk=new Store(f.dir);assert.equal(disk.data.groupParticipation[route].attempts.length,1);return {status:'confirmed'};
  }});
  f.chat.receive(f.message('first'));await f.run();f.advance(130_000);
  const restored=new Store(f.dir),chat=f.make(restored);chat.receive(f.message('after-restart',undefined,{senderId:'bob'}));
  assert.equal(chat.jobs.size,0);assert.equal(f.sends().length,1);assert.equal(participationGate(restored,route,restored.data.settings.groups[0],f.now()).reason,'hour_limit');
});
test('separate groups never share participation quotas',async t=>{
  const f=fixture(t,{group:{proactiveMaxPerHour:1}});f.store.data.settings.groups.push(normalizeGroup({chatId:'other@chatroom',name:'另一群',mode:'smart'}));
  f.chat.receive(f.message('first'));await f.run();f.chat.receive(f.message('second',undefined,{chatId:'other@chatroom'}));assert.equal(f.jobs().length,1);
});
test('a split reply spends one turn and keeps the existing batch send path',async t=>{
  const f=fixture(t,{reply:async()=>({should_reply:true,reply:'可以玩侦察兵\n移动会更灵活\n再搭配个工程师',remember:['乙喜欢侦察兵']})});
  f.chat.receive(f.message('burst'));await f.run();assert.equal(f.sends().length,1);assert.equal(f.sends()[0].method,'send_batch');assert.equal(f.sends()[0].args.sendMode,'background');
  assert.equal(f.store.data.groupParticipation[route].attempts.length,1);assert.equal(f.store.data.memory.length,0);
});
test('an uncertain send consumes a turn and holds its route without disabling selection or retrying',async t=>{
  const f=fixture(t,{send:async()=>({status:'unconfirmed'})});f.chat.receive(f.message('uncertain'));await f.run();
  assert.equal(f.sends().length,1);assert.equal(f.store.data.groupParticipation[route].attempts.length,1);assert.equal(f.store.data.settings.groups[0].enabled,true);assert.equal(f.chat.recovery.get(route).kind,'review');assert.equal(f.store.data.settings.enabled,true);
  f.chat.receive(f.message('retry'));assert.equal(f.jobs().length,0);
});
test('disabling proactive mode or changing its limits invalidates in-flight results',async t=>{
  for(const change of [g=>g.mode='addressed',g=>g.proactiveIntervalSeconds=600,g=>g.proactiveMaxPerHour=1]){
    const pending=deferred(),f=fixture(t,{reply:()=>pending.promise});f.chat.receive(f.message('old'));const run=f.run();await flush();change(f.store.data.settings.groups[0]);pending.resolve({should_reply:true,reply:'迟到回复'});await run;assert.equal(f.sends().length,0);
  }
});
test('a slow decision cannot insert an expired topic',async t=>{
  const pending=deferred(),f=fixture(t,{reply:()=>pending.promise});f.chat.receive(f.message('old'));const run=f.run();await flush();f.advance(60_001);pending.resolve({should_reply:true,reply:'迟到回复'});await run;
  assert.equal(f.sends().length,0);assert(f.store.data.events.some(x=>x.proactiveDecision==='stale'));
});
test('group followups remain ordinary addressed replies after the assistant has joined',async t=>{
  const f=fixture(t);f.chat.receive(f.message('first'));await f.run();f.advance(9000);f.chat.receive(f.message('follow','那武器怎么选比较好'));assert.equal(f.jobs()[0].trigger,'followup');
});
