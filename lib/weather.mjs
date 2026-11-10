const GEOCODING='https://geocoding-api.open-meteo.com/v1/search';
const FORECAST='https://api.open-meteo.com/v1/forecast';
const MAX_BYTES=256*1024;
const CURRENT='temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,wind_speed_10m,precipitation';
const DAILY='weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum';
const CODE_NAMES={0:'晴',1:'大部晴朗',2:'局部多云',3:'阴',45:'雾',48:'雾凇',51:'小毛毛雨',53:'中等毛毛雨',55:'强毛毛雨',56:'轻度冻毛毛雨',57:'强冻毛毛雨',61:'小雨',63:'中雨',65:'大雨',66:'轻度冻雨',67:'强冻雨',71:'小雪',73:'中雪',75:'大雪',77:'雪粒',80:'小阵雨',81:'中等阵雨',82:'强阵雨',85:'小阵雪',86:'强阵雪',95:'雷暴',96:'雷暴伴小冰雹',99:'雷暴伴大冰雹'};
const finite=(value,min,max)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
const fail=(code,message,extra={})=>Object.assign(new Error(message),{code,...extra});
const normal=value=>String(value||'').normalize('NFKC').replace(/市$/u,'').replace(/\s+/g,'').toLocaleLowerCase();
const condition=code=>Number.isInteger(code)?CODE_NAMES[code]||'天气状况暂缺':'天气状况暂缺';
const getNow=value=>typeof value==='function'?value():value===undefined?Date.now():Number(value);

export function isWeatherQuestion(text){return typeof text==='string'&&/(?:天气|气温|温度|下雨|降雨|下雪|降雪|晴不晴|会不会晴|冷不冷|热不热|几度|多少度|刮风|大风|带伞|要不要伞|会有雨|有雨吗|会有雪)/u.test(text);}

