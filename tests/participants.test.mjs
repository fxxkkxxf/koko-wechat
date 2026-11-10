import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedContacts,normalizeParticipants} from '../lib/participants.mjs';

const settings={accountId:'small',chatId:'owner',expectedChatName:'主人',groups:[{chatId:'old@chatroom',name:'旧群',mode:'mention',enabled:true,aliases:['可可'],cooldownSeconds:17,followupSeconds:60}]};
const directory={accountId:'small',items:[{chatId:'owner',type:'private',name:'真实主人'},{chatId:'friend',type:'private',name:'新朋友'},{chatId:'old@chatroom',type:'group',name:'群新名'},{chatId:'new@chatroom',type:'group',name:'新群'}]};

test('legacy primary migrates, explicit empty or disabled contact selection never silently readds it',()=>{
 assert.deepEqual(selectedContacts(settings),[{chatId:'owner',name:'主人',enabled:true}]);
 assert.deepEqual(selectedContacts({...settings,contacts:[]}),[]);
 assert.deepEqual(selectedContacts({...settings,contacts:[{chatId:'owner',enabled:false}]}),[]);
});
test('batch selection activates exactly chosen contacts and groups while preserving disabled policies',()=>{
 const out=normalizeParticipants({participants:[{chatId:'friend',type:'private'},{chatId:'new@chatroom',type:'group'}]},{settings,directory});
 assert.deepEqual(out.contacts,[{chatId:'owner',name:'主人',enabled:false},{chatId:'friend',name:'新朋友',enabled:true}]);
 assert.equal(out.groups.find(x=>x.chatId==='old@chatroom').enabled,false);
 assert.equal(out.groups.find(x=>x.chatId==='old@chatroom').cooldownSeconds,17);
 assert.equal(out.groups.find(x=>x.chatId==='new@chatroom').mode,'addressed');
});
test('reselecting a disabled group keeps its explicit policy but uses the true directory name',()=>{
 const cfg={...settings,groups:settings.groups.map(x=>({...x,enabled:false}))};
 const out=normalizeParticipants({participants:[{chatId:'old@chatroom',type:'group',name:'fake',mode:'smart'}]},{settings:cfg,directory});
 assert.equal(out.groups[0].enabled,true);assert.equal(out.groups[0].name,'群新名');assert.equal(out.groups[0].mode,'mention');assert.deepEqual(out.groups[0].aliases,['可可']);
});
test('a different account, unknown ID, duplicates and forged types are rejected',()=>{
 for(const participants of [[{chatId:'stranger',type:'private'}],[{chatId:'owner',type:'group'}],[{chatId:'owner',type:'private'},{chatId:'owner',type:'private'}]])assert.throws(()=>normalizeParticipants({participants},{settings,directory}));
 assert.throws(()=>normalizeParticipants({participants:[]},{settings,directory:{...directory,accountId:'other'}}));
});
test('empty selection is valid and preserves former choices as disabled',()=>{
 const out=normalizeParticipants({participants:[]},{settings,directory});
 assert.equal(out.contacts[0].enabled,false);assert.equal(out.groups[0].enabled,false);
});
test('private and group selection caps bound the bridge workload',()=>{
 for(const [count,type] of [[21,'private'],[11,'group']]){
  const participants=Array.from({length:count},(_,i)=>({chatId:`id${i}${type==='group'?'@chatroom':''}`,type}));
  assert.throws(()=>normalizeParticipants({participants},{settings,directory:{accountId:'small',items:participants}}));
 }
});
