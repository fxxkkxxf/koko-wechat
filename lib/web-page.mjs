import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import {isIP} from 'node:net';
import {createGunzip,createInflate,createBrotliDecompress} from 'node:zlib';

const MAX_BYTES=1024*1024;
const MAX_TEXT=10000;
const TIMEOUT_MS=8000;
const error=(code,message)=>Object.assign(new Error(message),{code});
const header=(response,name)=>String(response.headers?.[name]||'');

/** Only a normal public hostname may enter the DNS and HTTP path. */
export function publicPageURL(raw){
  if(typeof raw!=='string'||!raw.trim()||raw.length>2048||/[\x00-\x20\x7f]/.test(raw))return null;
  try{
    const u=new URL(raw),host=u.hostname.toLowerCase().replace(/\.$/,'');
    if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.port&&!['80','443'].includes(u.port))return null;
    if(isIP(host)||host.includes(':')||!host.includes('.')||host.length>253)return null;
    if(!host.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)))return null;
    if(/(?:^|\.)(?:localhost|local|internal|intranet|lan|home|test|invalid|example|onion)$/.test(host))return null;
    if(/(?:^|[.-])(?:localhost|127[.-]0[.-]0[.-]1|192[.-]168|10[.-]\d)(?:[.-]|$)/i.test(host))return null;
    u.hostname=host;u.hash='';return u.href;
  }catch{return null;}
}

/** Reject local, special-purpose and documentation networks, including v6 aliases. */
export function isPublicAddress(address){
  const family=isIP(address);
  if(family===4){
    const [a,b,c]=address.split('.').map(Number);
    return !(a===0||a===10||a===127||a>=224||a===100&&b>=64&&b<=127||a===169&&b===254||
      a===172&&b>=16&&b<=31||a===192&&(b===168||b===0&&(c===0||c===2)||b===88&&c===99)||
      a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
  }
  if(family!==6||address.includes('%'))return false;
  let ip;
  try{ip=new URL('https://['+address+']/').hostname.slice(1,-1).toLowerCase();}catch{return false;}
  // Globally routed unicast is 2000::/3. Exclude transition/documentation ranges.
  if(!/^[23][0-9a-f]{3}:/.test(ip)||/^(?:2002|3fff):/.test(ip))return false;
  return !/^2001:(?::|(?:db8|2|[12][0-9a-f]):)/.test(ip);
}

async function cancellable(promise,signal){
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const aborted=()=>reject(signal.reason||error('PAGE_CANCELLED','网页读取已取消'));
    signal.addEventListener('abort',aborted,{once:true});
    Promise.resolve(promise).then(value=>{signal.removeEventListener('abort',aborted);resolve(value);},e=>{signal.removeEventListener('abort',aborted);reject(e);});
  });
}

async function requestPublic(url,{signal,requestImpl,lookupImpl}){
  const u=new URL(url),host=u.hostname;
  const resolved=await cancellable(Promise.resolve().then(()=>lookupImpl(host,{all:true,verbatim:true})),signal);
  signal.throwIfAborted();
  if(!Array.isArray(resolved)||!resolved.length||resolved.some(x=>![4,6].includes(x.family)||isIP(x.address)!==x.family||!isPublicAddress(x.address)))throw error('PAGE_PRIVATE_ADDRESS','网页域名未解析到允许访问的公网地址');
  const selected=resolved.find(x=>x.family===4)||resolved[0];
  const pinnedLookup=(requested,options,callback)=>{
    if(typeof options==='function'){callback=options;options={};}
    if(requested.toLowerCase().replace(/\.$/,'')!==host)return callback(error('PAGE_PRIVATE_ADDRESS','网页连接的域名已变化'));
    if(options?.all)return callback(null,[{address:selected.address,family:selected.family}]);
    callback(null,selected.address,selected.family);
  };
  const request=requestImpl||(u.protocol==='https:'?https.request:http.request);
  return cancellable(new Promise((resolve,reject)=>{
    const req=request(u,{signal,lookup:pinnedLookup,family:selected.family,autoSelectFamily:false,agent:false,
      maxHeaderSize:32768,headers:{Accept:'text/html, text/plain, text/markdown, application/json;q=0.8','Accept-Encoding':'gzip, deflate, br','User-Agent':'Koko-WeChat/0.5 public-page'}},resolve);
    req.once('error',reject);req.end();
  }),signal);
}

