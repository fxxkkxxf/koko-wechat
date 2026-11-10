import test from 'node:test';
import assert from 'node:assert/strict';
import {parseBingRSS,parseSogouHTML,publicSourceURL,searchPublicWeb} from '../lib/public-web.mjs';

const item=(title='Node.js documentation',url='https://nodejs.org/en/docs/',description='Node.js official docs')=>`<item><title>${title}</title><link>${url}</link><description>${description}</description></item>`;
const rss=contents=>`<?xml version="1.0"?><rss version="2.0"><channel>${contents}</channel></rss>`;
const response=contents=>new Response(contents,{headers:{'content-type':'text/xml; charset=utf-8'}});

test('public result URLs reject local, credential, non-HTTP and unusual-port destinations',()=>{
 for(const raw of ['http://127.0.0.1/x','http://2130706433/','http://0x7f000001/','http://10.1.1.2/','http://172.20.1.1/','http://192.168.0.1/','http://[::1]/','http://localhost/','http://box.local/x','http://box.internal/','http://127.0.0.1.nip.io/','https://name:pass@openai.com/','file:///a','data:text/html,hi','https://openai.com:65470/'])assert.equal(publicSourceURL(raw),null,raw);
 assert.equal(publicSourceURL('https://nodejs.org/en/docs/#x'),'https://nodejs.org/en/docs/');
});
test('RSS safely decodes entities and CDATA, strips markup, bounds descriptions and deduplicates',()=>{
 const xml=rss(item('Node.js &amp; docs','https://nodejs.org/docs/?a=1&amp;b=2','<![CDATA[<b>Node.js</b> &#x4f60;&#22909; '+ 'x'.repeat(1000)+']]>')+item('Node.js duplicate','https://nodejs.org/docs/?a=1&amp;b=2'));
 const result=parseBingRSS(xml,'Node.js');assert.equal(result.length,1);assert.equal(result[0].title,'Node.js & docs');assert.equal(result[0].url,'https://nodejs.org/docs/?a=1&b=2');assert.match(result[0].snippet,/你好/);assert.equal(result[0].snippet.length,800);assert.doesNotMatch(result[0].snippet,/<b>/);
});
test('DTD/entity input, unsafe sources and genuinely unrelated results fail closed',()=>{
 for(const xml of ['<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///secret">]>'+rss(item()),rss(item('Node.js','http://127.0.0.1/')),rss(item('Cooking recipes','https://food.org/','make a cake'))])assert.throws(()=>parseBingRSS(xml,'Node.js'));
});
test('site constraints and OpenAI official queries do not trust mirrors or title claims',()=>{
 const xml=rss(item('OpenAI Responses API official docs','https://developers.openai.ac.cn/docs/','OpenAI API Responses')+item('OpenAI Responses API official docs','https://platform.openai.com/docs/guides/responses','OpenAI API Responses'));
 assert.deepEqual(parseBingRSS(xml,'OpenAI Responses API documentation').map(x=>x.url),['https://platform.openai.com/docs/guides/responses']);
 assert.throws(()=>parseBingRSS(rss(item('Node.js docs','https://fake.org/docs/')),'site:nodejs.org Node.js documentation'));
});
test('successful fetch follows only a fixed Bing RSS geographic redirect and returns real parsed sources',async()=>{
 const calls=[];
 const result=await searchPublicWeb('site:nodejs.org Node.js documentation',{fetchImpl:async(url,options)=>{
  calls.push({url,options});
  if(calls.length===1)return new Response('',{status:302,headers:{location:'https://cn.bing.com/search?format=rss&q='+encodeURIComponent('site:nodejs.org Node.js documentation')}});
  return response(rss(item()));
 }});
 assert.equal(result.provider,'bing-rss');assert.equal(result.sources.length,1);assert.equal(calls.length,2);assert.ok(result.fetchedAt>0);assert.equal(calls[0].options.redirect,'manual');assert.match(calls[1].url,/^https:\/\/cn\.bing\.com\/search/);
});
test('redirects cannot change the query or leave fixed Bing hosts',async()=>{
 for(const location of ['http://127.0.0.1/search','https://evil.org/search?format=rss&q=Node.js','https://www.bing.com/search?format=rss&q=other','https://www.bing.com/other?format=rss&q=Node.js']){
  await assert.rejects(searchPublicWeb('Node.js',{fetchImpl:async()=>new Response('',{status:302,headers:{location}})}),/重定向/);
 }
});
test('status errors, CAPTCHA HTML and oversized streamed or declared bodies are rejected',async()=>{
 for(const r of [new Response('',{status:429}),new Response('<html>captcha</html>',{headers:{'content-type':'text/html'}}),new Response('x'.repeat(131073),{headers:{'content-type':'text/xml'}}),new Response('',{headers:{'content-type':'text/xml','content-length':'200000'}})]){
  await assert.rejects(searchPublicWeb('Node.js',{fetchImpl:async()=>r}));
 }
});
test('caller cancellation closes a pending body without waiting for the provider',async()=>{
 const ac=new AbortController();let canceled=false;
 const body=new ReadableStream({start(){},cancel(){canceled=true;}});
 const request=searchPublicWeb('Node.js',{signal:ac.signal,fetchImpl:async()=>new Response(body,{headers:{'content-type':'text/xml'}})});
 await new Promise(resolve=>setTimeout(resolve,5));ac.abort(Error('stop'));
 await assert.rejects(request,/stop/);assert.equal(canceled,true);
});
test('at most five relevant sources are passed through and query validation avoids requests',async()=>{
 assert.equal(parseBingRSS(rss(Array.from({length:9},(_,i)=>item('Node.js docs','https://nodejs.org/docs/'+i)).join('')),'Node.js').length,5);
 let calls=0;for(const q of ['', 'a\nb','x'.repeat(241)])await assert.rejects(searchPublicWeb(q,{fetchImpl:async()=>{calls++;throw Error('must not fetch');}}));assert.equal(calls,0);
});

