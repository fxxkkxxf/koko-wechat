import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../lib/store.mjs';
import {ChatController} from '../lib/chat.mjs';
import {Recovery,deliveryFailure} from '../lib/recovery.mjs';
import {deliveryResult} from '../lib/delivery.mjs';
import {BridgeClient} from '../lib/bridge.mjs';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';

function fixture(t,{send,reply}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'koko-recovery-')),store=new Store(dir,'角色');
  Object.assign(store.data.settings,{enabled:true,accountId:'small',chatId:'friend',groups:[{chatId:'group',name:'测试群',mode:'addressed',enabled:true,aliases:['可可'],cooldownSeconds:0}]});
  let time=1_000_000;const calls=[],modelCalls=[];
  const bridge={call:async(method,args)=>{calls.push({method,args});return ['send','send_batch'].includes(method)?send?send(args):{status:'confirmed'}:{};}};
  const model={resetSessions(){},reply:async args=>{modelCalls.push(args);return reply?reply(args):{should_reply:true,reply:'收到',remember:[]};}};
  const chat=new ChatController({store,bridge,model,now:()=>time,delay:3600000});
  const receive=(id='a',extra={})=>chat.receive({id,text:'可可，来看看',chatId:'group',chatType:'group',senderId:'alice',senderName:'甲',accountId:'small',receivedAt:time,...extra});
  const run=async()=>{const job=[...chat.jobs.values()][0];assert(job);clearTimeout(job.timer);await chat.run(job);};
  t.after(()=>{for(const j of chat.jobs.values()){clearTimeout(j.timer);j.abort.abort();}fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,store,chat,calls,modelCalls,receive,run,advance:ms=>time+=ms,now:()=>time,sends:()=>calls.filter(x=>['send','send_batch'].includes(x.method))};
}
test('UIA preflight failure temporarily waits then processes only a fresh event',async t=>{
  let first=true;const f=fixture(t,{send:async()=>first?(first=false,{status:'blocked',code:'BG_ACCESSIBILITY',message:'控件未就绪'}):{status:'confirmed'}});
  f.receive('old');await f.run();assert.equal(f.store.data.settings.groups[0].enabled,true);assert.equal(f.store.data.settings.enabled,true);
  assert.equal(f.chat.recovery.get('small:group').until,f.now()+15000);f.receive('during-wait');assert.equal(f.chat.jobs.size,0);assert.equal(f.modelCalls.length,1);
  f.advance(15001);f.receive('fresh');await f.run();assert.deepEqual(f.sends().map(x=>x.args.id),['old','fresh']);assert.equal(f.chat.recovery.get('small:group'),undefined);
  assert(f.store.data.events.some(x=>x.kind==='recovered'));
});
test('backoff grows to a finite maximum and persists across restart',t=>{
  const f=fixture(t),job={routeKey:'small:group',accountId:'small',chatId:'group',group:true};const waits=[];
  for(let i=0;i<9;i++){const row=f.chat.recovery.hold(job,{kind:'waiting',code:'HUMAN_DRAFT',reason:'有草稿'});waits.push((row.until-f.now())/1000);}
  assert.deepEqual(waits,[15,30,60,120,240,300,300,300,300]);
  const restored=new Recovery(new Store(f.dir),f.now);assert(restored.blocked('small:group'));f.advance(300001);assert(!restored.blocked('small:group'));assert(restored.snapshot()[0].ready);
});
test('a transient group wait does not stop private or other group replies',async t=>{
  const f=fixture(t,{send:async args=>args.chatId==='group'?{status:'blocked',code:'USER_TAKEOVER'}:{status:'confirmed'}});
  f.receive();await f.run();f.receive('private',{chatId:'friend',chatType:'private'});await f.run();assert.equal(f.sends().length,2);assert.equal(f.store.data.settings.enabled,true);
});
test('uncertain sends remain held after time and restart without changing switches',async t=>{
  const f=fixture(t,{send:async()=>({status:'unconfirmed'})});f.receive();await f.run();f.advance(3600000);f.receive('new');assert.equal(f.chat.jobs.size,0);
  const restored=new Recovery(new Store(f.dir),f.now);assert(restored.blocked('small:group'));assert.equal(restored.get('small:group').kind,'review');assert.equal(f.sends().length,1);
});
test('an opaque RPC exception is not guessed to be an unsent preflight failure',async t=>{
  const f=fixture(t,{send:async()=>{throw Object.assign(Error('控件未就绪'),{code:'BG_ACCESSIBILITY'});}});f.receive();await f.run();assert.equal(f.chat.recovery.get('small:group').kind,'review');assert.equal(f.store.data.settings.enabled,true);
});
test('account mismatch preserves user selection but requires explicit repair',async t=>{
  const f=fixture(t,{send:async()=>({status:'blocked',code:'ACCOUNT_CHANGED'})});f.receive();await f.run();f.advance(3600000);f.receive('new');assert.equal(f.chat.jobs.size,0);assert.equal(f.chat.recovery.get('small:group').kind,'attention');assert.equal(f.store.data.settings.groups[0].enabled,true);
});
test('a user pause or disabled group is never undone by an expired wait',async t=>{
  const f=fixture(t,{send:async()=>({status:'blocked'})});f.receive();await f.run();await f.chat.pause();f.advance(600000);f.receive('new');assert.equal(f.chat.jobs.size,0);assert.equal(f.store.data.settings.enabled,false);
  f.store.data.settings.enabled=true;f.store.data.settings.groups[0].enabled=false;f.receive('still-off');assert.equal(f.chat.jobs.size,0);
});
test('clearing a hold never replays buffered messages or sends on its own',async t=>{
  const f=fixture(t,{send:async()=>({status:'unconfirmed'})});f.receive('old');await f.run();f.receive('ignored');f.chat.recovery.clear('small:group');assert.equal(f.sends().length,1);assert.equal(f.chat.jobs.size,0);f.receive('ignored');assert.equal(f.chat.jobs.size,0);
});
test('model failures before sending do not alter switches or block later input',async t=>{
  let first=true;const f=fixture(t,{reply:async()=>{if(first){first=false;throw Error('模型暂时不可用');}return {should_reply:true,reply:'恢复了',remember:[]};}});
  f.receive();await f.run();assert.equal(f.chat.recovery.get('small:group'),undefined);f.receive('next');await f.run();assert.equal(f.sends().length,1);assert.equal(f.store.data.settings.groups[0].enabled,true);
});
test('cancelled batches with uncertain parts still require review',()=>{
  const result={status:'cancelled',code:'USER_TAKEOVER',parts:[{index:0,text:'一',status:'unconfirmed'}]};assert.equal(deliveryFailure(result,deliveryResult(result,['一','二'])).kind,'review');
  const safe={status:'cancelled',code:'USER_TAKEOVER',parts:[{index:0,text:'一',status:'confirmed'}]};assert.equal(deliveryFailure(safe,deliveryResult(safe,['一','二'])).kind,'waiting');
});
test('blocked tails are known unsent but malformed acknowledgements stay uncertain',()=>{
  const result={status:'partial',parts:[{index:0,text:'一',status:'confirmed'},{index:1,text:'二',status:'blocked',code:'HUMAN_DRAFT'}]};
  assert.equal(deliveryFailure(result,deliveryResult(result,['一','二'])).kind,'waiting');
  assert.equal(deliveryFailure({status:'confirmed'},deliveryResult({status:'confirmed'},['一','二'])).kind,'review');
});
test('private transport failure does not turn off the automatic reply switch',async t=>{
  const f=fixture(t,{send:async()=>({status:'blocked',code:'BG_ACCESSIBILITY'})});f.receive('private',{chatId:'friend',chatType:'private'});await f.run();assert.equal(f.store.data.settings.enabled,true);assert.equal(f.chat.recovery.get('small:friend').kind,'waiting');
});
test('bridge RPC errors retain their typed error code',async()=>{
  let child;const spawn=()=>{child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new Writable({write(chunk,encoding,done){const request=JSON.parse(chunk.toString());queueMicrotask(()=>child.stdout.write(JSON.stringify(request.method==='status'?{id:request.id,ok:true,result:{available:true}}:{id:request.id,ok:false,error:'上一条待核对',code:'NEEDS_REVIEW'})+'\n'));done();}});return child;};
  const client=new BridgeClient({root:process.cwd(),python:'mock',spawnImpl:spawn});await client.connect();await assert.rejects(client.call('send'),error=>error.code==='NEEDS_REVIEW');child.stdout.end();child.stderr.end();
});

