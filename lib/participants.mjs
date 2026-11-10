import {normalizeGroup} from './groups.mjs';

const idOK = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\s\x00-\x1f\x7f]/u.test(value);
const list = value => Array.isArray(value) ? value : [];
const name = value => typeof value === 'string' ? value.slice(0,160) : '';

// contacts[] is authoritative once migrated, including an intentionally empty
// selection. chatId remains a legacy primary identity, not an implicit grant.
export function selectedContacts(settings={}){
  const rows=Array.isArray(settings.contacts)?settings.contacts:
    (settings.chatId?[{chatId:settings.chatId,name:settings.expectedChatName||'',enabled:true}]:[]);
  const seen=new Set();
  return rows.filter(row=>row&&row.enabled!==false&&idOK(row.chatId)&&!row.chatId.endsWith('@chatroom')&&!seen.has(row.chatId)&&seen.add(row.chatId))
    .map(row=>({chatId:row.chatId,name:name(row.name),enabled:true}));
}

export function normalizeParticipants(input,{settings={},directory}={}){
  if(!input||typeof input!=='object'||Array.isArray(input)||!Array.isArray(input.participants))throw Error('请选择参与的联系人和群聊');
  if(!directory||!Array.isArray(directory.items)||directory.accountId!==settings.accountId)throw Error('会话目录已失效，请重新读取当前小号的目录');
  if(input.participants.length>30)throw Error('最多同时接入30个会话');
  const available=new Map(directory.items.map(row=>[row.chatId||row.id,row]));
  const selected=new Map();
  for(const row of input.participants){
    if(!row||typeof row!=='object'||Array.isArray(row)||!idOK(row.chatId)||!['private','group'].includes(row.type))throw Error('会话选择格式无效');
    if(selected.has(row.chatId))throw Error('会话重复，请刷新后重新选择');
    const actual=available.get(row.chatId);
    if(!actual||actual.type!==row.type||(row.type==='group')!==row.chatId.endsWith('@chatroom')||row.chatId===settings.accountId)throw Error('所选会话不在当前小号可用目录中，请刷新后重新选择');
    selected.set(row.chatId,{...row,name:name(actual.name)});
  }
  const picked=[...selected.values()];
  if(picked.filter(x=>x.type==='private').length>20)throw Error('最多同时接入20个私聊');
  if(picked.filter(x=>x.type==='group').length>10)throw Error('最多同时接入10个群聊');
  const oldContacts=Array.isArray(settings.contacts)?settings.contacts:selectedContacts(settings);
  const contacts=new Map();
  for(const old of oldContacts){
    if(old&&idOK(old.chatId)&&!old.chatId.endsWith('@chatroom'))contacts.set(old.chatId,{chatId:old.chatId,name:name(old.name),enabled:false});
  }
  const groups=new Map();
  for(const old of list(settings.groups)){
    if(old&&idOK(old.chatId)&&old.chatId.endsWith('@chatroom'))groups.set(old.chatId,normalizeGroup({chatId:old.chatId,enabled:false},old));
  }
  for(const row of picked){
    if(row.type==='private')contacts.set(row.chatId,{chatId:row.chatId,name:row.name,enabled:true});
    else groups.set(row.chatId,normalizeGroup({chatId:row.chatId,name:row.name,enabled:true},groups.get(row.chatId)));
  }
  return {contacts:[...contacts.values()],groups:[...groups.values()]};
}
