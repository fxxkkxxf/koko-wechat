import {searchPublicWeb} from './public-web.mjs';
import {lookupWeather} from './weather.mjs';
import {parseWeatherRequest,cityFromFollowup} from './weather-intent.mjs';
import {withAbort} from './abort.mjs';

export function searchQuery(text){
  if(typeof text!=='string')return '';
  const cleaned=text.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,'').replace(/@[\p{L}\p{N}_-]+/gu,'').replace(/\bwxid_[a-z0-9]+\b/gi,'').replace(/(?:\+?86[- ]?)?1[3-9]\d{9}/g,'').replace(/\b(?:sk-|Bearer\s+)\S+/gi,'').replace(/https?:\/\/[^\s<>"'，。；！？、]+/gu,url=>{try{const u=new URL(url);return decodeURI(u.origin+u.pathname);}catch{return '';}}).replace(/\s+/g,' ').trim()
    .replace(/^(?:(?:可可|鱼神)[，,:：\s]*)?/u,'').replace(/^(?:(?:请|麻烦|帮我|帮忙|能不能|给我|联网|上网|查一下|查查|搜索一下|搜索|搜一下|搜一搜)[，,:：\s]*)+/u,'').replace(/[，,。；;]?\s*请?(?:附上?|给出|提供).{0,8}(?:来源|链接|网址|出处).*$/u,'').replace(/(?:是什么|是谁|的资料|的介绍)[？?。!！]*$/u,'').trim();
  return cleaned.length>240?'':cleaned;
}
export function needsSearch(text){return typeof text==='string'&&/(?:联网|上网|搜一下|搜一搜|搜索|查一下|查查|帮我查|帮忙查|最新|(?:今天|今日|最近).{0,20}(?:天气|比赛|更新|新闻|发布|星期|几号|几月|价格|赛程)|现在.{0,8}(?:价格|版本|几点|更新|情况)|天气|气温|新闻|实时|汇率|股价|赛程|比分|官方.{0,6}(?:资料|文档)|是什么|是谁|怎么去|在哪里|开放时间|营业时间|更新了什么)/u.test(text);}
export function publicURL(raw){try{const u=new URL(raw);if(!['https:','http:'].includes(u.protocol)||u.username||u.password||/^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[|.*\.local$)/i.test(u.hostname)||/^172\.(?:1[6-9]|2\d|3[01])\./.test(u.hostname))return '';return u.href;}catch{return '';}}
export function sourceLinks(text){const hits=String(text||'').match(/https?:\/\/[^\s<>"\]\)）。，；]+/g)||[];return [...new Set(hits.map(publicURL).filter(url=>url&&url.length<=500))].slice(0,3).map(url=>({title:new URL(url).hostname,url}));}

export class SearchService{
  constructor({searchImpl=searchPublicWeb,weatherImpl=lookupWeather,getSettings=()=>({}),now=()=>Date.now()}){Object.assign(this,{searchImpl,weatherImpl,getSettings,now});this.lastResult=null;this.lastAttempt=null;this.error='';this.activeAbort=null;this.queueAbort=new AbortController();this.status='idle';this.generation=0;this.cache=new Map();this.weatherContexts=new Map();this.tail=Promise.resolve();}
  snapshot(){return {enabled:this.getSettings().webSearchEnabled===true,status:this.status,lastResult:this.lastResult,lastAttempt:this.lastAttempt,error:this.error};}
  clear(){this.generation++;this.queueAbort.abort(Error('检索已取消'));this.queueAbort=new AbortController();this.activeAbort?.abort(Error('检索已取消'));this.cache.clear();this.weatherContexts.clear();this.lastResult=null;this.lastAttempt=null;this.error='';this.status='idle';}
  weatherRequest(raw,scopeKey=''){
    const previous=scopeKey?this.weatherContexts.get(scopeKey):null;
    const recent=previous&&this.now()-previous.at<600000?previous:null;
    const previousRequest=recent&&(recent.pending||cityFromFollowup(raw))?recent.request:null;
    return parseWeatherRequest(raw,{now:this.now(),contextCity:recent?.city||null,pendingWeather:recent?.pending===true,previousRequest});
  }
  shouldSearch(raw,{scopeKey=''}={}){return Boolean(this.weatherRequest(raw,scopeKey))||needsSearch(raw);}
  async run(raw,{signal,force=false,scopeKey='',onStep}={}){
    if(this.getSettings().webSearchEnabled!==true)throw Error('联网搜索尚未开启');
    const query=searchQuery(raw);if(!query)throw Error('问题过长或缺少可公开检索的关键词，请简短描述');
    const generation=this.generation;
    const abort=new AbortController();signal=AbortSignal.any([abort.signal,this.queueAbort.signal,...(signal?[signal]:[])]);
    const wait=this.tail;let release;const slot=new Promise(r=>release=r);this.tail=wait.then(()=>slot);
    try{await withAbort(wait,signal);}catch(error){release();throw error;}
    const started=this.now();
    this.activeAbort=abort;
    try{
      if(signal?.aborted)throw Error('检索已取消');
      if(this.getSettings().webSearchEnabled!==true||generation!==this.generation)throw Error('联网设置已变更');
      this.status='searching';
      this.error='';this.lastResult=null;this.lastAttempt={query,at:this.now(),status:'searching'};
      const request=this.weatherRequest(raw,scopeKey);
      const cacheKey=request?'weather:'+scopeKey+':'+JSON.stringify(request):query;
      const cached=this.cache.get(cacheKey);if(!force&&cached&&this.now()-cached.at<300000){this.status='ready';this.lastResult=cached;return {...cached,cached:true};}
      let result;
      if(request){
        if(scopeKey){this.weatherContexts.set(scopeKey,{city:request.city,pending:request.needsCity,request,at:this.now()});if(this.weatherContexts.size>100)this.weatherContexts.delete(this.weatherContexts.keys().next().value);}
        if(request.needsCity||request.unsupportedDate){const value={query,answer:request.clarification,sources:[],kind:'clarification',provider:'weather-intent',webSearched:false,at:this.now()};this.lastResult=value;this.status='ready';this.lastAttempt.status='needs-input';return value;}
        try{result=await withAbort(this.weatherImpl({city:request.city,dayOffset:request.dayOffset,days:request.days},{signal,now:this.now()}),signal);}
        catch(e){if(signal?.aborted||generation!==this.generation||this.getSettings().webSearchEnabled!==true)throw Error('检索已取消');if(e.code==='AMBIGUOUS_CITY'||e.code==='CITY_NOT_FOUND'){const value={query,answer:e.code==='AMBIGUOUS_CITY'?'这个地名对应多个地方，请补充省份或区县。':'没找到这个城市，请补充省份或换个完整地名。',sources:[],kind:'clarification',provider:'weather-intent',webSearched:false,at:this.now()};if(scopeKey)this.weatherContexts.set(scopeKey,{city:null,pending:true,request:{...request,city:null},at:this.now()});this.lastResult=value;this.status='ready';return value;}throw e;}
      }else result=await withAbort(this.searchImpl(query,{signal,...(onStep?{onStep:step=>{if(generation===this.generation&&!signal.aborted){this.lastAttempt.step=step;onStep(step);}}}:{})}),signal);
      if(signal?.aborted||generation!==this.generation||this.getSettings().webSearchEnabled!==true)throw Error('检索已取消');
      const sources=(result.sources||[]).filter(x=>typeof x.url==='string'&&x.url.length<=500&&publicURL(x.url)).slice(0,3).map(x=>({title:String(x.title||new URL(x.url).hostname).slice(0,160),url:publicURL(x.url),snippet:String(x.snippet||'').slice(0,800),...(x.readLevel?{readLevel:x.readLevel==='page'?'page':'snippet'}:{})}));
      if(!sources.length)throw Error('这次没有取得可核验的联网来源');
      const answer=request?result.answer:typeof result.answer==='string'&&result.answer.trim()?result.answer.slice(0,8000):sources.map((x,i)=>`${i+1}. ${x.title}\n${x.snippet}\n${x.url}`).join('\n\n');
      const value={query,answer,sources,kind:request?'weather':'web',provider:result.provider,webSearched:true,at:this.now(),...(Array.isArray(result.trace)?{trace:result.trace.slice(0,6),pagesRead:result.pagesRead||0}:{}),...(request?{city:result.city?.displayName||request.city,dataTime:result.dataTime}:{}),timings:{totalMs:this.now()-started}};this.lastResult=value;this.cache.set(cacheKey,value);if(this.cache.size>30)this.cache.delete(this.cache.keys().next().value);this.status='ready';this.lastAttempt.status='ready';return value;
    }catch(e){if(generation===this.generation){this.status=signal?.aborted?'idle':'error';this.error=signal?.aborted?'':String(e.message||e).slice(0,300);if(this.lastAttempt)this.lastAttempt.status=this.status;}throw e;}
    finally{if(this.activeAbort===abort)this.activeAbort=null;release();}
  }
  close(){this.clear();}
}
