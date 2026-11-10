const DAY = 86400000;
const WEEKDAYS = {'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'日':7,'天':7,'末':6};
const NUMBERS = {'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,'十一':11,'十二':12,'十三':13,'十四':14,'十五':15,'十六':16};
const WEATHER_WORDS = /天气(?:预报)?|气温|温度|体感|多少度|几度|热不热|冷不冷|下不下雨|下不下雪|下雨|下雪|降雨|降雪|刮风|带伞|拿伞|带雨伞|暴雨|雷雨|雷阵雨|\b(?:weather|temperature|forecast|rain|snow)\b/iu;
const QUESTION = /[?？]|(?:吗|么|呢|如何|怎么样|怎样|多少|几度|会不会|下不下|要不要|需不需要|是否|查|看看|看下|看一下|告诉|帮忙)|\b(?:what|how|will|is|does|do|can|forecast)\b/iu;
const TIME_WORDS = /(?:大后天|后天|明天|今天|今日|现在|当前|实时|实况|此刻|今晚|明晚|昨晚|昨天|前天|早上|上午|中午|下午|晚上|夜里|夜间|白天|凌晨|早晨|明早|今早|\b(?:today|tomorrow|tonight|now|currently)\b)/giu;
const DATE_WORDS = /(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|(?:\d{4}年)?\d{1,2}月\d{1,2}[日号]?|(?:下个?|这个?|本)?(?:周|星期)[一二三四五六日天末]|(?:未来|接下来|今后|最近|近)[一二两三四五六七八九十\d]+天|(?:未来|接下来)?一周|[一二两三四五六七八九十\d]+天[后前])/gu;
const NO_CITY = /(?:天气|气温|温度|下雨|下雪|带伞|多少度|几度|体感|预报|查询|搜索|想知道|想问|帮我|帮忙|告诉|请问|看看|怎么|什么|这里|这儿|那儿|这边|那边|你那|我这|当地|所在|哪里|哪儿|我们|你们|今天|今日|明天|后天|昨天|前天|下周|这周|本周|周几|几号|几月|星期[一二三四五六日天]|现在|当前|此刻|一会|每天|全国|全世界|会不会|要不要|需不需要|是不是|有点|需要|具体|一下|心情|好热|好冷|好累|累了|好的|好呀|好啊|好吧|谢谢|不用|不了|嗯嗯|收到|随便|都行|练腿|健身|吃饭|睡觉|觉得|不想|去练)/u;

function number(value){return /^\d+$/.test(value)?Number(value):NUMBERS[value]||null;}
function epochOf(value){const n=typeof value==='function'?value():value instanceof Date?value.getTime():Number(value);return Number.isFinite(n)?n:Date.now();}
function localDate(now){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(epochOf(now));
  const get=name=>parts.find(x=>x.type===name).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function isoDate(year,month,day){
  const date=new Date(Date.UTC(year,month-1,day));
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return null;
  return date.toISOString().slice(0,10);
}
function dateFromOffset(today,offset){return new Date(Date.parse(today+'T00:00:00Z')+offset*DAY).toISOString().slice(0,10);}
function withoutDates(text){return text.replace(DATE_WORDS,' ').replace(TIME_WORDS,' ').replace(/(?:今天和明天|明天和后天)/gu,' ').replace(/\s+/g,' ').trim();}
function removeQueryWords(value){
  return value.trim().replace(/^(?:@[\p{L}\p{N}_-]+\s+)+/u,'')
    .replace(/^(?:(?:可可|鱼神)[，,:：\s]*)+/u,'')
    .replace(/^(?:你(?:知道|觉得|搜索一下|搜一下|查一下|查询一下|看看|帮我查一下|帮我查|能查|能帮我查)|知不知道)[，,:：\s]*/u,'')
    .replace(/^(?:(?:我想问一下|我想问|我想知道|想知道|请问|麻烦|请|能不能|可不可以|可以|帮我|帮忙|给我|告诉我|查一下|查询一下|查一查|查查|查下|查询|查|看一下|看看|看下|预报|我现在在|我在|我位于|位于|在|那么)[，,:：\s]*)+/u,'')
    .replace(/^(?:(?:what(?:'s| is)?(?: the)?|how(?: is)?(?: the)?|is it|will it|does it|going to|in|at|for|the|please|check|tell me)\s+)+/iu,'')
    .replace(/^(?:的|会不会|要不要|需不需要|需要)+/u,'')
    .replace(/(?:的|会不会|会|要不要|需不需要|需要|要|不|有|是|怎么样|怎样|如何|好不好|多少|吗|么|呢|呀|啊|吧|嘛|哦|了|please)[，,。.!！?？:：\s]*$/iu,'')
    .replace(/^[，,:：\s]+|[，,。.!！?？:：\s]+$/g,'').trim();
}
function validCity(value){
  if(!value||value.length>60||NO_CITY.test(value))return false;
  if(/^(?:这|那|这儿|那儿|你|我|他|她|它|哪|什么|怎么|好|嗯|啊|呀|是|不是|也|都|还|行|可以|不行|当地|附近|家里|学校|公司|宿舍|there|here|it|my city|your city|me|you|yes|no|okay|ok|thanks|what|how|is|the)$/iu.test(value))return false;
  if(/[，,、]/u.test(value)||/^[\p{Script=Han}]{2,}(?:和|及|与|或)[\p{Script=Han}]{2,}$/u.test(value))return false;
  return /^[\p{Script=Han}·]{2,18}$/u.test(value)||/^[A-Za-z][A-Za-z .'-]{1,58}[A-Za-z]$/.test(value);
}
function cleanCandidate(value){const candidate=removeQueryWords(withoutDates(value));return validCity(candidate)?candidate:null;}

/** A bare place is only meaningful when the caller has a scoped pending request. */
export function cityFromFollowup(text){
  if(typeof text!=='string'||text.trim().length>70||WEATHER_WORDS.test(text))return null;
  return cleanCandidate(text.normalize('NFKC').trim());
}
export function looksLikeCityAnswer(text){return cityFromFollowup(text)!==null;}

function extractCity(text){
  const normalized=text.replace(/(?:下不下雨|下不下雪)/gu,s=>s.endsWith('雨')?'下雨':'下雪');
  const match=WEATHER_WORDS.exec(normalized);
  if(!match)return null;
  const before=normalized.slice(0,match.index),after=normalized.slice(match.index+match[0].length);
  // A query clause such as “我想问一下” may occur after an address or comma.
  const beforeParts=before.split(/[，,。!！?？:：]/u).reverse();
  for(const part of beforeParts){const city=cleanCandidate(part);if(city)return city;}
  const afterParts=after.replace(/\b(?:in|at|for)\b/giu,' ').split(/[，,。!！?？:：]/u);
  for(const part of afterParts){const city=cleanCandidate(part);if(city)return city;}
  return null;
}

function parseDate(text,{now,maxForecastDays=7,previousRequest=null}={}){
  const today=localDate(now),todayMs=Date.parse(today+'T00:00:00Z'),isoDow=new Date(todayMs).getUTCDay()||7;
  let dayOffset=0,days=1,explicit=false,invalid=false;
  const absolute=text.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号]?/u)||text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/u);
  if(absolute){
    explicit=true;let year=Number(absolute[1]||today.slice(0,4));let target=isoDate(year,Number(absolute[2]),Number(absolute[3]));
    if(target&&!absolute[1]&&Date.parse(target+'T00:00:00Z')-todayMs < -180*DAY)target=isoDate(year+1,Number(absolute[2]),Number(absolute[3]));
    if(!target)invalid=true;else dayOffset=Math.round((Date.parse(target+'T00:00:00Z')-todayMs)/DAY);
  }else{
    const weekdays=text.match(/(下个?|这个?|本)?(?:周|星期)([一二三四五六日天末])(?!气)/u);
    if(weekdays){
      explicit=true;const prefix=weekdays[1]||'',target=WEEKDAYS[weekdays[2]];
      if(weekdays[2]==='末'){
        if(prefix.startsWith('下')){dayOffset=7+6-isoDow;days=2;}
        else if(isoDow===7){dayOffset=0;days=1;}
        else{dayOffset=6-isoDow;days=2;}
      }else dayOffset=prefix.startsWith('下')?7+target-isoDow:prefix==='本'||prefix.startsWith('这')?target-isoDow:(target-isoDow+7)%7;
    }else{
      const span=text.match(/(?:未来|接下来|今后|近|最近)([一二两三四五六七八九十\d]+)天/u);
      const after=text.match(/([一二两三四五六七八九十\d]+)天([后前])/u);
      if(span){explicit=true;days=number(span[1])||1;}
      else if(/(?:未来|接下来|今后)?一周|这几天|未来几天/u.test(text)){explicit=true;days=7;}
      else if(after){explicit=true;dayOffset=(number(after[1])||0)*(after[2]==='前'?-1:1);}
      else if(/今天.{0,3}明天/u.test(text)){explicit=true;days=2;}
      else if(/明天.{0,3}后天/u.test(text)){explicit=true;dayOffset=1;days=2;}
      else if(/大后天/u.test(text)){explicit=true;dayOffset=3;}
      else if(/后天/u.test(text)){explicit=true;dayOffset=2;}
      else if(/明天|明早|明晚|\btomorrow\b/iu.test(text)){explicit=true;dayOffset=1;}
      else if(/前天/u.test(text)){explicit=true;dayOffset=-2;}
      else if(/昨天|昨晚|\byesterday\b/iu.test(text)){explicit=true;dayOffset=-1;}
      else if(/今天|今日|今晚|今早|\btoday\b|\btonight\b/iu.test(text)){explicit=true;}
    }
  }
  if(!explicit&&previousRequest&&Number.isInteger(previousRequest.dayOffset)){
    dayOffset=previousRequest.dayOffset;days=Number.isInteger(previousRequest.days)?previousRequest.days:1;
  }
  const unsupportedDate=invalid||dayOffset<0||days<1||dayOffset+days>maxForecastDays;
  const forecast=dayOffset!==0||days>1||/(?:早上|早晨|今早|明早|上午|中午|下午|晚上|今晚|明晚|夜间|夜里|白天|凌晨|预报|会不会|会下|带伞|拿伞|forecast|tonight)/iu.test(text)||previousRequest?.kind==='forecast'&&!explicit;
  return {dayOffset:invalid?null:dayOffset,days,kind:forecast?'forecast':'current',dateISO:invalid?null:dateFromOffset(today,dayOffset),unsupportedDate,
    ...(unsupportedDate?{clarification:invalid?'这个日期不太对，请确认一下几月几日。':dayOffset<0?'目前查询的是当前天气和未来预报，过去日期需要历史天气资料。':`目前能查未来${maxForecastDays}天的预报，想先看哪一天？`}:{})};
}

/**
 * Parse only a weather request. The caller owns scoped context and its expiry;
 * this module never reads other messages, locations, identities or memories.
 */
export function parseWeatherRequest(raw,{now=Date.now(),contextCity=null,pendingWeather=false,weatherContext=Boolean(contextCity),previousRequest=null,maxForecastDays=7}={}){
  if(typeof raw!=='string'||!raw.trim()||raw.length>12000)return null;
  const text=raw.normalize('NFKC').replace(/\r\n?/g,'\n').trim();
  const explicitWeather=WEATHER_WORDS.test(text);
  const directCity=(pendingWeather||weatherContext)?cityFromFollowup(text):null;
  const temporalOnly=Boolean(weatherContext||pendingWeather)&&/明天|后天|今天|今晚|明晚|周[一二三四五六日天末]|星期[一二三四五六日天]|\d月\d|\btomorrow\b|\btoday\b/iu.test(text)&&
    !removeQueryWords(withoutDates(text)).replace(/(?:再看看|再查|再看|那就|那么|那|的|呢|怎么样|怎样|如何|还会|还|也|会|吗)/gu,'').trim();
  if(!explicitWeather&&!directCity&&!temporalOnly)return null;
  if(!/天气|气温|温度|\b(?:weather|temperature|forecast)\b/iu.test(text)&&/(?:心情|心里|眼泪|悲伤|歌词|歌名|这首歌|小说|比喻|梦里)/u.test(text))return null;
  if(/为什么|如何形成|怎么形成|原理|成因|英文怎么说|英语怎么说|翻译/u.test(text)&&!directCity)return null;
  const city=extractCity(text)||directCity||(typeof contextCity==='string'&&validCity(contextCity)?contextCity:null);
  if(explicitWeather&&!QUESTION.test(text)&&/(?:真好|不错|真差|好热|好冷|好烦|好闷|糟透|下雨了|下雪了|热死|冷死)/u.test(text))return null;
  const dates=parseDate(text,{now,maxForecastDays,previousRequest});
  const needsCity=!city;
  return {city,...dates,needsCity,...(needsCity&&!dates.unsupportedDate?{clarification:'想查哪个城市的天气？'}:{})};
}
