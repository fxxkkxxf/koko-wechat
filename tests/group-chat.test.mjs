import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../lib/store.mjs';
import {ChatController, GROUP_PERSONA, bindingTargets, groupTrigger} from '../lib/chat.mjs';
import {withReplyStyle} from '../lib/reply-style.mjs';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const config=(chatId='miners',extra={})=>({chatId,name:chatId==='miners'?'深岩银河':'另一个群',enabled:true,mode:'addressed',aliases:['可可','鱼神'],cooldownSeconds:8,followupSeconds:90,...extra});
function fixture(t,{reply,send,groups=[config()],settings={}}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'koko-group-chat-'));
  const store=new Store(dir,'私聊主人专属私密人设');
  Object.assign(store.data.settings,{enabled:true,accountId:'small',chatId:'owner',expectedChatName:'大号',groups,groupPersona:'可可的公开群聊人设',...settings});
  let time=1_000_000;const calls=[],modelCalls=[];
  const bridge={call:async(method,args)=>{calls.push({method,args});return method==='send'?(send?await send(args):{status:'confirmed'}):{};}};
  const model={connect:async()=>{},status:()=>({authenticated:true}),reply:async args=>{modelCalls.push(args);return reply?await reply(args):{should_reply:true,reply:'收到',remember:[]};}};
  const chat=new ChatController({store,model,bridge,now:()=>time,delay:3_600_000});
  t.after(()=>{for(const job of chat.jobs.values()){clearTimeout(job.timer);job.abort.abort();}fs.rmSync(dir,{recursive:true,force:true});});
  const message=(id,text='可可，来看看',extra={})=>({id,text,accountId:'small',chatId:'miners',chatType:'group',senderId:'alice',senderName:'爱丽丝',receivedAt:time,...extra});
  const jobFor=(senderId='alice',chatId='miners')=>chat.jobs.get('small:'+chatId+':member:'+senderId);
  const run=async(job=jobFor())=>{assert.ok(job,'expected a queued model job');clearTimeout(job.timer);await chat.run(job);};
  return {dir,store,model,chat,calls,modelCalls,message,jobFor,run,advance:ms=>{time+=ms;},now:()=>time};
}
const sent=fx=>fx.calls.filter(call=>call.method==='send');

test('binding keeps the primary private target and only enabled, unique groups',()=>{
  const targets=bindingTargets({chatId:'owner',expectedChatName:'大号',groups:[config(),config('disabled',{enabled:false}),config(),config('owner'),null]});
  assert.deepEqual(targets,[{chatId:'owner',type:'private',name:'大号'},{chatId:'miners',type:'group',name:'深岩银河',aliases:['可可','鱼神']}]);
});

test('old private settings migrate without changing the private target or persona',t=>{
  const fx=fixture(t);fs.writeFileSync(path.join(fx.dir,'state.json'),JSON.stringify({settings:{enabled:true,accountId:'small',chatId:'owner',persona:'原私人设'}}));
  const restored=new Store(fx.dir,'默认人设');
  assert.equal(restored.data.settings.chatId,'owner');assert.equal(restored.data.settings.persona,'原私人设');
  assert.deepEqual(restored.data.settings.groups,[]);assert.equal(restored.data.settings.groupPersona,GROUP_PERSONA);
});

test('mention mode requires actual self mention metadata',()=>{
  const settings={accountId:'small'},group=config('miners',{mode:'mention'});
  const trigger=msg=>groupTrigger({settings,group,msg,now:100});
  assert.equal(trigger({text:'可可，早上好'}).reply,false);
  assert.equal(trigger({text:'@鱼神 你好',atMe:true}).reply,true);
  assert.equal(trigger({text:'你好',mentionedIds:['small']}).reply,true);
  assert.equal(trigger({text:'@别人 你好',mentionedIds:['bob']}).reply,false);
});

