import test from 'node:test';
import assert from 'node:assert/strict';
import {lookupWeather,isWeatherQuestion} from '../lib/weather.mjs';
const NOW=Date.parse('2026-10-31T04:00:00Z');
const city={id:1812545,name:'东莞市',latitude:23.01797,longitude:113.74866,feature_code:'PPLA2',timezone:'Asia/Shanghai',country_code:'CN',country:'中国',admin1:'广东'};
const weather=()=>({timezone:'Asia/Shanghai',utc_offset_seconds:28800,current_units:{temperature_2m:'°C'},daily_units:{temperature_2m_min:'°C',temperature_2m_max:'°C'},current:{time:'2026-10-31T12:00',temperature_2m:25,apparent_temperature:28,weather_code:0,relative_humidity_2m:78,wind_speed_10m:5.8,precipitation:0},daily:{time:['2026-10-31','2026-11-01','2026-11-02'],weather_code:[3,61,63],temperature_2m_min:[23,22,21],temperature_2m_max:[32,31,30],precipitation_probability_max:[0,72,51],precipitation_sum:[0,4.6,2.4]}});
const response=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
function fixture({locations=[city],forecast=weather()}={}){const calls=[];return {calls,fetchImpl:async(raw,options)=>{const url=new URL(raw);calls.push({url,options});return response(url.hostname.startsWith('geocoding-')?{results:locations}:forecast);}};}