async function limitedBody(response,signal){
  const declared=Number(header(response,'content-length'));
  if(Number.isFinite(declared)&&declared>MAX_BYTES){response.destroy();throw error('PAGE_TOO_LARGE','网页正文超过读取大小限制');}
  const encoding=header(response,'content-encoding').toLowerCase().trim();
  const decompress=encoding==='gzip'?createGunzip():encoding==='deflate'?createInflate():encoding==='br'?createBrotliDecompress():null;
  if(encoding&&encoding!=='identity'&&!decompress){response.destroy();throw error('PAGE_UNSUPPORTED','网页使用了暂不支持的压缩格式');}
  let encoded=0;
  const tooLarge=()=>error('PAGE_TOO_LARGE','网页正文超过读取大小限制');
  const count=chunk=>{encoded+=chunk.length;if(encoded>MAX_BYTES)response.destroy(tooLarge());};
  const forward=e=>decompress?.destroy(e);
  const aborted=()=>{const e=signal.reason||error('PAGE_CANCELLED','网页读取已取消');response.destroy(e);decompress?.destroy(e);};
  response.on('data',count);response.on('error',forward);signal.addEventListener('abort',aborted,{once:true});
  const body=decompress?response.pipe(decompress):response;let bytes=0;const chunks=[];
  try{
    signal.throwIfAborted();
    for await(const chunk of body){signal.throwIfAborted();bytes+=chunk.length;if(bytes>MAX_BYTES)throw tooLarge();chunks.push(chunk);}
    signal.throwIfAborted();return Buffer.concat(chunks);
  }catch(e){response.destroy();decompress?.destroy();throw e;}
  finally{signal.removeEventListener('abort',aborted);response.removeListener('data',count);response.removeListener('error',forward);}
}