test('addressed mode accepts opening aliases and real group nickname, not incidental names',()=>{
  const settings={accountId:'small'},group=config();
  const trigger=(text,extra={})=>groupTrigger({settings,group,msg:{text,...extra},now:100});
  for(const text of ['可可，早上好','可可你觉得呢','@鱼神 早上好'])assert.equal(trigger(text).reply,true,text);
  assert.equal(trigger('龙娘同学：早上好',{selfAliases:['龙娘同学']}).reply,true);
  for(const text of ['我觉得可可说得对','可可爱爱','听说鱼神来了'])assert.equal(trigger(text).reply,false,text);
});

test('only the selected group and account can enqueue a group reply',t=>{
  const fx=fixture(t);
  fx.chat.receive(fx.message('wrong-group','可可，早',{chatId:'stranger'}));
  fx.chat.receive(fx.message('wrong-account','可可，早',{accountId:'other'}));
  fx.chat.receive(fx.message('self','可可，早',{senderId:'small'}));
  fx.chat.receive(fx.message('no-sender','可可，早',{senderId:''}));
  fx.chat.receive(fx.message('idle','今晚挖矿吗'));
  assert.equal(fx.chat.jobs.size,0);assert.equal(fx.modelCalls.length,0);
  assert.equal(fx.store.history('small:miners').length,1);
  fx.chat.receive(fx.message('call'));assert.equal(fx.chat.jobs.size,1);
});

test('a confirmed reply permits only the same member to follow up, without extending from chatter',async t=>{
  const fx=fixture(t,{groups:[config('miners',{cooldownSeconds:0})]});
  fx.chat.receive(fx.message('call'));await fx.run();const until=fx.chat.followups.get('miners').get('alice');
  fx.advance(20_000);fx.chat.receive(fx.message('bob-idle','对啊',{senderId:'bob',senderName:'鲍勃'}));
  assert.equal(fx.chat.jobs.size,0);assert.equal(fx.chat.followups.get('miners').get('alice'),until);
  fx.chat.receive(fx.message('followup','那你推荐哪个职业？'));assert.equal(fx.jobFor().trigger,'followup');await fx.run();
  assert.equal(sent(fx).length,2);
  fx.advance(91_000);fx.chat.receive(fx.message('expired','还有别的吗'));assert.equal(fx.chat.jobs.size,0);
});

test('addressing another member ends the old follow-up window',async t=>{
  const fx=fixture(t,{groups:[config('miners',{cooldownSeconds:0})]});
  fx.chat.receive(fx.message('call'));await fx.run();assert.ok(fx.chat.followups.get('miners').has('alice'));
  fx.chat.receive(fx.message('to-bob','@鲍勃 你来吗',{mentionedIds:['bob'],hasOtherMention:true}));
  assert.equal(fx.chat.followups.get('miners').has('alice'),false);assert.equal(fx.chat.jobs.size,0);
  fx.chat.receive(fx.message('still-to-bob','什么时候来'));assert.equal(fx.chat.jobs.size,0);
});

test('mention mode never inherits an addressed follow-up window',t=>{
  const fx=fixture(t,{groups:[config('miners',{mode:'mention'})]});fx.chat.followups.set('miners',new Map([['alice',fx.now()+90_000]]));
  fx.chat.receive(fx.message('idle','再说一句'));assert.equal(fx.chat.jobs.size,0);
  fx.chat.receive(fx.message('at','你好',{atMe:true}));assert.equal(fx.jobFor().trigger,'mentioned');
});

test('different members never merge requests and group context keeps sender identity',async t=>{
  const fx=fixture(t);fx.chat.receive(fx.message('a1','可可，我是侦察兵'));fx.chat.receive(fx.message('b1','可可，我是工程师',{senderId:'bob',senderName:'鲍勃'}));fx.chat.receive(fx.message('a2','补充：我喜欢抓钩',{atMe:true}));
  assert.equal(fx.chat.jobs.size,2);assert.deepEqual(fx.jobFor().texts,['可可，我是侦察兵','补充：我喜欢抓钩']);assert.deepEqual(fx.jobFor('bob').texts,['可可，我是工程师']);
  await fx.run(fx.jobFor());const request=fx.modelCalls[0],payload=JSON.parse(request.text.slice(request.text.indexOf('\n')+1));
  assert.equal(request.sessionKey,'small:miners:member:alice');assert.deepEqual(request.history,[]);
  assert.deepEqual(payload.reply_to,{sender_id:'alice',name:'爱丽丝'});
  assert.ok(payload.messages.every(x=>x.sender_id==='alice'));assert.equal(payload.messages.length,2);
  const prior=payload.recent_group_messages.map(row=>JSON.parse(row.content));
  assert.ok(prior.some(row=>row.sender_id==='bob'&&row.name==='鲍勃'&&row.text==='可可，我是工程师'));
});