test('request framing does not outweigh the actual entity in a Chinese question',()=>{
 const actual=parseBingRSS(rss(item()),'你能不能帮我查一下Node.js的官方文档在哪里');
 assert.equal(actual[0].url,'https://nodejs.org/en/docs/');
 const coke=rss(item('健怡可乐简介','https://www.coca-cola.com/cn/zh/brands/diet-coke','健怡可乐是一款汽水。'));
 assert.equal(parseBingRSS(coke,'健怡可乐是什么样的，我没喝过，但这个在国外很火好像').length,1);
 assert.throws(()=>parseBingRSS(rss(item('diet dictionary','https://dictionary.org/diet','diet means food choices')),'Diet Coke official Coca Cola'));
});

test('brand-only pages and adjacent model numbers cannot satisfy a specific product query',()=>{
 for(const source of [item('Nike official products','https://www.nike.com/','Nike shoes and running products'),item('Nike Pegasus 40','https://www.nike.com/pegasus-40','Nike Pegasus 40 running shoes')])assert.throws(()=>parseBingRSS(rss(source),'Nike Pegasus 41 官方 产品'));
 assert.equal(parseBingRSS(rss(item('Nike Pegasus 41','https://www.nike.com/pegasus-41','Nike Pegasus 41 shoes')),'Nike Pegasus 41 官方 产品').length,1);
 assert.throws(()=>parseBingRSS(rss(item('OpenAI API','https://developers.openai.com/api/','OpenAI API reference')),'OpenAI "Responses API" documentation'));
 assert.throws(()=>parseBingRSS(rss(item('三角洲行动下载','https://games.org/download','三角洲行动是一款包含多名干员的游戏。')),'三角洲行动 拉闸撤离点 爆破 干员'));
 assert.equal(parseBingRSS(rss(item('三角洲行动 拉闸撤离点攻略','https://games.org/extraction','三角洲行动拉闸后撤离点的具体位置和使用干员。')),'三角洲行动 拉闸撤离点 爆破 干员').length,1);
});

const sogouCard=(title='健怡可乐介绍',url='/link?url=public-reference',snippet='这是一条关于健怡可乐的公开资料。')=>`<div class="vrwrap"><h3><a target="_blank" href="${url}">${title}</a></h3><div class="str_info">${snippet}</div></div>`;
const sogou=cards=>`<!DOCTYPE html><html><head><title>公开查询 - 搜狗搜索</title></head><body>${cards}</body></html>`;
const htmlResponse=html=>new Response(html,{headers:{'content-type':'text/html; charset=utf-8'}});

