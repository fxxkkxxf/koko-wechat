import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Store,readJSON,writeJSON} from './lib/store.mjs';
import {BridgeClient} from './lib/bridge.mjs';
import {CodexClient} from './lib/codex.mjs';
import {ChatController,bindingTargets} from './lib/chat.mjs';
import {chooseDefaultModel,modelKey,fastestEffort} from './lib/models.mjs';
import {normalizeGroup,toggleGroupProactive} from './lib/groups.mjs';
import {normalizeParticipants,selectedContacts} from './lib/participants.mjs';
import {MemoryEngine} from './lib/memory.mjs';
import {SearchService} from './lib/search.mjs';
import {PublicResearch} from './lib/research.mjs';
import {OWNER_FIELDS,normalizeOwner} from './lib/identity.mjs';
import {serviceHealth,startupReport} from './lib/startup.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const runtime=readJSON(path.join(root,'runtime.local.json'),{});
const data=path.resolve(process.env.KOKO_WECHAT_HOME||runtime.state_directory||path.join(os.homedir(),'.koko-wechat'));
const marker=path.join(data,'service.json');
const VERSION='0.7.3';
function open(url){const child=spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{detached:true,stdio:'ignore',windowsHide:true});child.on('error',()=>{});child.unref();}
async function ensure(){fs.mkdirSync(data,{recursive:true});let record=readJSON(marker,{}),health=await serviceHealth(record);if(!health){const log=fs.openSync(path.join(data,'service.log'),'a');const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--serve'],{detached:true,windowsHide:true,stdio:['ignore',log,log],cwd:root,env:{...process.env,KOKO_WECHAT_HOME:data}});child.unref();fs.closeSync(log);for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,150));record=readJSON(marker,{});health=await serviceHealth(record);if(health)break;}if(!health)throw Error('可可微信版没有启动，请查看service.log');}if(process.argv.includes('--open'))open(`http://127.0.0.1:${record.port}/#token=${record.token}`);process.stdout.write(JSON.stringify(startupReport(record,health,VERSION))+'\n');}
async function serve(){
  fs.mkdirSync(data,{recursive:true});const store=new Store(data,fs.readFileSync(path.join(root,'assets','persona.txt'),'utf8'));const cfg=store.data.settings;
  cfg.expectedAccountName ||= runtime.expectedAccountName||'';cfg.expectedChatName ||= runtime.expectedChatName||'';cfg.expectedGroupName ||= runtime.expectedGroupName||'';store.save();
  cfg.webSearchEnabled ??= false;store.save();
  if(!['background','foreground'].includes(cfg.textSendMode))cfg.textSendMode='background';
  if(!['auto','utf16','gbk'].includes(cfg.textEncoding))cfg.textEncoding='auto';
  store.save();
  fs.mkdirSync(path.join(data,'model'),{recursive:true});const model=new CodexClient({cwd:path.join(data,'model'),executable:runtime.codex,forceHttp:true});
  fs.mkdirSync(path.join(data,'research'),{recursive:true});
  const research=new PublicResearch({cwd:path.join(data,'research'),executable:runtime.codex,getSettings:()=>cfg});
  const search=new SearchService({getSettings:()=>cfg,searchImpl:(query,options)=>research.run(query,options)});const memory=new MemoryEngine({store,model});
  const bridge=new BridgeClient({root,python:runtime.python,stateDirectory:path.join(data,'bridge')});const controller=new ChatController({store,model,bridge,memory,search});
  let modelReady=null;const initializeModel=()=>modelReady??=(async()=>{await model.connect();const models=await model.models();const selected=chooseDefaultModel(models,cfg.model||'');if(!selected)throw Error('当前账号没有可用模型');const effort=cfg.model===selected&&cfg.effort?cfg.effort:fastestEffort(models.find(x=>modelKey(x)===selected));await model.setModel(selected,effort);cfg.model=selected;cfg.effort=model.status().effort||effort;store.save();return model.status();})().catch(e=>{modelReady=null;throw e;});
  bridge.on('message',msg=>controller.receive(msg));
  bridge.on('status',s=>{if(s.error)store.event('bridge','微信桥接：'+s.error);});
  const prior=readJSON(marker,{});const token=/^[a-f0-9]{48}$/.test(prior.token||'')?prior.token:crypto.randomBytes(24).toString('hex');const instance=crypto.randomBytes(12).toString('hex');let origin;
  const json=(res,status,x)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(x));};
  const authorized=req=>{const a=Buffer.from(req.headers.authorization||''),b=Buffer.from('Bearer '+token);return a.length===b.length&&crypto.timingSafeEqual(a,b)&&(!req.headers.origin||req.headers.origin===origin);};
  const reviewTarget=chatId=>bindingTargets({...cfg,contacts:(cfg.contacts||selectedContacts(cfg)).map(x=>({...x,enabled:true})),groups:cfg.groups.map(x=>({...x,enabled:true}))}).find(x=>x.chatId===chatId);
  const pendingDelivery=()=>{
    const ledger=readJSON(path.join(data,'bridge','bridge-sends.json'),{}),items=[];
    for(const entry of Object.values(ledger)){
      if(entry.kind==='batch'||entry.reviewed||entry.accountId!==cfg.accountId||!['sending','unconfirmed'].includes(entry.status))continue;
      const target=reviewTarget(entry.chatId);if(!target)continue;
      const parentId=String(entry.id).split(':part:')[0],parent=ledger[parentId];
      const part=parent?.parts?.find(x=>x.id===entry.id);
      items.push({id:entry.id,chatId:entry.chatId,chatName:target.name,status:entry.status,text:entry.text||part?.text||'',createdAt:entry.createdAt,message:entry.message});
    }
    return {items:items.slice(-30),count:items.length};
  };
  const state=()=>({version:VERSION,settings:store.data.settings,bridge:bridge.status(),codex:{...model.status(),error:model.status().lastError},events:store.data.events,conversations:store.data.conversations,localChat:store.data.conversations.filter(x=>x.sessionKey==='local-preview'),memory:store.data.memory,summaries:memory.snapshot().summaries,memoryStats:memory.snapshot().stats,search:search.snapshot(),delivery:{pending:pendingDelivery()},recovery:controller.recovery.snapshot().filter(row=>row.accountId===cfg.accountId&&bindingTargets(cfg).some(target=>target.chatId===row.chatId)),current:controller.snapshot()});
  let diagnosing=false;
  let reconfiguring=false;
  const primaryOf=targets=>targets.find(x=>x.chatId===cfg.chatId)?.chatId||targets.find(x=>x.type==='private')?.chatId||'';
  const directory=async()=>{
    if(!cfg.accountId)throw Error('请先绑定微信小号');const accountId=cfg.accountId;let offset=0,first=null,items=[];
    do{const page=await bridge.call('directory',{accountId,offset,limit:500});if(cfg.accountId!==accountId)throw Error('小号已变更，请重新加载');first ||= page;items.push(...page.items);offset=page.nextOffset;}while(offset!==null&&offset!==undefined&&items.length<3000);
    return {...first,items,total:first.total,nextOffset:offset,truncated:offset!==null&&offset!==undefined};
  };
  const reconfigureParticipants=async(next)=>{
    if(reconfiguring)throw Error('会话设置正在更新，请稍候');if(!cfg.accountId)throw Error('请先绑定微信小号');
    reconfiguring=true;const before={groups:cfg.groups,contacts:cfg.contacts};const wasEnabled=cfg.enabled;
    try{
      const targets=bindingTargets({...cfg,...next});if(targets.filter(x=>x.type==='group').length>10||targets.filter(x=>x.type==='private').length>20)throw Error('最多同时开启10个群和20个私聊');
      await controller.pause();const bound=targets.length?await bridge.call('bind',{accountId:cfg.accountId,chatId:primaryOf(targets),targets}):{targets:[]};
      cfg.contacts=next.contacts;cfg.groups=next.groups.map(group=>{const target=bound.targets?.find(x=>x.chatId===group.chatId||x.id===group.chatId);return {...group,name:target?.name||target?.chatName||group.name,aliases:group.aliases.length?group.aliases:['可可',cfg.expectedAccountName].filter(Boolean)};});
      store.save();if(wasEnabled&&targets.length)await controller.enable();store.event('groups',targets.length?'参与会话已更新，原有接话规则已保留':'已取消全部参与会话，自动回复已暂停');return {contacts:cfg.contacts,groups:cfg.groups,enabled:cfg.enabled};
    }catch(e){cfg.groups=before.groups;if(before.contacts===undefined)delete cfg.contacts;else cfg.contacts=before.contacts;store.save();try{const targets=bindingTargets(cfg);if(targets.length){await bridge.call('bind',{accountId:cfg.accountId,chatId:primaryOf(targets),targets});if(wasEnabled)await controller.enable();}}catch{}throw e;}
    finally{reconfiguring=false;}
  };
  const reconfigureGroups=next=>reconfigureParticipants({groups:next,contacts:selectedContacts(cfg)});
  const changeMemory=async(fn)=>{const wasEnabled=cfg.enabled;await controller.pause();try{return await fn();}finally{if(wasEnabled&&bindingTargets(cfg).length)await controller.enable();}};
  const action=async(name,params)=>{
    switch(name){
      case 'diagnose': {
        if(diagnosing)return {pending:true};diagnosing=true;store.event('diagnosing','正在检测微信和Codex连接');
        Promise.allSettled([initializeModel(),bridge.connect().then(()=>bridge.call('doctor',{ui:cfg.accountId?'background':false}))]).then(results=>{for(const x of results)if(x.status==='rejected')store.event('error',x.reason.message);const result=results[1].status==='fulfilled'?results[1].value:null;if(result?.error)store.event('error',result.error);store.event('diagnosed',result?.controls?result.controls.ready?'连接检测完成，微信聊天控件可读取':'检测到微信窗口，但聊天控件仍不可读，请回到聊天页后重试':'连接检测已完成',result?.controls?{controls:result.controls}:{});}).finally(()=>{diagnosing=false;});return {pending:true};
      }
      case 'accounts': await bridge.connect();return await bridge.call('accounts');
      case 'directory': return directory();
      case 'participants-save': {const listing=await directory();return reconfigureParticipants(normalizeParticipants(params,{settings:cfg,directory:listing}));}
      case 'contacts': {if(typeof params.accountId!=='string'||!params.accountId)throw Error('请先选择小号');return await bridge.call('contacts',{accountId:params.accountId,query:typeof params.query==='string'?params.query:cfg.expectedChatName||''});}
      case 'groups': {if(!cfg.accountId)throw Error('请先绑定微信小号');if(params.accountId&&params.accountId!==cfg.accountId)throw Error('群聊应接在当前已绑定小号下');return await bridge.call('groups',{accountId:cfg.accountId,query:typeof params.query==='string'?params.query:cfg.expectedGroupName||''});}
      case 'group-save': {const priorGroup=cfg.groups.find(x=>x.chatId===params.chatId);const value=normalizeGroup(params,priorGroup);return reconfigureGroups([...cfg.groups.filter(x=>x.chatId!==value.chatId),value]);}
      case 'group-proactive': {const group=cfg.groups.find(x=>x.chatId===params.chatId);const next=toggleGroupProactive(group,params.enabled);const result=await reconfigureGroups(cfg.groups.map(x=>x.chatId===next.chatId?next:x));store.event('groups',next.mode==='smart'?'群「'+next.name+'」已允许主动加入正在进行的话题':'群「'+next.name+'」已关闭主动搭话',{chatId:next.chatId});return result;}
      case 'group-toggle': {const group=cfg.groups.find(x=>x.chatId===params.chatId);if(!group)throw Error('群尚未接入');const next=normalizeGroup({chatId:params.chatId,enabled:params.enabled},group);return reconfigureGroups(cfg.groups.map(x=>x.chatId===next.chatId?next:x));}
      case 'group-remove': {if(typeof params.chatId!=='string'||!cfg.groups.some(x=>x.chatId===params.chatId))throw Error('群尚未接入');return reconfigureGroups(cfg.groups.filter(x=>x.chatId!==params.chatId));}
      case 'bind': {
        if(typeof params.accountId!=='string'||typeof params.chatId!=='string'||!params.accountId||!params.chatId)throw Error('请选择小号和聊天对象');
        if(reconfiguring)throw Error('会话设置正在更新');await controller.pause();const accountChanged=cfg.accountId&&cfg.accountId!==params.accountId;const contacts=accountChanged?[]:selectedContacts(cfg);const nextContacts=[...contacts.filter(x=>x.chatId!==params.chatId),{chatId:params.chatId,name:'',enabled:true}];const candidate={...cfg,accountId:params.accountId,chatId:params.chatId,contacts:nextContacts,groups:accountChanged?[]:cfg.groups};const bound=await bridge.call('bind',{accountId:params.accountId,chatId:params.chatId,targets:bindingTargets(candidate)});cfg.accountId=params.accountId;cfg.chatId=params.chatId;cfg.contacts=nextContacts.map(c=>({...c,name:bound.targets?.find(x=>x.chatId===c.chatId)?.name||c.name}));if(accountChanged){cfg.groups=[];Object.assign(cfg,{ownerEnabled:false,ownerId:'',ownerName:'',ownerTitle:'主人',ownerAccountId:''});search.clear();model.resetSessions();}if(bound.accountName)cfg.expectedAccountName=bound.accountName;if(bound.chatName||bound.targetName)cfg.expectedChatName=bound.chatName||bound.targetName;store.save();store.event('bound','微信目标已绑定');return bound;
      }
      case 'models': await initializeModel();return {models:await model.models(),selected:cfg.model};
      case 'prepare': await initializeModel();controller.prepare().catch(e=>store.event('error','模型预热失败：'+e.message));return {pending:true};
      case 'enable': await initializeModel();await controller.enable();return {enabled:true};
      case 'pause': await controller.pause();return {enabled:false};
      case 'recovery-resume': {
        if(typeof params.chatId!=='string'||!bindingTargets(cfg).some(row=>row.chatId===params.chatId))throw Error('请选择当前已开启的会话');
        if(pendingDelivery().items.some(row=>row.chatId===params.chatId))throw Error('此会话仍有待核对的发送记录，请先逐条核对');
        controller.recovery.clear(cfg.accountId+':'+params.chatId);store.event('recovered','已继续接收后续新消息，不重发旧回复',{chatId:params.chatId});return {resumed:true,resent:false};
      }
      case 'review-send': {
        if(typeof params.id!=='string'||!params.id||params.id.length>300||typeof params.chatId!=='string')throw Error('请选择待核对记录');
        const target=reviewTarget(params.chatId);if(!target||!pendingDelivery().items.some(x=>x.id===params.id&&x.chatId===params.chatId))throw Error('待核对记录不在当前小号已配置的会话中');
        const wasEnabled=cfg.enabled;await controller.pause();const original=bindingTargets(cfg);
        try{
          const targets=original.some(x=>x.chatId===target.chatId)?original:[...original,target];
          await bridge.call('bind',{accountId:cfg.accountId,chatId:primaryOf(targets),targets});
          const result=await bridge.call('review_send',{id:params.id,accountId:cfg.accountId,chatId:params.chatId,action:'acknowledge'});
          if(!pendingDelivery().items.some(row=>row.chatId===params.chatId))controller.recovery.clear(cfg.accountId+':'+params.chatId);
          store.event('reviewed','已跳过旧的待核对回复，不会重发；后续只处理新的来信',{chatId:params.chatId,chatName:target.name});return result;
        }finally{
          if(wasEnabled&&original.length)await controller.enable();
          else if(original.length)await bridge.call('bind',{accountId:cfg.accountId,chatId:primaryOf(original),targets:original});
        }
      }
      case 'settings': {
        if(Object.keys(params).some(k=>!['persona','groupPersona','model','effort','webSearchEnabled','textSendMode','textEncoding',...OWNER_FIELDS].includes(k)))throw Error('设置字段不受支持');
        if(Object.hasOwn(params,'textSendMode')||Object.hasOwn(params,'textEncoding')){
          const mode=params.textSendMode??cfg.textSendMode,encoding=params.textEncoding??cfg.textEncoding;
          if(!['background','foreground'].includes(mode)||!['auto','utf16','gbk'].includes(encoding))throw Error('发送方式或后台编码无效');
          const wasEnabled=cfg.enabled;await controller.pause();cfg.textSendMode=mode;cfg.textEncoding=encoding;store.save();
          if(wasEnabled&&bindingTargets(cfg).length)await controller.enable();
          store.event('settings',mode==='background'?'文字已切换为后台发送，不自动转前台':'文字已切换为前台兼容发送');
        }
        if(OWNER_FIELDS.some(k=>Object.hasOwn(params,k))){const value=normalizeOwner(params,cfg,await directory());const wasEnabled=cfg.enabled;await controller.pause();model.resetSessions();Object.assign(cfg,value);store.save();if(wasEnabled&&bindingTargets(cfg).length)await controller.enable();store.event('settings',cfg.ownerEnabled?'创作者身份已绑定，按真实微信ID识别':'创作者身份识别已关闭');}
        if(Object.hasOwn(params,'webSearchEnabled')){if(typeof params.webSearchEnabled!=='boolean')throw Error('联网开关格式不正确');const wasEnabled=cfg.enabled;await controller.pause();cfg.webSearchEnabled=params.webSearchEnabled;search.clear();store.save();if(wasEnabled&&bindingTargets(cfg).length)await controller.enable();store.event('settings',cfg.webSearchEnabled?'联网查资料已开启':'联网查资料已关闭');}
        if(Object.hasOwn(params,'persona')){if(typeof params.persona!=='string'||params.persona.length>20000)throw Error('人设最多20000字');cfg.persona=params.persona;store.save();store.event('settings','可可人设已保存');}
        if(Object.hasOwn(params,'groupPersona')){if(typeof params.groupPersona!=='string'||params.groupPersona.length>20000)throw Error('群聊人设最多20000字');cfg.groupPersona=params.groupPersona;store.save();store.event('settings','群聊公开角色设定已保存');}
        if(Object.hasOwn(params,'model')){if(typeof params.model!=='string')throw Error('请选择有效模型');await initializeModel();const list=await model.models();const row=list.find(x=>modelKey(x)===params.model);if(!row)throw Error('该模型当前账号不可用');await controller.pause();const effort=params.effort||fastestEffort(row);await model.setModel(params.model,effort);cfg.model=params.model;cfg.effort=model.status().effort||effort;store.save();store.event('model','聊天模型已切换为 '+cfg.model+'，自动回复保持暂停');}
        return {saved:true,model:cfg.model,effort:cfg.effort};
      }
      case 'test-chat': {await initializeModel();if(controller.testBusy)throw Error('上一条试聊还在生成');if(typeof params.text!=='string'||!params.text.trim()||params.text.length>6000)throw Error('请输入1—6000字');controller.test(params.text).catch(()=>{});return {pending:true};}
      case 'search-test': {if(typeof params.query!=='string'||!params.query.trim())throw Error('请输入公开查询问题');search.run(params.query,{force:true}).catch(e=>store.event('search-error',e.message));return {pending:true};}
      case 'memory-delete': return changeMemory(()=>memory.remove(params.id));
      case 'memory-clear': return changeMemory(()=>memory.clear(params));
      case 'clear-memory': return changeMemory(()=>memory.clear());
      case 'context-compress': {if(typeof params.routeKey!=='string'||!store.data.conversations.some(x=>x.sessionKey===params.routeKey))throw Error('请选择有聊天记录的会话');memory.maintain(params.routeKey,{force:true}).catch(e=>store.event('memory-error',e.message));return {pending:true};}
      default: throw Error('不支持的操作');
    }
  };
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if(req.headers.host!==new URL(origin).host)return json(res,403,{ok:false,error:'Host不匹配'});
    if(req.url==='/health'&&req.method==='GET')return json(res,200,{app:'koko-wechat',instance,version:VERSION});
    if(req.url?.startsWith('/api/')){
      if(!authorized(req))return json(res,403,{ok:false,error:'管理口令已失效，请通过桌面入口重新打开'});
      try{
        if(req.url==='/api/state'&&req.method==='GET')return json(res,200,state());
        if(req.url!=='/api/action'||req.method!=='POST')return json(res,404,{ok:false,error:'未找到接口'});
        if(!req.headers['content-type']?.startsWith('application/json'))throw Error('仅接受JSON');let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>65536)return json(res,413,{ok:false,error:'请求过大'});}const payload=JSON.parse(body);if(!payload||typeof payload!=='object'||Array.isArray(payload)||typeof payload.action!=='string')throw Error('操作格式错误');const params=payload.params??{};if(!params||typeof params!=='object'||Array.isArray(params))throw Error('参数格式错误');return json(res,200,{ok:true,data:await action(payload.action,params)});
      }catch(e){return json(res,400,{ok:false,error:String(e.message||e).slice(0,500)});}
    }
    const url=new URL(req.url,origin);const rel=url.pathname==='/'?'index.html':url.pathname.slice(1);if(req.method!=='GET')return json(res,405,{ok:false,error:'不支持此方法'});
    const base=rel.startsWith('assets/')?root:path.join(root,'ui');const file=path.resolve(base,rel);if(!file.startsWith(base+path.sep))return json(res,403,{ok:false,error:'路径不可访问'});
    try{const ext=path.extname(file);const contentType={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.ico':'image/x-icon'}[ext];if(!contentType)return json(res,404,{ok:false,error:'未找到文件'});const content=fs.readFileSync(file);res.writeHead(200,{'Content-Type':contentType});res.end(content);}catch{return json(res,404,{ok:false,error:'未找到页面'});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(process.env.KOKO_WECHAT_PORT||runtime.port||65470),'127.0.0.1',resolve);});origin=`http://127.0.0.1:${server.address().port}`;writeJSON(marker,{port:server.address().port,pid:process.pid,token,instance});
  bridge.connect().then(()=>cfg.accountId&&bindingTargets(cfg).length?bridge.call('bind',{accountId:cfg.accountId,chatId:primaryOf(bindingTargets(cfg)),targets:bindingTargets(cfg)}):null).catch(e=>store.event('error',e.message));initializeModel().catch(e=>store.event('error','Codex连接：'+e.message));
  // Restart never replays a pending send. Explicitly reopen listening only after a fresh bind.
  if(cfg.enabled){cfg.enabled=false;store.save();store.event('paused','服务重新启动，已暂停回复；核对微信连接后可重新开启');}
  process.stdout.write('可可微信版运行在本机端口 '+server.address().port+'\n');
  const close=()=>{memory.close();search.close();research.close();bridge.close();model.close();server.close();};process.on('SIGTERM',close);process.on('SIGINT',close);
}
if(process.argv.includes('--serve'))await serve();else await ensure();