test('groups never receive the private persona, private history or other member memory',async t=>{
  const fx=fixture(t,{reply:async()=>({should_reply:true,reply:'收到',remember:['喜欢侦察兵']})});
  fx.store.message('small:owner','user','主人私密信息');fx.store.message('small:another-group','user','另一个群的秘密',{chatType:'group',senderId:'alice',senderName:'爱丽丝'});
  fx.store.data.memory=[{sessionKey:'small:owner',text:'主人生日'},{sessionKey:'small:miners:member:bob',text:'鲍勃偏好'},{sessionKey:'small:another-group:member:alice',text:'其他群偏好'},{sessionKey:'small:miners:member:alice',text:'爱丽丝本群偏好'}];
  fx.chat.receive(fx.message('call'));await fx.run();const request=fx.modelCalls[0];
  assert.equal(request.persona,withReplyStyle('可可的公开群聊人设'));assert.deepEqual(request.memory,['爱丽丝本群偏好']);
  for(const secret of ['主人私密信息','另一个群的秘密','主人专属私密人设','主人生日','鲍勃偏好','其他群偏好'])assert.equal(JSON.stringify(request).includes(secret),false,secret);
  assert.ok(fx.store.data.memory.some(row=>row.sessionKey==='small:miners:member:alice'&&row.text==='喜欢侦察兵'));
});

test('empty group persona falls back to the public default and leaves private persona intact',async t=>{
  const fx=fixture(t,{settings:{groupPersona:''}});fx.chat.receive(fx.message('group'));await fx.run();
  assert.equal(fx.modelCalls[0].persona,withReplyStyle(GROUP_PERSONA));
  fx.chat.receive(fx.message('private','你好',{chatId:'owner',chatType:'private'}));await fx.run(fx.chat.jobs.get('small:owner'));
  assert.equal(fx.modelCalls[1].persona,withReplyStyle('私聊主人专属私密人设'));
});

test('group cooldown is independent for each group and does not suppress private replies',async t=>{
  const fx=fixture(t,{groups:[config(),config('second')]});fx.chat.receive(fx.message('first'));await fx.run();
  fx.chat.receive(fx.message('too-soon','可可，再说一句'));assert.equal(fx.chat.jobs.size,0);
  fx.chat.receive(fx.message('second','可可，早',{chatId:'second'}));await fx.run(fx.jobFor('alice','second'));
  fx.chat.receive(fx.message('private','你好',{chatId:'owner',chatType:'private'}));await fx.run(fx.chat.jobs.get('small:owner'));
  assert.deepEqual(sent(fx).map(x=>x.args.chatId),['miners','second','owner']);
  fx.advance(8_000);fx.chat.receive(fx.message('after-cooldown'));assert.ok(fx.jobFor());
});

test('three concurrent group model results cannot bypass the in-flight send reservation',async t=>{
  const a=deferred(),b=deferred(),c=deferred(),delivery=deferred();
  const pending={alice:a,bob:b,carol:c};const fx=fixture(t,{reply:args=>pending[args.sessionKey.split(':').at(-1)].promise,send:()=>delivery.promise});
  for(const member of Object.keys(pending))fx.chat.receive(fx.message(member,'可可，回我',{senderId:member,senderName:member}));
  const jobs=Object.keys(pending).map(x=>fx.jobFor(x));for(const job of jobs)clearTimeout(job.timer);
  const runs=jobs.map(job=>fx.chat.run(job));a.resolve({should_reply:true,reply:'给爱丽丝的回复'});await flush();
  assert.equal(sent(fx).length,1);assert.equal(fx.chat.groupSending.get('miners'),jobs[0]);
  b.resolve({should_reply:true,reply:'给鲍勃的回复'});await flush();assert.equal(fx.chat.groupSending.get('miners'),jobs[0]);
  c.resolve({should_reply:true,reply:'给卡罗尔的回复'});await flush();assert.equal(sent(fx).length,1);assert.equal(fx.chat.groupSending.get('miners'),jobs[0]);
  delivery.resolve({status:'confirmed'});await Promise.all(runs);assert.equal(fx.chat.groupSending.has('miners'),false);
});