test('weather intent includes rain, temperature and umbrella questions without classifying ordinary chitchat',()=>{
 for(const text of ['东莞明天天气怎么样','今天会下雨吗','现在多少度','要不要带伞','深圳冷不冷'])assert.equal(isWeatherQuestion(text),true,text);
 for(const text of ['晚上好','深岩银河是什么','我喜欢蓝色'])assert.equal(isWeatherQuestion(text),false,text);
});
test('missing city, malformed locations and out-of-range dates never make a network call',async()=>{
 let calls=0;const options={fetchImpl:async()=>{calls++;throw Error('must not fetch');}};
 await assert.rejects(lookupWeather({},options),{code:'MISSING_CITY'});
 for(const city of ['http://localhost/','广州\n北京','x'.repeat(81)])await assert.rejects(lookupWeather({city},options),{code:'INVALID_CITY'});
 for(const extra of [{dayOffset:16},{dayOffset:-1},{days:0},{days:8},{dayOffset:15,days:2}])await assert.rejects(lookupWeather({city:'东莞',...extra},options),{code:'OUT_OF_RANGE'});
 assert.equal(calls,0);
});
test('Dongguan is queried as an administrative city, with verified current time and source attribution',async()=>{
 const f=fixture();const result=await lookupWeather({city:'东莞'},{...f,now:NOW});
 assert.equal(f.calls[0].url.searchParams.get('name'),'东莞市');assert.equal(result.city.latitude,23.01797);
 assert.equal(result.current.temperature,25);assert.equal(result.current.estimated,true);assert.equal(result.current.time,'2026-10-31T12:00');
 assert.equal(result.daily[0].rainProbability,0);assert.equal(result.daily[0].precipitation,0);assert.match(result.answer,/非气象站实测/);
 assert.equal(new URL(result.sources[0].url).hostname,'api.open-meteo.com');assert.ok(result.sources[0].url.length<=500);
 assert(f.calls.every(x=>x.options.redirect==='error'));
});
test('tomorrow means the next local calendar date and does not require a current-conditions observation',async()=>{
 const forecast=weather();delete forecast.current;delete forecast.current_units;
 const f=fixture({forecast}),r=await lookupWeather({city:'东莞',dayOffset:1},{...f,now:NOW});
 assert.equal(r.current,null);assert.equal(r.daily[0].date,'2026-11-01');assert.equal(r.daily[0].rainProbability,72);
 assert.equal(r.daily[0].tempMin,22);assert.equal(f.calls[1].url.searchParams.get('forecast_days'),'2');assert.match(r.answer,/2026-11-01/);
});
test('date boundaries use the returned location timezone rather than the execution host',async()=>{
 const forecast=weather();forecast.current.time='2026-10-31T00:00';forecast.daily.time=['2026-10-31','2026-11-01'];
 const f=fixture({forecast});const result=await lookupWeather({city:'东莞',dayOffset:1},{...f,now:Date.parse('2026-10-30T16:01:00Z')});
 assert.equal(result.daily[0].date,'2026-11-01');
});
test('stale current values are rejected but future dated forecasts remain independently usable',async()=>{
 const forecast=weather();forecast.current.time='2026-10-30T12:00';
 const f=fixture({forecast});await assert.rejects(lookupWeather({city:'东莞'},{...f,now:NOW}),{code:'STALE_CURRENT'});
 assert.equal((await lookupWeather({city:'东莞',dayOffset:1},{...f,now:NOW})).daily[0].date,'2026-11-01');
});
test('missing current data, missing dates, null temperatures and wrong units are not turned into fabricated weather',async()=>{
 const variants=[];let v=weather();v.current.temperature_2m=null;variants.push(v);v=weather();v.daily.time=['2026-10-30'];variants.push(v);v=weather();v.daily.temperature_2m_min[0]=null;variants.push(v);v=weather();v.current_units.temperature_2m='°F';variants.push(v);
 for(const forecast of variants)await assert.rejects(lookupWeather({city:'东莞'},{...fixture({forecast}),now:NOW}),{code:'WEATHER_UNAVAILABLE'});
});
test('missing rain probability is explicitly absent rather than zero, and WMO rain codes are readable',async()=>{
 const forecast=weather();forecast.daily.precipitation_probability_max[1]=null;
 const result=await lookupWeather({city:'东莞',dayOffset:1},{...fixture({forecast}),now:NOW});
 assert.equal(result.daily[0].rainProbability,null);assert.match(result.answer,/降雨概率暂缺/);assert.equal(result.daily[0].condition,'小雨');
});
test('unknown cities and true same-name administrative cities produce explicit clarification errors',async()=>{
 await assert.rejects(lookupWeather({city:'不存在的城市'},{...fixture({locations:[]}),now:NOW}),{code:'CITY_NOT_FOUND'});
 const other={...city,id:2,name:'朝阳市',admin1:'吉林',latitude:43,longitude:125};const original={...city,id:1,name:'朝阳市',admin1:'辽宁',latitude:41,longitude:120};
 const f=fixture({locations:[original,other]});
 await assert.rejects(lookupWeather({city:'朝阳'},{...f,now:NOW}),error=>error.code==='AMBIGUOUS_CITY'&&error.candidates.length===2);
 assert.equal(f.calls.length,1);
});
test('a similarly named village cannot outrank the requested administrative city',async()=>{
 const village={...city,id:1915095,name:'东莞',latitude:20.30008,longitude:109.99004,feature_code:'PPL'};
 const result=await lookupWeather({city:'东莞'},{...fixture({locations:[village,city]}),now:NOW});assert.equal(result.city.id,1812545);
});
test('HTTP failures, captcha HTML, malformed JSON and oversized bodies fail without returning snippets as weather',async()=>{
 const failures=[new Response('',{status:429}),new Response('<html>captcha</html>',{headers:{'content-type':'text/html'}}),new Response('{oops',{headers:{'content-type':'application/json'}}),new Response('{}',{headers:{'content-type':'application/json','content-length':'999999'}}),new Response(JSON.stringify({x:'x'.repeat(270000)}),{headers:{'content-type':'application/json'}})];
 for(const failure of failures)await assert.rejects(lookupWeather({city:'东莞'},{now:NOW,fetchImpl:async()=>failure}),{code:'WEATHER_UNAVAILABLE'});
});
test('caller cancellation closes a pending weather response body immediately',async()=>{
 const ac=new AbortController();let cancelled=false;
 const body=new ReadableStream({start(){},cancel(){cancelled=true;}});
 const pending=lookupWeather({city:'东莞'},{now:NOW,signal:ac.signal,fetchImpl:async()=>new Response(body,{headers:{'content-type':'application/json'}})});
 await new Promise(r=>setTimeout(r,5));ac.abort(Error('stop-weather'));
 await assert.rejects(pending,/stop-weather/);assert.equal(cancelled,true);
});
