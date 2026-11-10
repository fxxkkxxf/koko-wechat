import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MemoryEngine} from '../lib/memory.mjs';
import {Store} from '../lib/store.mjs';

const route='account:group@chatroom',person=route+':member:alice';
function rig({model,limits}={}){
  let now=1000000;const store={data:{memory:[],conversations:[],contexts:{}},save(){},event(){}};
  const resets=[];const m=model||{resetSessions(key){resets.push(key);},async reply(){return {reply:'同一会话旧话题的摘要。',should_reply:true,remember:[]};}};
  const engine=new MemoryEngine({store,model:m,now:()=>now,limits});let id=0;
  const add=(key,text,extra={})=>store.data.conversations.push({id:'row-'+ ++id,at:++now,sessionKey:key,role:'user',text,...extra});
  return {engine,store,resets,add,advance:n=>now+=n};
}

test('context recalls only same scoped member facts and same group public history',()=>{
  const r=rig();r.store.data.memory=[{sessionKey:person,text:'喜欢咖啡',at:1},{sessionKey:route+':member:bob',text:'喜欢咖啡的秘密',at:2},{sessionKey:'account:private',text:'私聊资料',at:3}];
  r.add(route,'甲说的话',{chatType:'group',senderId:'alice',senderName:'同名'});r.add(route,'乙说的话',{chatType:'group',senderId:'bob',senderName:'同名'});r.add('account:private','私聊原文');
  const out=r.engine.context({routeKey:route,sessionKey:person,query:'咖啡'});
  assert.deepEqual(out.memory,['喜欢咖啡']);assert.equal(out.history.length,2);
  assert.equal(JSON.parse(out.history[0].content).sender_id,'alice');assert.equal(JSON.parse(out.history[1].content).sender_id,'bob');
  assert.ok(!JSON.stringify(out).includes('私聊'));
});

test('large group history is bounded without breaking sender-bearing JSON',()=>{
  const r=rig();for(let i=0;i<20;i++)r.add(route,'很长的文字'.repeat(3000),{chatType:'group',senderId:'alice',senderName:'甲'});
  const out=r.engine.context({routeKey:route,sessionKey:person});assert.ok(out.stats.historyChars<=8000);
  assert.equal(JSON.parse(out.history.at(-1).content).sender_id,'alice');assert.ok(out.history.length<=12);
});

test('memory suggestions are deduplicated by scope, source anchored, filtered and capped',()=>{
  const r=rig({limits:{factsPerScope:2,factsTotal:10}});
  assert.equal(r.engine.remember({sessionKey:person,routeKey:route,sourceText:'我喜欢咖啡，爱喝拿铁，也爱打球',facts:['喜欢咖啡','爱喝拿铁','爱打球','密码是123456','完全没说过的旅行计划']}),3);
  assert.equal(r.store.data.memory.length,2);
  assert.equal(r.engine.remember({sessionKey:person,routeKey:route,facts:['爱打球']}),0);
  assert.equal(r.engine.remember({sessionKey:route+':member:bob',routeKey:route,facts:['爱打球']}),1);
  assert.ok(r.store.data.memory.every(x=>x.id&&x.routeKey===route));
});

test('lexical recall promotes relevant older memories over irrelevant newer ones',()=>{
  const r=rig();r.store.data.memory=[{sessionKey:person,text:'最喜欢冰拿铁咖啡',at:1},...Array.from({length:15},(_,i)=>({sessionKey:person,text:'其他兴趣'+i,at:100+i}))];
  const out=r.engine.context({routeKey:route,sessionKey:person,query:'今天喝什么咖啡'});assert.equal(out.memory[0],'最喜欢冰拿铁咖啡');assert.equal(out.memory.length,8);
});

test('low traffic never calls the model just to summarize',async()=>{
  let calls=0;const r=rig({model:{async reply(){calls++;}}});for(let i=0;i<20;i++)r.add(route,'简短消息'+i);
  assert.equal((await r.engine.maintain(route)).changed,false);assert.equal(calls,0);
});

test('threshold compaction summarizes only older messages and keeps latest twelve verbatim',async()=>{
  const requests=[];const r=rig({model:{async reply(req){requests.push(req);return {reply:'甲 [alice] 想讨论游戏，尚待选择职业。'};}}});
  for(let i=0;i<26;i++)r.add(route,'第'+i+'条',{chatType:'group',senderId:'alice',senderName:'甲'});
  const result=await r.engine.maintain(route);assert.equal(result.method,'model');assert.equal(requests.length,1);
  assert.deepEqual(requests[0].history,[]);assert.deepEqual(requests[0].memory,[]);assert.ok(!requests[0].text.includes('第25条'));
  const out=r.engine.context({routeKey:route,sessionKey:person});assert.equal(out.history.length,12);assert.match(out.summary,/alice/);assert.equal(r.engine.snapshot().summaries[0].coveredMessages,14);
});

