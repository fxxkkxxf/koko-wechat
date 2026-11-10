// Event-driven group participation only: no timer, idle opener or private ping.
export const PROACTIVE_DEFAULTS = {proactiveIntervalSeconds:120,proactiveMaxPerHour:3};
export const DECISION_INTERVAL_MS = 20_000;
export function proactiveLimits(group={}){
  const interval=group.proactiveIntervalSeconds,maximum=group.proactiveMaxPerHour;
  return {intervalMs:(Number.isInteger(interval)&&interval>=30&&interval<=3600?interval:120)*1000,
    maxPerHour:Number.isInteger(maximum)&&maximum>=1&&maximum<=20?maximum:3};
}
export function usefulGroupTopic(text){
  const value=String(text||'').trim();
  if(!value||/^(?:\[(?:图片|动画表情|表情|语音|视频)\]|哈+|[嗯哦噢啊额呃]+|确实|同意|收到|好[的吧啊]?|对[啊呀]?|[6１1]+)[！!。.?？～~\s]*$/u.test(value))return false;
  return (value.match(/[\p{L}\p{N}]/gu)||[]).length>=3;
}
const rowFor=(store,key)=>store.data.groupParticipation?.[key]||{};
const attempts=(row,now)=>Array.isArray(row.attempts)?row.attempts.filter(at=>Number.isFinite(at)&&at>now-3_600_000):[];
export function participationGate(store,key,group,now,{decision=true}={}){
  const row=rowFor(store,key),times=attempts(row,now),limits=proactiveLimits(group);
  if(times.length>=limits.maxPerHour)return {ok:false,reason:'hour_limit',message:'本群主动搭话已到每小时上限，先旁听'};
  if(times.some(at=>now-at<limits.intervalMs))return {ok:false,reason:'interval',message:'距上次主动搭话还太近，先旁听'};
  if(decision&&Number.isFinite(row.consideredAt)&&now-row.consideredAt<DECISION_INTERVAL_MS)return {ok:false,reason:'decision_cooldown',message:'刚判断过这段话题，暂不重复调用模型'};
  return {ok:true};
}
export function recordParticipation(store,key,now,{attempt=false}={}){
  const previous=rowFor(store,key);
  const row={...previous,attempts:[...attempts(previous,now),...(attempt?[now]:[])].slice(-64),updatedAt:now};
  if(!attempt)row.consideredAt=now;
  const all={...(store.data.groupParticipation||{}),[key]:row};
  store.data.groupParticipation=Object.fromEntries(Object.entries(all).filter(([,value])=>value&&Number.isFinite(value.updatedAt)&&now-value.updatedAt<=86_400_000)
    .sort((a,b)=>b[1].updatedAt-a[1].updatedAt).slice(0,120));
  store.save();
}

export const PROACTIVE_INSTRUCTION='本次是没有被点名时的主动搭话判断。先看整个当前群的话题和最新几条消息，只在能补充有用信息、自然接梗或回应面向全群的问题时加入；默认可以安静旁听。不要为了出现而复述、硬转话题、没话找话或连续附和。别人一对一聊天、只发图片或表情、争执敏感或缺少背景时优先should_reply=false。messages里的sender_id各不相同，要保留各自身份，不能混成一个人的话。若加入，只接当前话题，说一两句自然短话，不假装被提问，不称自己定时来打招呼，也不要假装有线下经历。';
