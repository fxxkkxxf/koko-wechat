import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SearchService,searchQuery,needsSearch,sourceLinks} from '../lib/search.mjs';
test('public query strips credentials and direct identifiers without pulling history',()=>{assert(!searchQuery('帮查 18800000000 a@b.com wxid_abc Bearer secret').includes('secret'));assert.equal(searchQuery('x'.repeat(601)),'');assert(needsSearch('查一下今天的天气'));assert(!needsSearch('晚上好呀'));assert(!needsSearch('我今天刚吃过饭，最近有点累'));assert.deepEqual(sourceLinks('http://127.0.0.1/a https://example.com/docs?q=a'),[{title:'example.com',url:'https://example.com/docs?q=a'}]);});
const fixture=()=>{const calls=[];const settings={webSearchEnabled:true,model:'luna'};const backend={run:async(query,options)=>{calls.push({query,options});return {sources:[{title:'资料',url:'https://example.com/docs',snippet:'文档内容'}],provider:'test-public-web'};}};return {calls,settings,backend,service:new SearchService({searchImpl:(...args)=>backend.run(...args),getSettings:()=>settings})};};

test('a URL beside Chinese prose does not swallow the question or inflate the query beyond its limit',()=>{
  const query=searchQuery('请直接读取https://www.example.org/article.html的公开攻略，核实怎样配合手雷。给出原文来源。');
  assert(query.includes('公开攻略'));assert(query.includes('配合手雷'));assert(!query.includes('%E'));
  const privateLink=searchQuery('https://example.org/资料?token=PRIVATE#private 介绍');assert(!privateLink.includes('PRIVATE'));assert(!privateLink.includes('#private'));
});
test('search uses only independent public query and reuses a short cache',async()=>{const f=fixture();const a=await f.service.run('最新官方文档');await f.service.run('最新官方文档');assert.equal(f.calls.length,1);assert.equal(f.calls[0].query,'最新官方文档');assert.deepEqual(Object.keys(f.calls[0].options),['signal']);assert.equal(a.sources.length,1);});
test('empty network search cannot be reported as verified and disabled search never runs',async()=>{const f=fixture();f.backend.run=async()=>({sources:[]});await assert.rejects(f.service.run('搜索 Node.js'),/没有取得/);f.settings.webSearchEnabled=false;await assert.rejects(f.service.run('搜索 Node.js'),/尚未开启/);});
test('switching off while searching discards late result',async()=>{const f=fixture();let done;f.backend.run=async()=>new Promise(r=>done=r);const pending=f.service.run('搜索 Node.js');while(!done)await new Promise(r=>setImmediate(r));f.settings.webSearchEnabled=false;f.service.clear();done({sources:[{title:'资料',url:'https://example.com/docs',snippet:'文档'}]});await assert.rejects(pending,/取消/);assert.equal(f.service.lastResult,null);});

test('an aborted queued lookup exits promptly without letting the next lookup overtake active work',{timeout:1500},async()=>{
  const f=fixture(),calls=[];let finishFirst;
  f.backend.run=async query=>{calls.push(query);if(query==='第一问题')await new Promise(r=>finishFirst=r);return {sources:[{title:query,url:'https://example.com/docs',snippet:query}]};};
  const first=f.service.run('第一问题');while(!finishFirst)await new Promise(r=>setImmediate(r));
  const abort=new AbortController(),second=f.service.run('第二问题',{signal:abort.signal});
  const rejected=assert.rejects(second,/取消排队/);abort.abort(Error('取消排队'));await rejected;
  const third=f.service.run('第三问题');await new Promise(r=>setImmediate(r));assert.deepEqual(calls,['第一问题']);
  finishFirst();await Promise.all([first,third]);assert.deepEqual(calls,['第一问题','第三问题']);f.service.close();
});

test('clear releases active and queued work even if a backend ignores cancellation, with no late overwrite',{timeout:1500},async()=>{
  const f=fixture();let finishOld;
  f.backend.run=async query=>{if(query==='旧问题')await new Promise(r=>finishOld=r);return {sources:[{title:query,url:'https://example.com/docs',snippet:query}]};};
  const old=f.service.run('旧问题');while(!finishOld)await new Promise(r=>setImmediate(r));const queued=f.service.run('排队旧问题');
  const rejected=[assert.rejects(old,/取消/),assert.rejects(queued,/取消/)];f.service.clear();await Promise.all(rejected);
  const current=await f.service.run('新问题');assert.equal(current.query,'新问题');
  finishOld();await new Promise(r=>setImmediate(r));assert.equal(f.service.lastResult.query,'新问题');f.service.close();
});
