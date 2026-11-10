import test from 'node:test';
import assert from 'node:assert/strict';
import {parseWeatherRequest,cityFromFollowup,looksLikeCityAnswer} from '../lib/weather-intent.mjs';
const now=Date.parse('2026-10-31T10:00:00+08:00');
const parse=(s,extra={})=>parseWeatherRequest(s,{now,...extra});

test('common Chinese weather questions extract their city and requested day',()=>{
  for(const [s,city,offset] of [['帮我看看今天广东惠州天气怎么样','广东惠州',0],['可可查下东莞明天会下雨吗','东莞',1],['东莞市天气','东莞市',0],['北京多少度','北京',0],['深圳明天要带伞吗','深圳',1],['今天惠州晚上会下雨吗','惠州',0],['我在乌鲁木齐，明天天气怎么样','乌鲁木齐',1]]){
    const r=parse(s);assert.equal(r?.city,city,s);assert.equal(r.dayOffset,offset,s);assert.equal(r.needsCity,false,s);
  }
});
test('English requests keep place names and understand tomorrow',()=>{
  for(const s of ['London weather tomorrow?','what is the weather in New York tomorrow?']){
    const r=parse(s);assert.equal(r.city,s.startsWith('London')?'London':'New York');assert.equal(r.dayOffset,1);
  }
});
test('weather questions without a city ask instead of guessing a residence',()=>{
  const r=parse('明天天气怎么样');assert.equal(r.city,null);assert.equal(r.needsCity,true);assert.equal(r.dayOffset,1);assert.match(r.clarification,/哪个城市/);
  for(const s of ['这里明天会下雨吗','你那天气怎么样','今天要不要带伞'])assert.equal(parse(s).needsCity,true,s);
});
test('only an explicitly scoped pending request interprets a bare city as an answer',()=>{
  assert.equal(parse('东莞'),null);const original=parse('明天天气怎么样');
  const r=parse('东莞',{pendingWeather:true,previousRequest:original});assert.equal(r.city,'东莞');assert.equal(r.dayOffset,1);
  assert.equal(parse('那明天呢'),null);assert.equal(parse('那明天呢',{contextCity:'惠州'}).city,'惠州');assert.equal(parse('那明天呢',{contextCity:'惠州'}).dayOffset,1);
  assert.equal(parse('南山呢',{contextCity:'深圳'}).city,'南山');
});
test('casual weather statements, metaphors and meteorology explanations do not trigger a forecast',()=>{
  for(const s of ['今天好热','今天天气真好','深圳下雨了','我心情像下雨','今天下雨了真烦','为什么会下雨','下雨的原理是什么','我刚刚吃完饭','嗯嗯','好的'])assert.equal(parse(s),null,s);
  assert.equal(parse('明天去练腿好吗',{contextCity:'惠州'}),null);
  assert.equal(parse('明天是周几',{contextCity:'惠州'}),null);
});
test('city replies reject vague locations and conversation fillers without using a small city whitelist',()=>{
  for(const [s,want] of [['呼和浩特','呼和浩特'],['景德镇市','景德镇市'],['New York','New York'],['南山呢','南山'],['周口','周口'],['北京吧','北京']]){assert.equal(cityFromFollowup(s),want);assert(looksLikeCityAnswer(s));}
  for(const s of ['这里','那边','你那里','我这边','学校','今天','明天','好的','好呀','谢谢','不了','随便','天气怎么样','here'])assert.equal(cityFromFollowup(s),null,s);
});
test('relative weekdays and weekend dates are resolved from the Shanghai date',()=>{
  assert.equal(parse('北京明天天气').dateISO,'2026-11-01');
  const weekend=parse('北京周末天气');assert.equal(weekend.dayOffset,0);assert.equal(weekend.days,2);
  assert.equal(parse('北京下周一天气').dateISO,'2026-11-02');
  assert.equal(parse('北京星期三天气').dateISO,'2026-11-04');
  assert.equal(parse('北京本周五天气').unsupportedDate,true);
  assert.equal(parseWeatherRequest('北京明天天气',{now:Date.parse('2026-10-30T17:00:00Z')}).dateISO,'2026-11-01');
});
test('absolute dates validate calendar days and reject unsupported forecast horizons',()=>{
  for(const s of ['北京11月1号天气','北京2026年11月1日天气','北京2026-11-01天气'])assert.equal(parse(s).dayOffset,1,s);
  assert.equal(parse('北京2月30号天气').unsupportedDate,true);
  assert.equal(parse('北京昨天的天气').unsupportedDate,true);
  assert.equal(parse('北京20天后天气').unsupportedDate,true);
  assert.equal(parse('北京未来三天天气').days,3);
  assert.equal(parse('北京未来一周天气').days,7);
  assert.equal(parse('北京未来十天天气').unsupportedDate,true);
  assert.equal(parse('北京未来十天天气',{maxForecastDays:16}).unsupportedDate,false);
});
test('follow-up place change retains an explicit pending forecast rather than changing to today',()=>{
  const original=parse('后天天气');const r=parse('惠州',{pendingWeather:true,previousRequest:original});assert.equal(r.city,'惠州');assert.equal(r.dayOffset,2);assert.equal(r.kind,'forecast');
  const changed=parse('那今天呢',{contextCity:'惠州',previousRequest:original});assert.equal(changed.dayOffset,0);
});
test('proper place-name characters are not stripped as generic discourse particles',()=>{
  for(const city of ['那曲','那霸','会理','会泽','多哈','乌兰察布','呼和浩特'])assert.equal(parse(city+'明天天气').city,city);
});