function repairFixture(t,{enabled=true,doctor}={}){
  const f=fixture(t),calls=[];f.store.data.settings.enabled=enabled;
  f.chat.model.connect=async()=>{};f.chat.model.status=()=>({authenticated:true});
  f.chat.bridge.call=async(method,args)=>{calls.push({method,args});if(method==='doctor')return doctor?doctor():{accountId:'small',available:true,controls:{ready:true,messagesSent:0,textInputsWritten:0}};return {};};
  f.chat.recovery.hold({routeKey:'small:group',accountId:'small',chatId:'group',group:true},{kind:'attention',code:'ACCOUNT_CHANGED',reason:'旧窗口'});
  return {...f,repairCalls:calls};
}
test('repair reconnects, verifies real controls, and restores listening without replaying queued messages',async t=>{
  const f=repairFixture(t);f.chat.recovery.clear('small:group');f.receive('old-buffered');
  f.chat.recovery.hold({routeKey:'small:group',accountId:'small',chatId:'group',group:true},{kind:'attention',code:'ACCOUNT_CHANGED'});
  const selection=JSON.stringify(f.store.data.settings.groups),result=await f.chat.repairConnection('group');
  assert.deepEqual(f.repairCalls.map(x=>x.method),['stop','bind','doctor','bind','start']);
  assert(f.repairCalls.filter(x=>x.method==='bind').every(x=>x.args.accountId==='small'&&x.args.targets.some(y=>y.chatId==='group')));
  assert.equal(result.reconnected,true);assert.equal(result.resent,false);assert.equal(f.store.data.settings.enabled,true);
  assert.equal(f.chat.jobs.size,0);assert.equal(f.chat.recovery.get('small:group'),undefined);assert.equal(JSON.stringify(f.store.data.settings.groups),selection);
});
test('repair refuses unreadable controls or a different account and leaves the hold intact',async t=>{
  for(const checked of [{accountId:'other',available:true,controls:{ready:true}},{accountId:'small',available:true,controls:{ready:false}}]){
    const f=repairFixture(t,{doctor:()=>checked});await assert.rejects(f.chat.repairConnection('group'));
    assert.equal(f.store.data.settings.enabled,false);assert(f.chat.recovery.get('small:group'));assert(!f.repairCalls.some(x=>x.method==='start'));
  }
});
test('an explicit pause during reconnect wins over restoring the previous enabled state',async t=>{
  let release;const waiting=new Promise(r=>release=r);const f=repairFixture(t,{doctor:()=>waiting});
  const repairing=f.chat.repairConnection('group');while(!f.repairCalls.some(x=>x.method==='doctor'))await new Promise(r=>setImmediate(r));
  await f.chat.pause();release({accountId:'small',available:true,controls:{ready:true}});await assert.rejects(repairing,/暂停状态/);
  assert.equal(f.store.data.settings.enabled,false);assert(!f.repairCalls.some(x=>x.method==='start'));assert(f.chat.recovery.get('small:group'));
});
test('repair rechecks pending sends after stopping and does not acknowledge uncertainty',async t=>{
  const f=repairFixture(t);await assert.rejects(f.chat.repairConnection('group',()=>{throw Error('仍需核对');}),/仍需核对/);
  assert.deepEqual(f.repairCalls.map(x=>x.method),['stop','stop']);assert(f.chat.recovery.get('small:group'));
});
test('repair preserves a manual off and only releases same-account window-change holds',async t=>{
  const f=repairFixture(t,{enabled:false});
  for(const [accountId,chatId,kind,code] of [['small','friend','attention','ACCOUNT_CHANGED'],['small','conflict','attention','TARGET_MISMATCH'],['small','uncertain','review','ACCOUNT_CHANGED'],['other','friend','attention','ACCOUNT_CHANGED']])f.chat.recovery.hold({routeKey:accountId+':'+chatId,accountId,chatId},{kind,code});
  const result=await f.chat.repairConnection('group');assert.equal(result.resumed,false);assert.equal(f.store.data.settings.enabled,false);
  assert(!f.repairCalls.some(x=>x.method==='start'));assert.equal(f.chat.recovery.get('small:friend'),undefined);
  for(const key of ['small:conflict','small:uncertain','other:friend'])assert(f.chat.recovery.get(key));
});