test('failed or empty model summary produces labeled local excerpts without erasing raw records',async()=>{
  const r=rig({model:{async reply(){return {reply:'   '};}}});for(let i=0;i<26;i++)r.add(route,'第'+i+'条',{chatType:'group',senderId:'alice',senderName:'甲'});
  assert.equal((await r.engine.maintain(route)).method,'extractive');assert.equal(r.store.data.conversations.length,26);
  assert.match(r.engine.context({routeKey:route}).summary,/旧对话摘录/);assert.match(r.engine.context({routeKey:route}).summary,/alice/);
});

test('summary and fallback omit recognizable credential fragments',async()=>{
  const r=rig({model:{async reply(){throw Error('unavailable');}}});for(let i=0;i<26;i++)r.add(route,i===4?'我的密码是verysecret12345':'普通消息'+i);
  await r.engine.maintain(route);const summary=r.engine.context({routeKey:route}).summary;assert.ok(!summary.includes('verysecret'));assert.match(summary,/敏感片段/);
});

test('summary jobs are single flight and deletion invalidates late results',async()=>{
  let finish,calls=0;const r=rig({model:{async reply(){calls++;return new Promise(resolve=>finish=resolve);},resetSessions(){}}});for(let i=0;i<26;i++)r.add(route,'消息'+i);
  const a=r.engine.maintain(route),b=r.engine.maintain(route);assert.equal(a,b);assert.equal(calls,1);
  r.engine.clear({routeKey:route});finish({reply:'旧摘要不应回来'});assert.equal((await a).reason,'invalidated');assert.equal(r.engine.snapshot().summaries.length,0);
  assert.deepEqual(r.engine.context({routeKey:route}).history,[]);assert.equal(r.store.data.conversations.length,26);
});

test('scoped clear leaves other chats intact and does not resurrect pre-clear history',()=>{
  const r=rig();r.add(route,'旧消息');r.add('account:private','其他私聊');r.engine.remember({sessionKey:person,routeKey:route,facts:['喜欢咖啡']});r.engine.remember({sessionKey:'account:private',facts:['喜欢茶']});
  r.engine.clear({routeKey:route});assert.equal(r.store.data.memory.length,1);assert.equal(r.store.data.memory[0].text,'喜欢茶');assert.equal(r.engine.context({routeKey:route}).history.length,0);
  r.add(route,'清理后的新消息');assert.equal(r.engine.context({routeKey:route}).history.length,1);
});

test('deleting a fact preserves unrelated facts and resets remote scope',()=>{
  const r=rig();r.engine.remember({sessionKey:person,routeKey:route,facts:['喜欢咖啡','喜欢茶']});const id=r.store.data.memory[0].id;
  r.engine.remove(id);assert.deepEqual(r.store.data.memory.map(x=>x.text),['喜欢茶']);assert.equal(r.resets.at(-1),route);assert.throws(()=>r.engine.remove(id),/不存在/);
});

test('deleting a fact invalidates paraphrased summaries and prevents old history reintroducing it',async()=>{
  const r=rig();r.engine.remember({sessionKey:person,routeKey:route,facts:['喜欢咖啡','喜欢茶']});
  for(let i=0;i<26;i++)r.add(route,'我特别喜欢浓缩和拿铁'+i);
  r.store.data.contexts[route]={text:'甲爱喝意式饮品',revision:2};
  const id=r.store.data.memory[0].id;r.engine.remove(id);
  const out=r.engine.context({routeKey:route,sessionKey:person});assert.equal(out.summary,'');assert.deepEqual(out.history,[]);assert.deepEqual(out.memory,['喜欢茶']);
  assert.equal((await r.engine.maintain(route,{force:true})).changed,false);assert.equal(r.store.data.conversations.length,26);
});

test('summary request remains valid structured JSON for large escaped rows and metadata',async()=>{
  const requests=[];const r=rig({model:{async reply(req){requests.push(req);return {reply:'旧话题摘要'};}}});
  for(let i=0;i<26;i++)r.add(route,'\u0000'.repeat(10000),{chatType:'group',senderId:'\u0000'.repeat(3000),senderName:'\u0000'.repeat(10000)});
  await r.engine.maintain(route);assert.equal(requests.length,1);assert.ok(requests[0].text.length<=19000);
  const payload=JSON.parse(requests[0].text.slice(requests[0].text.indexOf('\n')+1));assert.ok(payload.messages.length);assert.ok(payload.messages[0].sender_id.length<=256);
});

test('legacy facts get stable identifiers and persistent summary survives restart',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'koko-memory-'));
  try{
    const a=new Store(directory,'role');a.data.memory=[{sessionKey:'account:private',text:'旧记忆',at:1}];a.save();
    const engine=new MemoryEngine({store:a});const id=a.data.memory[0].id;
    for(let i=0;i<26;i++)a.message('account:private','user','消息'+i);
    await engine.maintain('account:private');
    const b=new Store(directory,'role'),again=new MemoryEngine({store:b});
    assert.equal(b.data.memory[0].id,id);assert.equal(again.snapshot().summaries.length,1);assert.match(again.context({routeKey:'account:private'}).summary,/旧对话摘录/);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