test('smart mode rate limits model decisions even when the model declines to reply',async t=>{
  const fx=fixture(t,{groups:[config('miners',{mode:'smart'})],reply:async()=>({should_reply:false,reply:'',remember:[]})});
  fx.chat.receive(fx.message('first','今晚挖矿吗'));await fx.run();
  fx.chat.receive(fx.message('flood','哪个难度'));assert.equal(fx.chat.jobs.size,0);assert.equal(fx.modelCalls.length,1);
  fx.chat.receive(fx.message('other-mention','@别人 今晚吗',{hasOtherMention:true}));assert.equal(fx.chat.jobs.size,0);
  fx.advance(20_000);fx.chat.receive(fx.message('later','有空吗'));assert.ok(fx.jobFor());
});

for(const change of ['disabled','mode','aliases','persona','cooldown'])test('group configuration change invalidates an in-flight reply: '+change,async t=>{
  const result=deferred();const fx=fixture(t,{reply:()=>result.promise});fx.chat.receive(fx.message('call'));const job=fx.jobFor();clearTimeout(job.timer);const run=fx.chat.run(job);await flush();
  const group=fx.store.data.settings.groups[0];
  if(change==='disabled')group.enabled=false;
  if(change==='mode')group.mode='mention';
  if(change==='aliases')group.aliases=['新的名字'];
  if(change==='persona')fx.store.data.settings.groupPersona='新的人设';
  if(change==='cooldown')group.cooldownSeconds=20;
  result.resolve({should_reply:true,reply:'旧配置的回复'});await run;assert.equal(sent(fx).length,0);
});

test('global pause cancels pending group results without sending',async t=>{
  const result=deferred();const fx=fixture(t,{reply:()=>result.promise});fx.chat.receive(fx.message('call'));const job=fx.jobFor();clearTimeout(job.timer);const run=fx.chat.run(job);await flush();
  await fx.chat.pause();result.resolve({should_reply:true,reply:'迟到回复'});await run;
  assert.equal(sent(fx).length,0);assert.equal(fx.chat.jobs.size,0);assert.ok(fx.calls.some(x=>x.method==='stop'));
});

for(const status of ['blocked','unconfirmed'])test('a '+status+' group send holds only its route and preserves selection',async t=>{
  const fx=fixture(t,{groups:[config(),config('second')],send:async args=>args.chatId==='miners'?{status,message:'测试发送结果'}:{status:'confirmed'}});
  fx.chat.receive(fx.message('group'));await fx.run();assert.equal(fx.store.data.settings.enabled,true);assert.equal(fx.store.data.settings.groups[0].enabled,true);assert.equal(fx.chat.recovery.get('small:miners').kind,status==='blocked'?'waiting':'review');assert.equal(fx.store.data.settings.groups[1].enabled,true);
  assert.equal(fx.chat.followups.has('miners'),false);assert.equal(fx.calls.some(x=>x.method==='stop'),false);assert.equal(fx.store.history('small:miners').some(x=>x.role==='assistant'),false);
  fx.chat.receive(fx.message('private','你好',{chatId:'owner',chatType:'private'}));await fx.run(fx.chat.jobs.get('small:owner'));
  assert.equal(sent(fx).at(-1).args.chatId,'owner');assert.equal(fx.store.data.settings.enabled,true);
});

test('an ambiguous delivery exception holds its route without disabling the group',async t=>{
  const fx=fixture(t,{send:async()=>{throw Error('模拟桥接断开');}});fx.chat.receive(fx.message('group'));await fx.run();
  assert.equal(fx.store.data.settings.enabled,true);assert.equal(fx.store.data.settings.groups[0].enabled,true);assert.equal(fx.chat.recovery.get('small:miners').kind,'review');assert.equal(fx.calls.some(x=>x.method==='stop'),false);
});

