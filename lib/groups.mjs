import {PROACTIVE_DEFAULTS} from './proactive.mjs';

export function normalizeGroup(input,previous={}){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('群设置格式错误');
  const chatId=input.chatId??previous.chatId;
  if(typeof chatId!=='string'||!chatId.endsWith('@chatroom')||chatId.length>160)throw Error('请选择有效的微信群');
  const mode=input.mode??previous.mode??'addressed';
  if(!['mention','addressed','smart'].includes(mode))throw Error('群回复方式无效');
  const enabled=input.enabled??previous.enabled??true;
  if(typeof enabled!=='boolean')throw Error('群开关格式错误');
  const cooldownSeconds=input.cooldownSeconds??previous.cooldownSeconds??8;
  const followupSeconds=input.followupSeconds??previous.followupSeconds??90;
  const proactiveIntervalSeconds=input.proactiveIntervalSeconds??previous.proactiveIntervalSeconds??PROACTIVE_DEFAULTS.proactiveIntervalSeconds;
  const proactiveMaxPerHour=input.proactiveMaxPerHour??previous.proactiveMaxPerHour??PROACTIVE_DEFAULTS.proactiveMaxPerHour;
  const proactiveBaseMode=mode==='smart'?(input.proactiveBaseMode??(previous.mode&&previous.mode!=='smart'?previous.mode:previous.proactiveBaseMode)??'addressed'):mode;
  if(!Number.isInteger(cooldownSeconds)||cooldownSeconds<3||cooldownSeconds>120)throw Error('群回复间隔需为3—120秒');
  if(!Number.isInteger(followupSeconds)||followupSeconds<15||followupSeconds>600)throw Error('群内接话窗口需为15—600秒');
  if(!Number.isInteger(proactiveIntervalSeconds)||proactiveIntervalSeconds<30||proactiveIntervalSeconds>3600)throw Error('主动搭话间隔需为30—3600秒');
  if(!Number.isInteger(proactiveMaxPerHour)||proactiveMaxPerHour<1||proactiveMaxPerHour>20)throw Error('每小时主动搭话上限需为1—20次');
  if(!['mention','addressed'].includes(proactiveBaseMode))throw Error('关闭主动搭话后的规则无效');
  const aliases=input.aliases??previous.aliases??[];
  if(!Array.isArray(aliases)||aliases.length>10||aliases.some(x=>typeof x!=='string'||!x.trim()||x.length>40||/[\r\n@]/.test(x)))throw Error('称呼最多10个，每个1—40字，不含@和换行');
  return {chatId,name:String(input.name??previous.name??'').slice(0,160),mode,enabled,cooldownSeconds,followupSeconds,proactiveIntervalSeconds,proactiveMaxPerHour,proactiveBaseMode,aliases:[...new Set(aliases.map(x=>x.trim()))]};
}

export function toggleGroupProactive(group,enabled){
  if(!group)throw Error('群尚未接入，请先在参与会话中选择');
  if(typeof enabled!=='boolean')throw Error('主动搭话开关格式错误');
  return normalizeGroup({chatId:group.chatId,mode:enabled?'smart':group.mode==='smart'?group.proactiveBaseMode||'addressed':group.mode},group);
}
