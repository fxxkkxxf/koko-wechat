import {isIP} from 'node:net';

const MAX_BYTES=128*1024;
const MAX_HTML_BYTES=768*1024;
const MAX_SOURCES=5;
const BING_HOSTS=new Set(['www.bing.com','cn.bing.com','global.bing.com','bing.com']);
const SOGOU_HOSTS=new Set(['www.sogou.com','sogou.com']);
const STOP=new Set(['the','and','for','what','how','with','from','about','official','documentation','docs','search','please','介绍','资料','官方','网站','搜索','最新','是什么','帮我','查询','官方文档','官方资料','官方网站','文档','开发文档','参考资料','请搜索','查一下','搜索一下']);
const LATIN_FILLER=new Set([...STOP,'can','could','would','you','me','my','is','are','it','its','a','an','to','of','in','on','at','this','that','these','those','tell','show','find','current','latest','today','now','new','version','stable','product','products','website']);
const HAN_FILLER=new Set([...STOP,'的','上面','里面','什么','哪里','哪个','哪些','怎么','怎样','如何','多少','主要','题材','现在','今天','目前','最近','帮忙','帮我','给我','请问','我想','知道','你知道','你知道不','你能不能','能不能','可以','这个','那个','好像','一般','一下','在国外','国外','产品']);
const fail=(code,message)=>Object.assign(new Error(message),{code});
const compactHan=text=>String(text).replace(/([\p{Script=Han}])\s+(?=[\p{Script=Han}])/gu,'$1');

export function publicSourceURL(raw){
  if(typeof raw!=='string'||raw.length>2048)return null;
  try{
    const u=new URL(raw.trim());const host=u.hostname.toLowerCase().replace(/\.$/,'');
    if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port&&!['80','443'].includes(u.port))return null;
    if(!host.includes('.')||/(^|\.)(localhost|local|internal|lan|home|test|invalid|example)$/.test(host))return null;
    if(isIP(host)){
      if(isIP(host)!==4)return null;
      const [a,b]=host.split('.').map(Number);
      if(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19)||a===192&&b===2||a===198&&b===51||a===203&&b===0)return null;
    }
    // Avoid obvious textual local-IP aliases as well. No result source is
    // fetched by this module; outbound requests are fixed Bing search only.
    if(/(?:^|[.-])(?:localhost|127[.-]0[.-]0[.-]1|192[.-]168|10[.-]\d)(?:[.-]|$)/i.test(host))return null;
    u.hash='';return u.href;
  }catch{return null;}
}

