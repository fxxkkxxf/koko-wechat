/** Read the matching live instance without changing or restarting it. */
export async function serviceHealth(record,{fetchImpl=fetch}={}){
  if(!Number.isInteger(record?.port)||record.port<1||record.port>65535||typeof record.instance!=='string'||!record.instance)return null;
  try{
    const response=await fetchImpl(`http://127.0.0.1:${record.port}/health`,{signal:AbortSignal.timeout(1000)});
    if(!response.ok)return null;
    const health=await response.json();
    return health?.app==='koko-wechat'&&health.instance===record.instance?health:null;
  }catch{return null;}
}

/** The launcher reports the loaded service version, never its own source as live. */
export function startupReport(record,health,sourceVersion){
  const version=typeof health?.version==='string'&&/^\d+(?:\.\d+){1,3}(?:[-+][a-zA-Z0-9.-]+)?$/.test(health.version)?health.version:null;
  const restartRequired=version!==sourceVersion;
  return {ok:true,port:record.port,version,sourceVersion,restartRequired,
    message:restartRequired?`可可微信版正在运行 ${version||'未知版本'}，本地代码为 ${sourceVersion}；需重启后台才能加载本地代码`:'可可微信版已启动'};
}
