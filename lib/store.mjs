import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {GROUP_PERSONA} from './chat.mjs';
export const readJSON=(file,fallback)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fallback;}};
export function writeJSON(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+crypto.randomBytes(5).toString('hex')+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2),'utf8');fs.renameSync(temp,file);}
export class Store {
  constructor(directory,persona=''){this.file=path.join(directory,'state.json');this.data=readJSON(this.file,{settings:{enabled:false,persona,accountId:'',chatId:'',expectedAccountName:'',expectedChatName:'',groups:[],groupPersona:GROUP_PERSONA},events:[],conversations:[],memory:[],seen:[],contexts:{}});for(const key of ['events','conversations','memory','seen'])this.data[key]??=[];if(!this.data.contexts||typeof this.data.contexts!=='object'||Array.isArray(this.data.contexts))this.data.contexts={};this.data.settings={enabled:false,persona,accountId:'',chatId:'',expectedAccountName:'',expectedChatName:'',groups:[],groupPersona:GROUP_PERSONA,...this.data.settings};if(!Array.isArray(this.data.settings.groups))this.data.settings.groups=[];}
  save(){writeJSON(this.file,this.data);}
  event(kind,message,extra={}){const x={id:crypto.randomUUID(),at:Date.now(),kind,message,...extra};this.data.events.unshift(x);this.data.events=this.data.events.slice(0,150);this.save();return x;}
  message(sessionKey,role,text,extra={}){this.data.conversations.push({id:crypto.randomUUID(),at:Date.now(),sessionKey,role,text,...extra});const count=this.data.conversations.filter(x=>x.sessionKey===sessionKey).length;let skip=Math.max(0,count-200);this.data.conversations=this.data.conversations.filter(x=>x.sessionKey!==sessionKey||skip--<=0).slice(-2000);this.save();}
  history(key,{excludeEventIds=[],limit=16}={}){const excluded=new Set(excludeEventIds);return this.data.conversations.filter(x=>x.sessionKey===key&&['user','assistant'].includes(x.role)&&(!x.delivery||x.delivery==='confirmed')&&!excluded.has(x.eventId)).slice(-limit).map(row=>({role:row.role,content:row.chatType==='group'?JSON.stringify(row.role==='user'?{kind:'group_message',sender_id:row.senderId,name:row.senderName,text:row.text}:{kind:'group_reply',reply_to:{sender_id:row.replyToSenderId,name:row.replyToSenderName},text:row.text}):row.text}));}
  seen(id){if(this.data.seen.includes(id))return true;this.data.seen.push(id);this.data.seen=this.data.seen.slice(-2000);this.save();return false;}
}