function dateInZone(ms,zone){
  try{const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(ms);const by=Object.fromEntries(parts.map(x=>[x.type,x.value]));return `${by.year}-${by.month}-${by.day}`;}
  catch{throw fail('WEATHER_UNAVAILABLE','天气服务未返回有效时区');}
}
const addDays=(date,n)=>new Date(Date.parse(date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
function displayLocation(row){const parts=[row.country,row.admin1,row.admin2,row.name].filter(x=>typeof x==='string'&&x);return [...new Set(parts)].join(' · ');}

async function readJSON(url,{signal,fetchImpl}){
  signal.throwIfAborted();
  const response=await fetchImpl(url.href,{signal,redirect:'error',headers:{Accept:'application/json','User-Agent':'Koko-WeChat/0.3 weather'}});
  if(!response.ok)throw fail('WEATHER_UNAVAILABLE',`天气服务暂不可用（${response.status}）`);
  if(!/application\/(?:[\w.+-]*\+)?json/i.test(response.headers.get('content-type')||''))throw fail('WEATHER_UNAVAILABLE','天气服务没有返回JSON数据');
  const length=Number(response.headers.get('content-length'));
  if(Number.isFinite(length)&&length>MAX_BYTES)throw fail('WEATHER_UNAVAILABLE','天气数据超出大小限制');
  if(!response.body)throw fail('WEATHER_UNAVAILABLE','天气服务返回空内容');
  const reader=response.body.getReader(),chunks=[];let size=0;
  const abort=()=>{reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  try{while(true){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES)throw fail('WEATHER_UNAVAILABLE','天气数据超出大小限制');chunks.push(value);}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}
  finally{signal.removeEventListener('abort',abort);reader.releaseLock();}
  signal.throwIfAborted();let result;
  try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail('WEATHER_UNAVAILABLE','天气服务JSON格式无效');}
  if(!result||typeof result!=='object'||Array.isArray(result)||result.error===true)throw fail('WEATHER_UNAVAILABLE','天气服务拒绝了本次查询');
  return result;
}

function eligibleLocations(rows){
  return (Array.isArray(rows)?rows:[]).filter(row=>row&&typeof row.name==='string'&&row.name&&finite(row.latitude,-90,90)&&finite(row.longitude,-180,180)&&typeof row.timezone==='string'&&/^PPL/.test(row.feature_code||''));
}
function selectLocation(rows,requested){
  const seen=new Set(),unique=eligibleLocations(rows).filter(row=>{const id=row.id||`${row.latitude},${row.longitude}`;if(seen.has(id))return false;seen.add(id);return true;});
  if(!unique.length)return null;
  const administrative=unique.filter(row=>/^PPLA|^PPLC/.test(row.feature_code));
  const candidates=administrative.length?administrative:unique;
  if(candidates.length===1)return candidates[0];
  const exact=candidates.filter(row=>normal(row.name)===normal(requested.split(/[,，]/)[0]));
  if(exact.length===1)return exact[0];
  throw fail('AMBIGUOUS_CITY','有多个同名地点，请补充省份或国家',{candidates:candidates.slice(0,6).map(row=>({name:row.name,displayName:displayLocation(row),id:row.id}))});
}

async function geocode(city,options){
  const parts=city.replace(/，/g,',').split(',');const name=parts[0].trim(),qualifier=parts.slice(1).join(',').trim();
  const withQualifier=value=>value+(qualifier?', '+qualifier:'');
  // GeoNames indexes the real Dongguan under 东莞市; searching 东莞 alone
  // returns a different same-named village. Prefer administrative city names.
  const queries=/^[\p{Script=Han}]{2,8}$/u.test(name)&&!/[市区县省]$/u.test(name)&&!['香港','澳门','台北','東京','东京','巴黎','伦敦','纽约','新加坡'].includes(name)
    ?[withQualifier(name+'市'),withQualifier(name)]:[withQualifier(name)];
  let fallback=[];
  for(const query of [...new Set(queries)]){
    const url=new URL(GEOCODING);for(const [k,v]of Object.entries({name:query,count:20,language:'zh',format:'json'}))url.searchParams.set(k,String(v));
    const result=await readJSON(url,options),rows=eligibleLocations(result.results);
    if(rows.some(row=>/^PPLA|^PPLC/.test(row.feature_code)))return selectLocation(rows,query);
    fallback.push(...rows);
  }
  const row=selectLocation(fallback,city);if(!row)throw fail('CITY_NOT_FOUND','没有找到这个城市，请补充完整城市名或省份');return row;
}

function summaryFor(data){
  const lines=[`地点：${data.city.displayName}；时区：${data.timezone}。`];
  if(data.current){const c=data.current;lines.push(`当前天气（模型估计，非气象站实测），数据时间${c.time}：${c.condition}，气温${c.temperature}℃${c.feelsLike===null?'':`，体感${c.feelsLike}℃`}${c.humidity===null?'':`，相对湿度${c.humidity}%`}${c.windSpeed===null?'':`，风速${c.windSpeed}km/h`}。`);}
  for(const d of data.daily)lines.push(`${d.date}预报：${d.condition}，最低${d.tempMin}℃，最高${d.tempMax}℃；${d.rainProbability===null?'降雨概率暂缺':`当天最高降雨概率${d.rainProbability}%`}${d.precipitation===null?'':`，预计降水${d.precipitation}mm`}。`);
  lines.push('上述是天气模型预报，不代表一定下雨；日最高降雨概率不是当前正在下雨的概率。');
  return lines.join('\n');
}

/** Fixed public endpoints only. No keys, arbitrary URLs or inferred user location. */
export async function lookupWeather({city,dayOffset=0,days=1}={}, {signal,now,fetchImpl=fetch}={}){
  if(typeof city!=='string'||!city.trim())throw fail('MISSING_CITY','请先告诉我要查哪个城市');
  city=city.trim();if(city.length>80||/[\r\n\x00-\x1f<>/:?@]/u.test(city))throw fail('INVALID_CITY','请使用城市名称，不要填写网址或完整聊天内容');
  if(!Number.isInteger(dayOffset)||dayOffset<0||dayOffset>15||!Number.isInteger(days)||days<1||days>7||dayOffset+days>16)throw fail('OUT_OF_RANGE','目前支持未来16天内、每次最多7天的天气预报');
  const at=getNow(now);if(!Number.isFinite(at))throw fail('WEATHER_UNAVAILABLE','当前时间无效');
  const timeout=AbortSignal.timeout(15000),combined=signal?AbortSignal.any([signal,timeout]):timeout;
  try{
    const location=await geocode(city,{signal:combined,fetchImpl});
    const url=new URL(FORECAST);for(const [k,v]of Object.entries({latitude:location.latitude,longitude:location.longitude,current:CURRENT,daily:DAILY,forecast_days:dayOffset+days,timezone:'auto',temperature_unit:'celsius',wind_speed_unit:'kmh',precipitation_unit:'mm'}))url.searchParams.set(k,String(v));
    const forecast=await readJSON(url,{signal:combined,fetchImpl});
    if(typeof forecast.timezone!=='string'||!finite(forecast.utc_offset_seconds,-50400,50400)||(dayOffset===0&&forecast.current_units?.temperature_2m!=='°C')||forecast.daily_units?.temperature_2m_min!=='°C'||forecast.daily_units?.temperature_2m_max!=='°C')throw fail('WEATHER_UNAVAILABLE','天气服务的时区或温度单位不完整');
    const today=dateInZone(at,forecast.timezone),daily=[];
    for(let i=0;i<days;i++){
      const date=addDays(today,dayOffset+i),index=forecast.daily?.time?.indexOf(date);
      if(!Number.isInteger(index)||index<0)throw fail('WEATHER_UNAVAILABLE','天气服务没有返回所需日期的预报，不能用其它日期代替');
      const d=forecast.daily,min=d.temperature_2m_min?.[index],max=d.temperature_2m_max?.[index];
      if(!finite(min,-100,70)||!finite(max,-100,70)||min>max)throw fail('WEATHER_UNAVAILABLE','该日期的温度预报缺失');
      const p=d.precipitation_probability_max?.[index],sum=d.precipitation_sum?.[index],code=d.weather_code?.[index];
      daily.push({date,condition:condition(code),weatherCode:Number.isInteger(code)?code:null,tempMin:min,tempMax:max,rainProbability:finite(p,0,100)?p:null,precipitation:finite(sum,0,2000)?sum:null});
    }
    let current=null;
    if(dayOffset===0){
      const c=forecast.current,time=typeof c?.time==='string'?c.time:'';
      if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(time)||!finite(c?.temperature_2m,-100,70))throw fail('WEATHER_UNAVAILABLE','当前天气数据缺失，暂时无法确认当前气温');
      const timeMs=Date.parse(time+'Z')-forecast.utc_offset_seconds*1000;
      if(!Number.isFinite(timeMs)||timeMs>at+30*60000||at-timeMs>2*3600000)throw fail('STALE_CURRENT','当前天气数据已过期，不能拿旧温度当作现在的天气');
      current={time,estimated:true,condition:condition(c.weather_code),weatherCode:Number.isInteger(c.weather_code)?c.weather_code:null,temperature:c.temperature_2m,feelsLike:finite(c.apparent_temperature,-120,90)?c.apparent_temperature:null,humidity:finite(c.relative_humidity_2m,0,100)?c.relative_humidity_2m:null,windSpeed:finite(c.wind_speed_10m,0,500)?c.wind_speed_10m:null,precipitation:finite(c.precipitation,0,1000)?c.precipitation:null};
    }
    const result={kind:'weather',provider:'open-meteo',city:{id:location.id,name:location.name,displayName:displayLocation(location),countryCode:location.country_code,admin1:location.admin1,latitude:location.latitude,longitude:location.longitude},timezone:forecast.timezone,current,daily,fetchedAt:at,dataTime:current?.time||daily[0].date,request:{city,dayOffset,days}};
    result.answer=summaryFor(result);result.sources=[{title:'Open-Meteo天气模型预报',url:url.href,snippet:result.answer}];return result;
  }catch(error){
    if(combined.aborted){if(signal?.aborted)throw signal.reason||fail('CANCELLED','天气查询已取消');throw fail('WEATHER_UNAVAILABLE','天气服务查询超时，请稍后再试');}
    if(error.code)throw error;throw fail('WEATHER_UNAVAILABLE','天气服务连接未完成，请稍后再试');
  }
}