test('group-only setup binds the target list and warms only the public persona',async t=>{
  const fx=fixture(t,{settings:{enabled:false,chatId:''}});fx.store.message('small:miners','user','旧群消息',{chatType:'group',senderId:'bob',senderName:'鲍勃'});await fx.chat.prepare();await fx.chat.enable();
  assert.equal(fx.modelCalls[0].persona,withReplyStyle('可可的公开群聊人设'));const binding=fx.calls.find(x=>x.method==='bind').args;
  assert.equal(binding.chatId,'');assert.deepEqual(binding.targets,[{chatId:'miners',type:'group',name:'深岩银河',aliases:['可可','鱼神']}]);assert.equal(fx.store.data.settings.enabled,true);assert.deepEqual(fx.modelCalls[0].history,[]);
});

test('duplicate event identifiers remain independent across allowed groups',t=>{
  const fx=fixture(t,{groups:[config(),config('second')]});fx.chat.receive(fx.message('shared-id'));fx.chat.receive(fx.message('shared-id'));fx.chat.receive(fx.message('shared-id','可可，你好',{chatId:'second'}));
  assert.equal(fx.chat.jobs.size,2);assert.equal(fx.store.data.conversations.length,2);
});

test('retaining group history is bounded per session and preserves recent private history',t=>{
  const fx=fixture(t);fx.store.message('small:owner','user','私人会话仍需保留');
  for(let i=0;i<220;i++)fx.store.message('small:miners','user','群消息'+i,{chatType:'group',senderId:'alice',senderName:'爱丽丝'});
  assert.equal(fx.store.data.conversations.filter(x=>x.sessionKey==='small:miners').length,200);
  assert.equal(fx.store.history('small:owner')[0].content,'私人会话仍需保留');
  assert.equal(JSON.parse(fx.store.history('small:miners')[0].content).sender_id,'alice');
});

test('large group context stays valid JSON within the model text budget and retains the recipient',t=>{
  const fx=fixture(t);const long='\\\"\n\t'.repeat(5000);
  for(let i=0;i<12;i++)fx.store.message('small:miners','user',long,{chatType:'group',senderId:'bob',senderName:'鲍勃'});
  for(let i=0;i<16;i++)fx.chat.receive(fx.message('large-'+i,'可可，'+long));
  const job=fx.jobFor(),input=fx.chat.groupInput(job);assert.ok(input.length<=18000);assert.equal(job.texts.length,12);
  const payload=JSON.parse(input.slice(input.indexOf('\n')+1));assert.equal(payload.reply_to.sender_id,'alice');assert.equal(payload.reply_to.name,'爱丽丝');
  assert.equal(payload.truncated,true);assert.ok(payload.messages.length>=1);assert.ok(payload.messages.every(x=>x.sender_id==='alice'));
});

test('a group job invalidated before generation is removed without calling the model',async t=>{
  const fx=fixture(t);fx.chat.receive(fx.message('call'));const job=fx.jobFor();fx.store.data.settings.groups[0].enabled=false;await fx.run(job);
  assert.equal(fx.chat.jobs.size,0);assert.equal(fx.modelCalls.length,0);assert.equal(sent(fx).length,0);
});

test('a late blocked delivery cannot disable a newly enabled configuration',async t=>{
  const delivery=deferred();const fx=fixture(t,{send:()=>delivery.promise});fx.chat.receive(fx.message('call'));const job=fx.jobFor();clearTimeout(job.timer);const run=fx.chat.run(job);await flush();assert.equal(sent(fx).length,1);
  await fx.chat.pause();await fx.chat.enable();delivery.resolve({status:'blocked',message:'旧发送已取消'});await run;
  assert.equal(fx.store.data.settings.enabled,true);assert.equal(fx.store.data.settings.groups[0].enabled,true);assert.equal(fx.chat.followups.has('miners'),false);
});
