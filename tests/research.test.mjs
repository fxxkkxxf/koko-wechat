import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicResearch} from '../lib/research.mjs';
import {SearchService} from '../lib/search.mjs';

const source={title:'产品官网',url:'https://www.brand.org/products/drink',snippet:'对应产品的简短说明'};
function harness({run,search,read}={}){
  let opts;const calls=[];
  const research=new PublicResearch({cwd:'.',mode:'native',getSettings:()=>({model:'saved-model',effort:'low'}),
    searchImpl:search|| (async query=>{calls.push({kind:'search',query});return {provider:'fixture',sources:[source]};}),
    readImpl:read|| (async url=>{calls.push({kind:'open',url});return {title:'官方完整产品说明',url,text:'完整正文：这是无糖饮料，配方与其它无糖产品并不相同。',truncated:false};}),
    clientFactory:value=>{opts=value;return {setModel:async(...args)=>calls.push({kind:'model',args}),reply:async args=>run(args,opts.publicTools),resetSessions:key=>calls.push({kind:'reset',key}),close(){}};}});
  return {research,calls,get opts(){return opts;}};
}
test('a separate public model chooses search and reads a page, with only public query input',async()=>{
  const f=harness({run:async(args,tools)=>{
    assert.deepEqual(args.history,[]);assert.deepEqual(args.memory,[]);assert(!('images' in args));
    const meta={sessionKey:args.sessionKey,signal:args.signal};
    const found=await tools.search_web({query:'品牌 无糖饮料 官方'},meta);assert.equal(found.ok,true);
    const page=await tools.open_page({url:found.sources[0].url},meta);assert.equal(page.ok,true);assert.match(page.text,/完整正文/);
    return {should_reply:true,reply:'这是无糖饮料，官方说明：'+page.url,remember:[],search_query:''};
  }});
  const result=await f.research.run('品牌 无糖饮料');
  assert.equal(result.provider,'public-research');assert.equal(result.pagesRead,1);assert.equal(result.sources[0].readLevel,'page');
  assert.deepEqual(result.trace.map(x=>[x.tool,x.status]),[['search_web','ready'],['open_page','ready']]);
  assert.equal(f.opts.publicToolLimit,4);assert.equal(f.research.contexts.size,0);f.research.close();
});
test('failed keyword lookup can be revised and a blocked page can be replaced within the budget',async()=>{
  let searched=0,opened=0;
  const f=harness({search:async()=>{if(!searched++)throw Error('第一次关键词无结果');return {sources:[source]};},read:async url=>{if(!opened++)throw Object.assign(Error('需要登录'),{code:'PAGE_LOGIN_REQUIRED'});return {url,title:'公开来源',text:'第二个来源的真实正文'};},run:async(args,tools)=>{
    const meta={sessionKey:args.sessionKey};assert.equal((await tools.search_web({query:'口语关键词'},meta)).ok,false);
    assert.equal((await tools.search_web({query:'品牌 产品 官方'},meta)).ok,true);
    assert.equal((await tools.open_page({url:source.url},meta)).ok,false);
    const page=await tools.open_page({url:'https://other.org/brand'},meta);assert.equal(page.ok,true);
    return {reply:'已核对 '+page.url};
  }});
  const result=await f.research.run('品牌 产品');assert.equal(result.trace.length,4);assert.equal(result.pagesRead,1);assert.equal(result.sources[0].url,'https://other.org/brand');f.research.close();
});
test('model claims of having searched are insufficient without actual successful tool evidence',async()=>{
  const f=harness({run:async()=>({reply:'我查到了 https://invented.org/fake',webSearched:true})});
  await assert.rejects(f.research.run('公开问题'),/没有取得/);assert.equal(f.research.contexts.size,0);f.research.close();
});

test('invented or missing citations cannot be backed by silently attaching an unrelated real source',async()=>{
  for(const reply of ['已核实假的结论 https://never-requested.org/invented','已核实没有引用的结论']){
    const f=harness({run:async(args,tools)=>{await tools.search_web({query:'公开问题'},{sessionKey:args.sessionKey});return {reply};}});
    const result=await f.research.run('公开问题');assert.equal(result.verification,'source-summary');
    assert(!result.answer.includes('never-requested.org'));assert(!result.answer.includes('已核实假的结论'));assert.match(result.answer,/不能视为已核实/);assert(result.answer.includes(source.url));f.research.close();
  }
});
test('private identifiers never enter public lookup, and closed query callbacks cannot run',async()=>{
  let late;
  const f=harness({run:async(args,tools)=>{late=()=>tools.search_web({query:'普通问题'},{sessionKey:args.sessionKey});return {reply:'未检索'};}});
  for(const query of ['wxid_private 资料','13300000000 谁','Bearer token','a@b.com'])await assert.rejects(f.research.run(query),/私人|关键词/);
  await assert.rejects(f.research.run('正常公开问题'),/没有取得/);await assert.rejects(late(),/已关闭/);
  assert.equal(f.calls.filter(x=>x.kind==='search').length,0);f.research.close();
});
test('a fifth public tool request is blocked instead of continuing a lookup loop',async()=>{
  const f=harness({run:async(args,tools)=>{
    const meta={sessionKey:args.sessionKey};for(let i=0;i<4;i++)await tools.search_web({query:'公开问题 '+i},meta);
    await assert.rejects(tools.open_page({url:source.url},meta),/次数限制/);return {reply:source.url};
  }});
  const result=await f.research.run('公开问题');assert.equal(result.trace.length,4);f.research.close();
});
test('search service preserves researched page evidence and clears old results on a newer failure',async()=>{
  let fail=false;
  const service=new SearchService({getSettings:()=>({webSearchEnabled:true}),searchImpl:async()=>{if(fail)throw Error('当前来源不可用');return {provider:'public-research',answer:'依据完整正文的结论',sources:[{...source,readLevel:'page'}],pagesRead:1,trace:[{tool:'open_page',status:'ready'}]};}});
  const first=await service.run('第一问题');assert.equal(first.answer,'依据完整正文的结论');assert.equal(first.pagesRead,1);assert.equal(first.sources[0].readLevel,'page');
  fail=true;await assert.rejects(service.run('第二问题'),/当前来源不可用/);assert.equal(service.snapshot().lastResult,null);assert.match(service.snapshot().error,/当前来源/);assert.equal(service.snapshot().lastAttempt.query,'第二问题');service.close();
});