function entities(text){
  const known={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
  return String(text||'').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(all,key)=>{
    if(key[0]!=='#')return known[key.toLowerCase()]||all;
    const n=key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):parseInt(key.slice(1),10);
    return n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):'';
  });
}
function plain(text,max){
  return entities(String(text||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]*>/g,' '))
    .replace(/<[^>]*>/g,' ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/\s+/g,' ').trim().slice(0,max);
}
function field(item,name){return item.match(new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/'+name+'>','i'))?.[1]||'';}
function constraints(query){
  const sites=[...query.matchAll(/\bsite:([^\s]+)/gi)].map(x=>{
    try{const u=new URL('https://'+x[1]);return {host:u.hostname.toLowerCase(),path:u.pathname.replace(/\/$/,'')};}catch{return null;}
  }).filter(Boolean);
  const officialOpenAI=/\b(?:openai|chatgpt|codex)\b/i.test(query)&&/官方|official|\b(?:documentation|docs|api)\b/i.test(query);
  const clean=query.replace(/\bsite:[^\s]+/gi,'').normalize('NFKC').toLowerCase()
    .split(/[，,;；。!?！？]/u).filter(part=>!/^\s*(?:我(?:没|不|刚|已经|还|很|特别|非常)|但(?:是)?(?:这|那)|听说|好像|感觉)/u.test(part)).join(' ');
  const quoted=[...clean.matchAll(/["“《]([^"”》]{2,80})["”》]/gu)].map(x=>compactHan(x[1]));
  const latin=[...new Set((clean.match(/[a-z][a-z0-9.+_-]*/g)||[]).filter(x=>!LATIN_FILLER.has(x)))];
  const numbers=[...new Set((clean.match(/\b\d+(?:\.\d+)*\b/g)||[]).filter(x=>!/^20\d{2}$|^19\d{2}$/.test(x)))];
  const han=[];
  for(let part of clean.match(/[\p{Script=Han}]+/gu)||[]){
    // Remove request framing, not name characters: e.g. 健怡可乐 remains
    // intact rather than being reduced to 健/怡/可乐 by word segmentation.
    part=part.replace(/^(?:(?:你能不能|能不能|你可以|你知道不|你知道|请问|麻烦|请|帮我|帮忙|给我|告诉我|我想知道|我想问|你|我|的|查一下|搜索一下|查询一下|查查|查询|搜索))+/u,'');
    part=part.split(/(?:是什么样|是什么|是怎样|是怎么|怎么样|在哪里|在哪|上面|里面|一般|主要|有没有|能不能|怎么|怎样|什么|你知道|的官方|的资料|的介绍)/u)[0];
    part=part.replace(/(?:的|官方文档|官方资料|官方网站|介绍|资料|官方|网站|搜索|查询|在哪里|哪里|么|吗|呢|呀|啊|吧)+$/u,'');
    if(part.length>=2&&!HAN_FILLER.has(part))han.push(part);
  }
  return {sites,officialOpenAI,quoted,latin,numbers,han:[...new Set(han)].slice(0,12)};
}
function hanMatch(text,word){
  if(text.includes(word))return true;
  if(word.length<4)return false;
  const pieces=Array.from({length:word.length-1},(_,i)=>word.slice(i,i+2));
  return pieces.filter(x=>text.includes(x)).length>=Math.ceil(pieces.length*.6);
}
function relevant(source,rules){
  const u=new URL(source.url),host=u.hostname.toLowerCase();
  if(rules.sites.length&&!rules.sites.some(x=>(host===x.host||host.endsWith('.'+x.host))&&(!x.path||u.pathname.startsWith(x.path))))return false;
  if(rules.officialOpenAI&&host!=='openai.com'&&!host.endsWith('.openai.com')&&host!=='learn.chatgpt.com')return false;
  const text=compactHan(source.title+' '+source.snippet+' '+source.url).normalize('NFKC').toLowerCase();
  if(rules.quoted.some(word=>!text.includes(word)))return false;
  // Model/product numbers cannot be replaced by a neighboring version. Years
  // are freshness hints checked by the research layer, not mandatory wording.
  if(rules.numbers.some(word=>!new RegExp('(?:^|[^\\d])'+word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![\\d.])').test(text)))return false;
  const latinMatch=rules.latin.length&&rules.latin.every(word=>text.includes(word));
  const hanSubject=rules.han[0],hanSubjectMatch=hanSubject&&text.includes(hanSubject);
  // Chinese and English may name the same entity (健怡可乐 / Diet Coke).
  // At least one complete naming route must match, not a bag of generic words.
  if((rules.latin.length||hanSubject)&&!latinMatch&&!hanSubjectMatch)return false;
  const qualifiers=rules.han.slice(1);
  if(qualifiers.length&&!qualifiers.some(word=>hanMatch(text,word)))return false;
  const specific=qualifiers.filter(word=>word.length>=4);
  if(specific.length&&!specific.some(word=>hanMatch(text,word)))return false;
  return true;
}

export function parseBingRSS(xml,query){
  if(typeof xml!=='string'||Buffer.byteLength(xml)>MAX_BYTES||/<!DOCTYPE|<!ENTITY/i.test(xml)||!/<rss\b/i.test(xml))throw Error('公共搜索未返回安全的RSS结果');
  const sources=[],seen=new Set(),rules=constraints(query);
  for(const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)){
    const item=match[1];const url=publicSourceURL(entities(field(item,'link').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').trim()));
    if(!url||seen.has(url))continue;
    const source={title:plain(field(item,'title'),240),url,snippet:plain(field(item,'description'),800)};
    if(!source.title||!relevant(source,rules))continue;
    seen.add(url);sources.push(source);if(sources.length===MAX_SOURCES)break;
  }
  if(!sources.length)throw fail('NO_RELEVANT_RESULTS','公共搜索没有返回符合主题和来源要求的可靠结果，请换关键词或提供具体公开链接');
  return sources;
}

export function parseSogouHTML(html,query){
  if(typeof html!=='string'||Buffer.byteLength(html)>MAX_HTML_BYTES||!/<html\b/i.test(html))throw Error('备用搜索没有返回有效网页');
  html=html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ').replace(/<!--[\s\S]*?-->/g,' ');
  const title=plain(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1],200);
  if(/验证码|安全验证|访问异常|访问验证|访问受限/i.test(title)||/<form[^>]+(?:antispider|captcha)/i.test(html))throw fail('SEARCH_CAPTCHA','备用搜索需要验证，未绕过验证');
  const headings=[...html.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi)],sources=[],seen=new Set(),rules=constraints(query);
  for(let index=0;index<headings.length;index++){
    const match=headings[index],href=match[1].match(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
    if(!href)continue;
    let absolute;try{absolute=new URL(entities(href),'https://www.sogou.com').href;}catch{continue;}
    const url=publicSourceURL(absolute);if(!url||seen.has(url))continue;
    const start=match.index+match[0].length,end=Math.min(headings[index+1]?.index??html.length,start+5000);
    const tail=html.slice(start,end).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ').replace(/<!--[\s\S]*?-->/g,' ');
    const source={title:compactHan(plain(match[1],240)),url,snippet:compactHan(plain(tail,1000)).replace(/推荐您搜索[\s\S]*$/u,'').trim().slice(0,800)};
    if(!source.title||!relevant(source,rules))continue;
    seen.add(url);sources.push(source);if(sources.length===MAX_SOURCES)break;
  }
  if(!sources.length)throw fail('NO_RELEVANT_RESULTS','备用搜索没有取得符合主题和来源要求的结果');
  return sources;
}

async function limitedBody(response,signal,maxBytes=MAX_BYTES){
  const length=Number(response.headers.get('content-length'));
  if(Number.isFinite(length)&&length>maxBytes)throw Error('公共搜索结果过大');
  if(!response.body)return '';
  const reader=response.body.getReader();const chunks=[];let size=0;
  const abort=()=>{reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  try{while(true){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes)throw Error('公共搜索结果超过大小限制');chunks.push(value);}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}
  finally{signal.removeEventListener('abort',abort);reader.releaseLock();}
  signal.throwIfAborted();
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchSearch(query,provider,{signal,fetchImpl}){
  const bing=provider==='bing-rss';
  let url=new URL(bing?'https://www.bing.com/search':'https://www.sogou.com/web');
  const queryKey=bing?'q':'query';url.searchParams.set(queryKey,query);if(bing)url.searchParams.set('format','rss');
  const deadline=AbortSignal.timeout(bing?4000:6000),combined=AbortSignal.any([signal,deadline]);
  try{
    for(let hop=0;hop<4;hop++){
      combined.throwIfAborted();
      const response=await fetchImpl(url.href,{signal:combined,redirect:'manual',headers:{Accept:bing?'application/rss+xml, application/xml, text/xml':'text/html','User-Agent':bing?'Koko-WeChat public-search':'Mozilla/5.0 (compatible; Koko public-search)'}});
      if(response.status>=300&&response.status<400){
        const location=response.headers.get('location');await response.body?.cancel().catch(()=>{});
        if(!location)throw Error('公共搜索重定向无效');
        const next=new URL(location,url);
        const allowed=bing?BING_HOSTS:SOGOU_HOSTS;
        if(next.protocol!=='https:'||next.username||next.password||next.port||!allowed.has(next.hostname)||next.pathname!==(bing?'/search':'/web')||bing&&next.searchParams.get('format')!=='rss'||next.searchParams.get(queryKey)!==query)throw fail('SEARCH_REDIRECT','公共搜索重定向超出允许来源');
        url=next;continue;
      }
      if(!response.ok){await response.body?.cancel().catch(()=>{});throw fail('SEARCH_UNAVAILABLE','公共搜索暂不可用（'+response.status+'）');}
      const type=response.headers.get('content-type')||'';
      if(!(bing?/\b(?:xml|rss)\b/i:/\bhtml\b/i).test(type)){await response.body?.cancel().catch(()=>{});throw fail('SEARCH_CONTENT_TYPE',bing?'公共搜索返回了非RSS页面，可能需要验证码':'备用搜索没有返回HTML页面');}
      const body=await limitedBody(response,combined,bing?MAX_BYTES:MAX_HTML_BYTES);
      const sources=bing?parseBingRSS(body,query):parseSogouHTML(body,query);
      return {sources,provider,fetchedAt:Date.now()};
    }
    throw Error('公共搜索重定向过多');
  }catch(error){if(combined.aborted){if(signal.aborted)throw signal.reason||Error('搜索已取消');throw fail('SEARCH_TIMEOUT','公共搜索超时，请稍后重试');}throw error;}
}

export async function searchPublicWeb(query,{signal,fetchImpl=fetch}={}){
  if(typeof query!=='string'||!query.trim()||query.length>240||/[\r\n\u0000-\u001f]/.test(query))throw Error('公开搜索关键词需为1—240字且不含换行');
  query=query.trim();
  const timeout=AbortSignal.timeout(10000),combined=signal?AbortSignal.any([signal,timeout]):timeout;
  try{return await fetchSearch(query,'bing-rss',{signal:combined,fetchImpl});}
  catch(error){
    if(combined.aborted){if(signal?.aborted)throw signal.reason||Error('搜索已取消');throw Error('公共搜索超时，请稍后重试');}
    // One independently tested public provider only. Security, malformed-body
    // and CAPTCHA failures are not disguised as a successful second attempt.
    if(!['NO_RELEVANT_RESULTS','SEARCH_UNAVAILABLE','SEARCH_TIMEOUT'].includes(error.code))throw error;
    try{return {...await fetchSearch(query,'sogou-html',{signal:combined,fetchImpl}),fallbackFrom:{provider:'bing-rss',reason:error.code}};}
    catch(fallback){if(combined.aborted){if(signal?.aborted)throw signal.reason||Error('搜索已取消');throw Error('公共搜索超时，请稍后重试');}throw fail(fallback.code||'SEARCH_UNAVAILABLE','主搜索与备用搜索均未取得可靠资料：'+fallback.message);}
  }
}
