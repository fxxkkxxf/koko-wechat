import test from 'node:test';
import assert from 'node:assert/strict';
import {serviceHealth,startupReport} from '../lib/startup.mjs';

test('a live old instance is reported as old even when the local launcher source is newer',()=>{
  const result=startupReport({port:65470,token:'PRIVATE_TOKEN'}, {version:'0.3.1'},'0.4.0');
  assert.equal(result.version,'0.3.1');assert.equal(result.sourceVersion,'0.4.0');assert.equal(result.restartRequired,true);
  assert.match(result.message,/需重启后台/);assert(!JSON.stringify(result).includes('PRIVATE_TOKEN'));
});

test('a matching live version needs no restart, while an unknown version is never invented',()=>{
  assert.equal(startupReport({port:1234},{version:'0.4.0'},'0.4.0').restartRequired,false);
  for(const health of [{},{version:'bad\nversion'}]){
    const result=startupReport({port:1234},health,'0.4.0');
    assert.equal(result.version,null);assert.equal(result.restartRequired,true);assert.match(result.message,/未知版本/);
  }
});

test('health requires the exact matching instance and a successful response, not just an occupied port',async()=>{
  const record={port:1234,instance:'correct'},requests=[];
  const probe=health=>serviceHealth(record,{fetchImpl:async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>health};}});
  const matching={app:'koko-wechat',instance:'correct',version:'0.3.1'};
  assert.deepEqual(await probe(matching),matching);
  assert.equal(await probe({...matching,instance:'other'}),null);
  assert.equal(await probe({...matching,app:'other'}),null);
  assert(requests.every(x=>x.url==='http://127.0.0.1:1234/health'&&x.options.signal instanceof AbortSignal));
  assert.equal(await serviceHealth(record,{fetchImpl:async()=>({ok:false,json:async()=>matching})}),null);
  assert.equal(await serviceHealth(record,{fetchImpl:async()=>{throw Error('offline');}}),null);
});

test('invalid service markers cannot send a health request or be mistaken for a live instance',async()=>{
  for(const record of [{},{port:0,instance:'x'},{port:'1234',instance:'x'},{port:1234,instance:''}]){
    assert.equal(await serviceHealth(record,{fetchImpl:()=>assert.fail('invalid marker must not be probed')}),null);
  }
});