test('structured public plans search, open a source reference and only then compose an answer',async()=>{
  const calls=[],seen=[];let opts;
  const research=new PublicResearch({cwd:'.',getSettings:()=>({model:'saved',effort:'low'}),
    searchImpl:async(query)=>{calls.push(['search',query]);return {sources:[source]};},
    readImpl:async(url)=>{calls.push(['open',url]);return {url,title:'官方说明',text:'已读取的完整事实 CODE-PAGE-928'};},
    clientFactory:value=>{opts=value;return {setModel:async()=>{},resetSessions(){},close(){},reply:async args=>{
      const input=JSON.parse(args.text);seen.push({input,args});
      if(seen.length===1)return {should_reply:false,reply:'',search_query:'search:品牌 无糖饮料 官方'};
      if(seen.length===2){assert.equal(input.observations[0].sources[0].ref,'S1');return {should_reply:false,reply:'',search_query:'open:S1'};}
      assert.match(input.observations[1].text,/CODE-PAGE-928/);return {should_reply:true,reply:'已核实CODE-PAGE-928 '+source.url,search_query:''};
    }};}});
  const result=await research.run('品牌 无糖饮料');
  assert.equal(opts.publicPlanning,true);assert(!opts.publicTools);assert.equal(seen.length,3);
  assert.deepEqual(calls,[['search','品牌 无糖饮料 官方'],['open',source.url]]);assert.equal(result.pagesRead,1);
  assert(seen.every(x=>!x.args.history.length&&!x.args.memory.length&&!('images' in x.args)));research.close();
});

test('the planned executor forces a final response after four real actions and cannot loop',async()=>{
  const flags=[];let invoked=0;
  const research=new PublicResearch({cwd:'.',getSettings:()=>({model:'saved'}),searchImpl:async()=>{invoked++;return {sources:[source]};},
    clientFactory:()=>({setModel:async()=>{},resetSessions(){},close(){},reply:async args=>{
      flags.push([args.searchEnabled,args.searchResolved]);
      return flags.length<=4?{search_query:'search:公开问题 '+flags.length,reply:''}:{search_query:'',reply:'只总结已查到的来源 '+source.url};
    }})});
  const result=await research.run('公开问题');assert.equal(invoked,4);assert.equal(result.trace.length,4);assert.deepEqual(flags.at(-1),[false,true]);research.close();
});

test('cancelling a cold public client releases research before initialization finishes',{timeout:1500},async()=>{
  let ready,started=false,replied=false,seenSignal;
  const research=new PublicResearch({clientFactory:()=>({
    setModel:async(model,effort,{signal})=>{started=true;seenSignal=signal;await new Promise(r=>ready=r);},
    reply:async()=>{replied=true;return {reply:'不应执行'};},resetSessions(){},close(){}
  })});
  const abort=new AbortController(),pending=research.run('公开问题',{signal:abort.signal});
  assert(started);const rejected=assert.rejects(pending,/测试取消/);abort.abort(Error('测试取消'));await rejected;
  assert(seenSignal.aborted);assert.equal(research.contexts.size,0);
  ready();await new Promise(r=>setImmediate(r));assert.equal(replied,false);research.close();
});

test('closing public research interrupts a waiting planner without waiting for its late result',{timeout:1500},async()=>{
  let respond,started=false,networkCalls=0;
  const research=new PublicResearch({searchImpl:async()=>{networkCalls++;return {sources:[source]};},
    clientFactory:()=>({setModel:async()=>{},reply:async()=>{started=true;return new Promise(r=>respond=r);},resetSessions(){},close(){}})});
  const pending=research.run('公开问题');while(!started)await new Promise(r=>setImmediate(r));
  const rejected=assert.rejects(pending,/已关闭/);research.close();await rejected;
  respond({search_query:'search:迟到计划',reply:''});await new Promise(r=>setImmediate(r));
  assert.equal(networkCalls,0);assert.equal(research.contexts.size,0);
});