const ENTITIES={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',ensp:' ',emsp:' ',thinsp:' ',zwnj:'',zwj:'',lrm:'',rlm:'',hellip:'…',ndash:'–',mdash:'—',lsquo:'‘',rsquo:'’',ldquo:'“',rdquo:'”',laquo:'«',raquo:'»',copy:'©',reg:'®',trade:'™',bull:'•',middot:'·',euro:'€',pound:'£',yen:'¥',deg:'°'};
function entities(text){return text.replace(/&(#x[\da-f]+|#\d+|[a-z][a-z0-9]+);/gi,(all,key)=>{if(key[0]!=='#')return ENTITIES[key.toLowerCase()]??all;const n=key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):parseInt(key.slice(1),10);return n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):'';});}
function tidy(text){return text.replace(/\r\n?/g,'\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').replace(/[\t\u00a0 ]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();}
function withoutHTMLTags(html){
  const pieces=[];let previous=0;
  for(let i=0;i<html.length;i++){
    if(html[i]!=='<'||!/^<(?:\/?[a-z]|!|\?)/i.test(html.slice(i,i+4)))continue;
    pieces.push(html.slice(previous,i));
    if(html.startsWith('<!--',i)){const end=html.indexOf('-->',i+4);i=end<0?html.length:end+2;previous=i+1;continue;}
    let quote=null,end=i+1;
    for(;end<html.length;end++){
      const c=html[end];
      if(quote){if(c===quote)quote=null;}
      else if(c==='"'||c==="'")quote=c;
      else if(c==='>')break;
    }
    // A > inside a quoted JSON/data attribute is not the end of its tag.
    // Drop incomplete markup instead of surfacing the remaining attributes.
    if(end===html.length){previous=html.length;break;}
    const tag=html.slice(i,end+1);
    pieces.push(/^<(?:br|hr)\b|^<\/(?:p|div|li|tr|h[1-6]|section|article|main|blockquote)\s*>/i.test(tag)?'\n':' ');
    i=end;previous=end+1;
  }
  pieces.push(html.slice(previous));return pieces.join('');
}
function plainHTML(html){return tidy(entities(withoutHTMLTags(html)));}

function literalString(token){
  if(!token||token.length<2||token.at(-1)!==token[0]||!['"',"'"].includes(token[0]))return null;
  let out='';
  for(let i=1;i<token.length-1;i++){
    let c=token[i];
    if(c!=='\\'){out+=c;continue;}
    c=token[++i];
    if(['\\','/',"'",'"'].includes(c)){out+=c;continue;}
    if(c==='u'||c==='x'){
      const size=c==='u'?4:2,hex=token.slice(i+1,i+1+size);
      if(hex.length!==size||!/^[\da-f]+$/i.test(hex))return null;
      out+=String.fromCharCode(parseInt(hex,16));i+=size;continue;
    }
    // No expressions, octal/identity escapes, interpolation, or line continuation.
    return null;
  }
  return out;
}

function htmlAttributes(tag){
  const attributes=new Map();
  for(const match of tag.matchAll(/([^\s=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)){
    const key=match[1].toLowerCase();if(attributes.has(key))return null;
    attributes.set(key,entities(match[2]??match[3]??match[4]));
  }
  return attributes;
}

/** Sogou results sometimes use a tiny HTTP-200 redirect wrapper, not a 302.
 * Only recognize complete literal statements on that known wrapper endpoint.
 * Never run JS or evaluate a string/expression to discover its destination. */
function sogouLiteralRedirect(body,url,contentType){
  const current=new URL(url);
  if(!['www.sogou.com','sogou.com'].includes(current.hostname)||current.pathname!=='/link'||!current.searchParams.has('url')||!/(?:html|xhtml)/i.test(contentType))return null;
  if(body.length>8192)return null;
  const visible=plainHTML(body.replace(/<(script|noscript|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' '));
  if(visible.length>100||/<(?:article|main)\b/i.test(body))return null;
  const targets=[];let shell=false;
  const token='("(?:[^"\\\\\\r\\n]|\\\\[^\\r\\n])*"|\'(?:[^\'\\\\\\r\\n]|\\\\[^\\r\\n])*\')';
  const call=new RegExp('^(?:window\\s*\\.\\s*)?location\\s*\\.\\s*(?:replace|assign)\\s*\\(\\s*'+token+'\\s*\\)\\s*;?\\s*$');
  const assignment=new RegExp('^(?:window\\s*\\.\\s*)?location\\s*\\.\\s*href\\s*=\\s*'+token+'\\s*;?\\s*$');
  for(const script of body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)){
    shell=true;const attributes=htmlAttributes(script[1]),code=script[2].trim();
    if(!attributes||attributes.has('src'))throw error('PAGE_JS_REQUIRED','搜索结果跳转需要运行脚本，未猜测目标网页');
    if(!code)continue;
    const matched=code.match(call)||code.match(assignment),target=matched?literalString(matched[1]):null;
    if(target===null)throw error('PAGE_JS_REQUIRED','搜索结果跳转不是单一明确地址，未运行脚本');
    targets.push(target);
  }
  for(const meta of body.matchAll(/<meta\b[^>]*>/gi)){
    const attributes=htmlAttributes(meta[0]);if(!attributes)throw error('PAGE_JS_REQUIRED','搜索结果跳转信息有歧义，未猜测目标网页');
    if(attributes.get('http-equiv')?.toLowerCase().trim()!=='refresh')continue;
    shell=true;const content=attributes.get('content')||'',match=content.match(/^\s*0(?:\.0*)?\s*;\s*url\s*=\s*(.*?)\s*$/i);
    if(!match)throw error('PAGE_JS_REQUIRED','搜索结果跳转没有明确的即时目标地址');
    let target=match[1];
    if(['"',"'"].includes(target[0])){if(target.at(-1)!==target[0])throw error('PAGE_JS_REQUIRED','搜索结果跳转地址不完整');target=target.slice(1,-1);}
    if(!target)throw error('PAGE_JS_REQUIRED','搜索结果跳转地址为空');targets.push(target);
  }
  if(!shell)return null;
  if(!targets.length||/<[a-z][^>]*\son[a-z]+\s*=/i.test(body))throw error('PAGE_JS_REQUIRED','搜索结果跳转需要浏览器处理，未运行脚本');
  const normalized=targets.map(target=>{let next;try{next=publicPageURL(new URL(target,url).href);}catch{}if(!next)throw error('PAGE_UNSAFE_REDIRECT','搜索结果跳转到不允许读取的地址');return next;});
  const unique=[...new Set(normalized)];
  if(unique.length!==1)throw error('PAGE_JS_REQUIRED','搜索结果包含多个不同跳转目标，未猜测网页');
  return unique[0];
}

/** Extract public page text as untrusted evidence, never executable instructions. */
export function extractPageText(body,{url='',contentType='text/html'}={}){
  const html=/\b(?:html|xhtml)\b/i.test(contentType);
  if(!html){
    const text=tidy(String(body));if(!text)throw error('PAGE_EMPTY','网页没有可读取的正文');
    return {title:url?new URL(url).hostname:'公开文本',text:text.slice(0,MAX_TEXT),truncated:text.length>MAX_TEXT};
  }
  const input=String(body),rawTitle=input.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]||'';
  const title=plainHTML(rawTitle).slice(0,240)||(url?new URL(url).hostname:'公开网页');
  const cleaned=input.replace(/<(script|style|noscript|template|svg|canvas|nav|footer|form|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ')
    .replace(/<(?:script|style|noscript|template|svg|canvas)\b[^>]*>[\s\S]*$/gi,' ');
  const region=cleaned.match(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/i)?.[1]||cleaned.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i)?.[1]||cleaned.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1]||cleaned;
  const text=plainHTML(region);
  if((/just a moment|access denied|security check|verify.{0,15}(?:human|browser)|captcha|人机验证|安全验证|访问验证/i.test(title+' '+text.slice(0,1600))&&text.length<3000)||/challenge-platform|cf-browser-verification|<form\b[^>]*(?:challenge-form|captcha)/i.test(input))throw error('PAGE_BLOCKED','网页要求安全验证，未取得可核实的正文');
  const loginHeading=value=>/^(?:sign[ -]?in|log[ -]?in|login)(?:\b|\s)|^(?:登录|登入)(?:[\s|·:：-]|$)/i.test(value);
  const h1=plainHTML(cleaned.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i)?.[1]||'');
  const paragraphs=[...cleaned.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)].map(x=>plainHTML(x[1])).filter(x=>x.length>=35);
  const structuredArticle=/<(?:article|main)\b/i.test(cleaned)&&text.length>=80;
  const legacyArticle=h1.length>=8&&!loginHeading(h1)&&paragraphs.length>=2&&paragraphs.reduce((n,x)=>n+x.length,0)>=100;
  const readableArticle=structuredArticle||legacyArticle;
  // A public article may include a password box solely for comments. Do not
  // treat that widget as a gate on text which has already been read. Explicit
  // "sign in to read" gates and actual sign-in pages remain blocked.
  const readingGate=/(?:登录|登入|注册|订阅)(?:后|以|即可|并)?(?:才能|方可|可)?(?:查看|阅读|继续阅读|解锁)(?:全文|正文|本(?:文|篇)|完整(?:内容|文章))|(?:全文|正文|完整(?:内容|文章))(?:需|需要|仅限).{0,8}(?:登录|订阅)|(?:sign|log)\s+in\s+to\s+(?:read|continue reading|view (?:the )?(?:full|article))|subscribe\s+to\s+(?:read|continue reading|view (?:the )?(?:full|article))/i.test(text);
  if(text.length<3000&&readingGate||text.length<1600&&loginHeading(title)||!readableArticle&&text.length<2500&&/<input\b[^>]*\btype\s*=\s*['"]?password\b/i.test(input))throw error('PAGE_LOGIN_REQUIRED','网页要求登录，未取得公开正文');
  if(text.length<20)throw error('PAGE_EMPTY','网页没有足够可读取的正文，可能需要浏览器运行脚本');
  return {title,text:text.slice(0,MAX_TEXT),truncated:text.length>MAX_TEXT};
}

/** No cookies/auth, private hosts, JS, redirects to local addresses or DNS re-resolution. */
export async function readPublicPage(raw,{signal,requestImpl,lookupImpl=(...args)=>dns.lookup(...args)}={}){
  let url=publicPageURL(raw);if(!url)throw error('PAGE_UNSAFE_URL','只可读取不含登录凭证的公开HTTP网页地址');
  const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(TIMEOUT_MS)]):AbortSignal.timeout(TIMEOUT_MS);
  try{
    for(let hop=0;hop<=3;hop++){
      combined.throwIfAborted();const response=await requestPublic(url,{signal:combined,requestImpl,lookupImpl});
      const status=response.statusCode;
      if([301,302,303,307,308].includes(status)){
        const location=header(response,'location');response.destroy();
        if(hop===3)throw error('PAGE_REDIRECT_LIMIT','网页重定向次数过多，未取得正文');
        let next;try{next=publicPageURL(new URL(location,url).href);}catch{}
        if(!location||location.length>2048||!next)throw error('PAGE_UNSAFE_REDIRECT','网页跳转到不允许读取的地址');url=next;continue;
      }
      if(!Number.isInteger(status)||status<200||status>=300){response.destroy();throw error(status===401?'PAGE_LOGIN_REQUIRED':status===403?'PAGE_BLOCKED':status===429?'PAGE_RATE_LIMIT':'PAGE_HTTP_ERROR',status===401?'网页要求登录，未取得公开正文':status===403?'网页限制访问，未取得正文':status===429?'网站暂时限流，未取得正文':`网页读取失败（HTTP ${status||'未知'}）`);}
      const contentType=header(response,'content-type').toLowerCase();
      if(!/^(?:text\/(?:html|plain|markdown)|application\/(?:xhtml\+xml|json))(?:\s*;|$)/.test(contentType)){response.destroy();throw error('PAGE_UNSUPPORTED','此链接不是可读取的公开文本网页');}
      const buffer=await limitedBody(response,combined);let encoding='utf-8';
      const charset=contentType.match(/\bcharset\s*=\s*["']?([^\s;"']+)/i)?.[1];if(charset)encoding=charset;
      let body;try{body=new TextDecoder(encoding,{fatal:false}).decode(buffer);}catch{body=new TextDecoder('utf-8').decode(buffer);}
      const wrapped=sogouLiteralRedirect(body,url,contentType);
      if(wrapped){if(hop===3)throw error('PAGE_REDIRECT_LIMIT','网页重定向次数过多，未取得正文');url=wrapped;continue;}
      const extracted=extractPageText(body,{url,contentType});
      return {...extracted,url,provider:'http-page',fetchedAt:Date.now(),contentType};
    }
  }catch(e){
    if(combined.aborted){if(signal?.aborted)throw signal.reason||error('PAGE_CANCELLED','网页读取已取消');throw error('PAGE_TIMEOUT','网页读取超时，请换一个来源');}
    if(e.code?.startsWith('PAGE_'))throw e;
    throw error('PAGE_UNAVAILABLE','网页连接未完成，未取得可核实的正文');
  }
}