test('independent HTML parser extracts actual result cards, preserves safe redirects and ignores script fake results',()=>{
 const html=sogou('<script>'+sogouCard('健怡可乐假结果','https://evil.org/script')+'</script>'+sogouCard('<em>健怡</em>可乐介绍','/link?url=public-reference','<style>.private-css{}</style><script>PRIVATE_JS_SENTINEL</script><b>健怡</b>可乐实际摘要。')+sogouCard('重复','/link?url=public-reference')+sogouCard('危险','http://127.0.0.1/x'));
 const sources=parseSogouHTML(html,'健怡可乐');assert.equal(sources.length,1);assert.equal(sources[0].title,'健怡可乐介绍');assert.equal(sources[0].url,'https://www.sogou.com/link?url=public-reference');assert.match(sources[0].snippet,/健怡可乐实际摘要/);assert.doesNotMatch(sources[0].snippet,/PRIVATE_JS_SENTINEL|private-css/);
});

test('HTML CAPTCHA, no relevant entity and site-constrained mirrors remain failures',()=>{
 assert.throws(()=>parseSogouHTML('<html><title>搜狗安全验证</title>'+sogouCard()+'</html>','健怡可乐'),/验证/);
 assert.throws(()=>parseSogouHTML(sogou(sogouCard('Diet词典','https://dictionary.org/diet','diet nutrition')),'Diet Coke'));
 assert.throws(()=>parseSogouHTML(sogou(sogouCard('OpenAI Responses API','https://mirror.org/docs','OpenAI Responses API')),'site:developers.openai.com OpenAI Responses API'));
 assert.equal(parseSogouHTML(sogou(sogouCard('ChatGPT Work官方文档','https://learn.chatgpt.com/docs/','ChatGPT Work OpenAI文档')),'OpenAI ChatGPT 官方文档').length,1);
});

test('irrelevant RSS falls back once to the independently tested HTML provider with the same query',async()=>{
 const calls=[];const query='健怡可乐';
 const result=await searchPublicWeb(query,{fetchImpl:async(url,options)=>{calls.push({url,options});return calls.length===1?response(rss(item('健的意思','https://dictionary.org/jian','汉字健'))):htmlResponse(sogou(sogouCard()));}});
 assert.equal(calls.length,2);assert.equal(new URL(calls[0].url).hostname,'www.bing.com');assert.equal(new URL(calls[1].url).hostname,'www.sogou.com');assert.equal(new URL(calls[1].url).searchParams.get('query'),query);assert.equal(calls[1].options.redirect,'manual');assert.equal(result.provider,'sogou-html');assert.equal(result.fallbackFrom.reason,'NO_RELEVANT_RESULTS');assert.equal(result.sources.length,1);
});

test('HTML fallback cannot redirect to another host or mutate query and has only one provider attempt',async()=>{
 for(const location of ['http://127.0.0.1/web?query=健怡可乐','https://evil.org/web?query=健怡可乐','https://www.sogou.com/web?query=other','https://www.sogou.com/antispider?query=健怡可乐']){
  let calls=0;await assert.rejects(searchPublicWeb('健怡可乐',{fetchImpl:async()=>++calls===1?response(rss(item('不相关','https://food.org/','普通食物'))):new Response('',{status:302,headers:{location:encodeURI(location)}})}),/重定向/);assert.equal(calls,2);
 }
});

test('cancelling fallback closes its body without extra queries and never claims success',async()=>{
 const ac=new AbortController();let calls=0,canceled=false,started;
 const ready=new Promise(resolve=>started=resolve);
 const pending=searchPublicWeb('健怡可乐',{signal:ac.signal,fetchImpl:async()=>{
  calls++;if(calls===1)return response(rss(item('其他内容','https://food.org/','不相关资料')));
  started();return new Response(new ReadableStream({cancel(){canceled=true;}}),{headers:{'content-type':'text/html'}});
 }});
 await ready;ac.abort(Error('stop fallback'));await assert.rejects(pending,/stop fallback/);assert.equal(calls,2);assert.equal(canceled,true);
});
