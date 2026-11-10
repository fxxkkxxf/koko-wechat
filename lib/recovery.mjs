// Desired participation is a user setting. Transport health is separate state.
const ATTENTION=new Set(['ACCOUNT_CHANGED','TARGET_MISMATCH','PRIVATE_CHANGED','AMBIGUOUS_PRIVATE','AMBIGUOUS_GROUP','NOT_GROUP_MEMBER','INVALID_SEND_MODE']);
export function deliveryFailure(result,delivery){
  if(delivery.confirmed)return null;
  if(delivery.parts.some(p=>p.status==='unconfirmed')||['unconfirmed','sending'].includes(result?.status)||result?.code==='NEEDS_REVIEW')return {kind:'review',code:result?.code||'UNCERTAIN_SEND',reason:result?.message||'发送结果尚未确认，请核对后继续'};
  const blocked=delivery.parts.find(p=>p.status==='blocked');
  if(result?.status==='blocked'||blocked||delivery.cancelled){
    const code=result?.code||blocked?.code||'SEND_BLOCKED';
    return {kind:ATTENTION.has(code)?'attention':'waiting',code,reason:result?.message||blocked?.message||'本次未发送，稍后处理新来信'};
  }
  return {kind:'review',code:'UNCERTAIN_SEND',reason:'未取得完整发送确认，请核对后继续'};
}
export class Recovery {
  constructor(store,now=()=>Date.now()){this.store=store;this.now=now;if(!store.data.deliveryRecovery||typeof store.data.deliveryRecovery!=='object'||Array.isArray(store.data.deliveryRecovery))store.data.deliveryRecovery={};}
  get(key){return this.store.data.deliveryRecovery[key];}
  blocked(key){const row=this.get(key);return Boolean(row&&(row.kind!=='waiting'||row.until>this.now()));}
  hold(job,failure){
    const prior=this.get(job.routeKey),attempts=Math.min(8,(prior?.attempts||0)+1),seconds=Math.min(300,15*2**(attempts-1));
    const row={...failure,accountId:job.accountId,chatId:job.chatId,chatName:job.chatName,chatType:job.group?'group':'private',attempts,at:this.now(),until:failure.kind==='waiting'?this.now()+seconds*1000:null};
    this.store.data.deliveryRecovery[job.routeKey]=row;this.store.save();return row;
  }
  clear(key){if(!this.get(key))return false;delete this.store.data.deliveryRecovery[key];this.store.save();return true;}
  snapshot(){return Object.values(this.store.data.deliveryRecovery).map(row=>({...row,ready:row.kind==='waiting'&&row.until<=this.now()}));}
}
