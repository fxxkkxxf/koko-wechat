import test from 'node:test';
import assert from 'node:assert/strict';
import {ChatController} from '../lib/chat.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,{reply,groups=[]}={}){
  const data={settings:{enabled:true,accountId:'small',chatId:'friend',contacts:[{chatId:'friend',enabled:true}],groups,persona:'公开角色',webSearchEnabled:false},events:[],conversations:[],memory:[]},seen=new Set(),calls=[],requests=[];
  const store={data,save(){},seen(id){if(seen.has(id))return true;seen.add(id);return false;},history(){return [];},message(sessionKey,role,text,extra){data.conversations.push({sessionKey,role,text,...extra});},event(kind,message,extra={}){const row={kind,message,...extra};data.events.push(row);return row;}};
  const model={reply:async options=>{requests.push(options);return reply?reply(options):{should_reply:true,reply:'我看到了这张图',remember:[],search_query:''};},resetSessions(){}};
  const bridge={call:async(method,args)=>{calls.push({method,args});return {status:'confirmed'};}};
  const chat=new ChatController({store,model,bridge,delay:3600000});
  t.after(()=>{for(const job of chat.jobs.values()){clearTimeout(job.timer);job.abort.abort();}});
  const receive=(id,text,extra={})=>{chat.receive({id,text,accountId:'small',chatId:'friend',senderId:'friend',senderName:'朋友',...extra});for(const job of chat.jobs.values())clearTimeout(job.timer);};
  const run=async(key='small:friend')=>{const job=chat.jobs.get(key);assert(job);return chat.run(job);};
  return {chat,data,calls,requests,receive,run};
}
const image={path:'C:/PRIVATE-PATH-SENTINEL/design.png',mimeType:'image/png',source:'thumbnail'};

test('picture read status survives source/history and only a resolved native model reply is marked returned',async t=>{
  let resolveReply;const f=fixture(t,{reply:()=>new Promise(resolve=>resolveReply=resolve)});
  f.receive('pic','[图片]',{images:[image]});
  const received=f.data.events.find(x=>x.kind==='received');
  assert.deepEqual(received.sourceMessages[0].image,{status:'ready',count:1,failedCount:0,sources:['thumbnail']});
  assert.equal(received.image.modelStatus,'not_submitted');
  assert.equal(f.data.conversations[0].image.status,'ready');
  const pending=f.run();while(!resolveReply)await tick();
  assert.equal(f.chat.snapshot().image.modelStatus,'submitting');
  assert.equal(received.image.modelStatus,'not_submitted','earlier snapshots must not be mutated by later processing');
  assert.equal(f.data.events.some(x=>x.image?.modelStatus==='response_received'),false);
  resolveReply({should_reply:true,reply:'图里有两块配色',remember:[],search_query:''});await pending;
  const sent=f.data.events.find(x=>x.kind==='sent');assert.equal(sent.image.modelStatus,'response_received');
  assert.deepEqual(f.requests[0].images,[image]);
  assert.equal(f.data.conversations.at(-1).image.modelStatus,'response_received');
  assert(!JSON.stringify({events:f.data.events,history:f.data.conversations}).includes('PRIVATE-PATH-SENTINEL'));
});

test('image extraction failure is visible and private diagnostic details never enter history or model text',async t=>{
  const f=fixture(t);f.receive('unread','[图片]',{attachmentError:'图片缓存未下载 C:\\PRIVATE-PATH-SENTINEL\\some folder\\image.png Bearer SECRET wxid_secret'});await f.run();
  const received=f.data.events.find(x=>x.kind==='received');assert.equal(received.image.status,'failed');
  assert.match(received.image.reason,/图片缓存未下载/);assert.match(received.image.reason,/本机路径已隐藏/);
  assert.deepEqual(f.requests[0].images,[]);assert.match(f.requests[0].text,/应用未能读取部分图片/);
  assert(!JSON.stringify({events:f.data.events,history:f.data.conversations,requests:f.requests}).includes('PRIVATE-PATH-SENTINEL'));
  assert(!JSON.stringify(f.data.events).includes('Bearer SECRET'));assert(!JSON.stringify(f.data.events).includes('wxid_secret'));
});

test('a bare picture placeholder is treated as missing image bytes, never image recognition success',async t=>{
  const f=fixture(t);f.receive('placeholder','[图片]');await f.run();
  assert.equal(f.data.events.find(x=>x.kind==='received').image.status,'failed');
  assert.match(f.requests[0].text,/只传来了图片占位/);assert.match(f.requests[0].text,/不能猜图中细节/);
  assert.deepEqual(f.requests[0].images,[]);assert.equal(f.data.events.some(x=>x.image?.modelStatus==='response_received'),false);
});

test('model attachment rejection is shown separately from cache read success and cannot send a false answer',async t=>{
  const f=fixture(t,{reply:async()=>{throw Object.assign(Error('图片文件不可用 C:/PRIVATE-PATH-SENTINEL/image.png'),{code:'IMAGE_UNAVAILABLE'});}});
  f.receive('disappeared','[图片]',{images:[image]});await f.run();
  const failure=f.data.events.find(x=>x.kind==='error');
  assert.equal(failure.image.status,'ready');assert.equal(failure.image.modelStatus,'failed');assert.equal(failure.image.modelErrorCode,'IMAGE_UNAVAILABLE');
  assert(!failure.image.modelError.includes('PRIVATE-PATH-SENTINEL'));
  assert(!JSON.stringify(f.data.events).includes('PRIVATE-PATH-SENTINEL'));
  assert.equal(f.calls.some(x=>x.method==='send'||x.method==='send_batch'),false);
});

test('unaddressed group images expose read status without invoking a model and follow-up keeps their source metadata',async t=>{
  const group={chatId:'design@chatroom',name:'设计群',enabled:true,mode:'addressed',aliases:['可可'],cooldownSeconds:0};
  const f=fixture(t,{groups:[group]});
  f.receive('group-pic','[图片]',{chatId:group.chatId,chatType:'group',senderId:'alice',images:[image]});
  assert.equal(f.requests.length,0);assert.equal(f.chat.jobs.size,0);
  const first=f.data.events.find(x=>x.kind==='received');assert.equal(first.image.modelStatus,'not_submitted');assert.equal(first.sourceMessages[0].image.status,'ready');
  f.receive('caption','可可，看看这张图',{chatId:group.chatId,chatType:'group',senderId:'alice'});await f.run('small:design@chatroom:member:alice');
  assert.deepEqual(f.requests[0].images,[image]);
  const sent=f.data.events.find(x=>x.kind==='sent');assert.equal(sent.sourceMessages[0].eventId,'group-pic');assert.equal(sent.sourceMessages[0].image.sources[0],'thumbnail');
  assert.equal(sent.image.modelStatus,'response_received');
});
