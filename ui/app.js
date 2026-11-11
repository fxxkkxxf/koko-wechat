(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const tokenKey = 'koko-wechat-token';
  const fragment = new URLSearchParams(location.hash.slice(1));
  const suppliedToken = fragment.get('token');
  if (suppliedToken) {
    sessionStorage.setItem(tokenKey, suppliedToken);
    history.replaceState(null, '', location.pathname + location.search);
  }
  const token = sessionStorage.getItem(tokenKey) || '';
  let state = null;
  let accounts = [];
  let contacts = [];
  let personaInitialized = false;
  let personaDirty = false;
  let bindingDirty = false;
  let refreshFlight = null;
  let localMessages = [];
  let localPending = null;
  let lastRemoteChat = '';
  let noticeTimer = null;
  let selectionVersion = 0;
  let models = [];
  let modelDirty = false;
  let modelsInitialized = false;
  let contactQueryInitialized = false;
  let contactQueryDirty = false;
  let groupCandidates = [];
  let groupQueryInitialized = false;
  let groupRevision = 0;
  let groupSearchVersion = 0;
  let groupPolicyDirty = false;
  let groupListSignature = '';
  let groupPersonaInitialized = false;
  let groupPersonaDirty = false;
  let directoryRows = [];
  let directoryAccount = '';
  let directoryLoaded = false;
  let directoryMeta = {};
  let participantsDirty = false;
  let participantsRevision = 0;
  let participantsSignature = '';
  let participantsRenderSignature = '';
  let participantSelection = new Map();
  let participantPageSize = 80;
  let memorySignature = '';
  let searchSettingInitialized = false;
  let searchSettingDirty = false;
  let searchResultSignature = '';
  let ownerDirty = false;
  let ownerAccount = null;
  let ownerRevision = 0;
  let ownerOptionsSignature = '';
  let activitySignature = '';
  let currentSignature = '';
  let deliverySignature = '';
  let sendModeDirty = false;
  const expandedActivityText = new Set();
  const pending = new Set();

  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const string = value => value == null ? '' : String(value);
  const firstText = (...values) => values.find(value => typeof value === 'string' && value.trim()) || '';
  const accountId = row => firstText(row?.accountId, row?.id, row?.wxid, row?.username);
  const contactId = row => firstText(row?.chatId, row?.id, row?.wxid, row?.username, row?.userName);
  const accountName = row => firstText(row?.accountName, row?.name, row?.nickname, row?.nickName, row?.displayName, accountId(row));
  const contactName = row => firstText(row?.remark, row?.remarkName, row?.displayName, row?.chatName, row?.name, row?.nickname, row?.nickName, contactId(row));
  const modelId = row => firstText(row?.model, row?.id);
  const contactQuery = () => $('contactQuery').value.trim() || firstText(state?.settings?.expectedChatName);
  const groupId = row => firstText(row?.chatId,row?.id,row?.username);
  const groupName = row => firstText(row?.name,row?.groupName,row?.chatName,row?.title,groupId(row));
  const savedGroups = () => Array.isArray(state?.settings?.groups) ? state.settings.groups : [];
  const enabledGroups = () => savedGroups().filter(row=>row.enabled!==false);
  const groupAccountId = () => firstText(state?.settings?.accountId,$('accountSelect').value);
  const privateParticipants = () => Array.isArray(state?.settings?.contacts) ? state.settings.contacts.filter(row=>row.enabled!==false) : state?.settings?.chatId ? [{chatId:state.settings.chatId,name:state.settings.expectedChatName,type:'private',enabled:true}] : [];
  const participantKey = row => (row.type==='group'?'group:':'private:')+contactId(row);
  const savedParticipants = () => [...privateParticipants().map(row=>({...row,type:'private',chatId:contactId(row),name:contactName(row)})),...enabledGroups().map(row=>({...row,type:'group',chatId:groupId(row),name:groupName(row)}))].filter(row=>row.chatId);

  function error(message) {
    $('globalError').textContent = string(message);
    $('globalError').classList.toggle('hidden', !message);
  }
  function notice(message) {
    clearTimeout(noticeTimer);
    $('globalNotice').textContent = string(message);
    $('globalNotice').classList.toggle('hidden', !message);
    if (message) noticeTimer = setTimeout(() => $('globalNotice').classList.add('hidden'), 5000);
  }
  async function request(path, options = {}) {
    if (!token) throw new Error('管理页口令未载入，请通过桌面「可可微信版」入口重新打开。');
    const response = await fetch(path, {
      ...options,
      headers: {'Authorization': 'Bearer ' + token, ...(options.body ? {'Content-Type': 'application/json'} : {}), ...options.headers},
      cache: 'no-store'
    });
    let result;
    try { result = await response.json(); } catch { throw new Error('后台没有返回有效结果，请重新打开管理页。'); }
    if (!response.ok || result?.ok === false) throw new Error(firstText(result?.error?.message, result?.error, result?.message) || `请求未完成（${response.status}）`);
    return result && Object.prototype.hasOwnProperty.call(result, 'data') ? result.data : result;
  }
  const action = (name, params = {}) => request('/api/action', {method: 'POST', body: JSON.stringify({action: name, params})});

  async function task(name, button, fn) {
    if (pending.has(name)) return;
    pending.add(name);
    const oldLabel = button?.textContent;
    if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
    error('');
    try { return await fn(); }
    catch (err) {
      if (name === 'models') {
        if (!models.length) fillSelect($('modelSelect'),[],row=>row.id,row=>row.name,'未取得模型，请刷新');
        $('modelNote').textContent = '可用模型读取未完成，请确认 Codex 连接后点击右侧刷新。';
      }
      error(err.message || String(err));
    }
    finally {
      pending.delete(name);
      if (button) { button.removeAttribute('aria-busy'); if (oldLabel && name === 'test-chat') button.textContent = oldLabel; }
      controls();
    }
  }
  function controls() {
    const settings = object(state?.settings);
    const enabled = settings.enabled === true;
    $('autoToggle').disabled = !state || pending.has('auto') || (!enabled && !(settings.accountId && (privateParticipants().length || enabledGroups().length)));
    $('autoToggleLabel').textContent = enabled ? '暂停自动回复' : '开启自动回复';
    $('takeOver').disabled = !state || pending.has('auto') || !enabled;
    $('diagnose').disabled = pending.has('diagnose');
    $('loadAccounts').disabled = pending.has('accounts') || pending.has('diagnose');
    $('loadContacts').disabled = !$('accountSelect').value || !contactQuery() || pending.has('contacts') || pending.has('diagnose');
    $('accountSelect').disabled = pending.has('bind');
    $('contactSelect').disabled = !$('accountSelect').value || pending.has('contacts') || pending.has('bind');
    $('bind').disabled = !$('accountSelect').value || !$('contactSelect').value || pending.has('bind');
    $('testSend').disabled = pending.has('test-chat') || Boolean(localPending);
    $('savePersona').disabled = pending.has('persona');
    $('clearMemory').disabled = pending.has('memory') || !(filteredMemoryRows().length || filteredSummaries().length);
    $('compressContext').disabled = pending.has('memory') || !$('memoryScope').value.startsWith('route:') || Number(state?.memoryStats?.pending)>0;
    $('loadModels').disabled = pending.has('models') || pending.has('model');
    $('modelSelect').disabled = pending.has('models') || pending.has('model') || !models.length;
    $('saveModel').disabled = pending.has('model') || !modelDirty || !$('modelSelect').value;
    $('loadGroups').disabled = !groupAccountId() || !$('groupQuery').value.trim() || pending.has('groups-list') || pending.has('group-mutate');
    $('groupSelect').disabled = (!groupCandidates.length && !$('groupSelect').value) || pending.has('groups-list') || pending.has('group-mutate');
    $('saveGroup').disabled = !settings.accountId || !$('groupSelect').value || pending.has('group-mutate') || pending.has('groups-list');
    $('saveGroupPersona').disabled = pending.has('group-persona');
    $('clearGroupDraft').disabled = pending.has('group-mutate');
    const currentGroup = savedGroups().find(row=>groupId(row)===$('groupSelect').value);
    $('saveGroup').textContent = currentGroup ? '更新这个群' : '添加这个群';
    for(const button of document.querySelectorAll('[data-group-action]')) button.disabled=pending.has('group-mutate');
    $('loadDirectory').disabled = !settings.accountId || pending.has('directory') || pending.has('participants');
    $('saveParticipants').disabled = !settings.accountId || !participantsDirty || pending.has('participants') || pending.has('group-mutate');
    $('resetParticipants').disabled = !participantsDirty || pending.has('participants');
    $('selectFiltered').disabled = !participantMatches().length || pending.has('participants');
    $('clearFiltered').disabled = !participantMatches().some(row=>participantSelection.has(participantKey(row))) || pending.has('participants');
    for(const checkbox of document.querySelectorAll('[data-participant-checkbox]'))checkbox.disabled=pending.has('participants');
    for(const button of document.querySelectorAll('[data-memory-delete]'))button.disabled=pending.has('memory');
    for(const button of document.querySelectorAll('[data-review-send]'))button.disabled=pending.has('delivery-review:'+button.dataset.reviewSend);
    for(const button of document.querySelectorAll('[data-recovery-resume]'))button.disabled=pending.has('recovery:'+button.dataset.recoveryResume);
    $('saveSearchSetting').disabled = !searchSettingDirty || pending.has('search-settings');
    $('webSearchEnabled').disabled = pending.has('search-settings');
    $('testSearch').disabled = !$('searchQuery').value.trim() || pending.has('search-test') || state?.search?.status==='searching';
    $('loadOwnerContacts').disabled = !settings.accountId || pending.has('directory') || pending.has('owner');
    for(const id of ['ownerEnabled','ownerSelect','ownerName','ownerTitle'])$(id).disabled=pending.has('owner');
    $('saveOwner').disabled = !settings.accountId || !ownerDirty || pending.has('owner') || ($('ownerEnabled').checked && !$('ownerSelect').value);
  }
  function statusLight(id, status) { $(id).className = 'status-light' + (status ? ' ' + status : ''); }
  function date(value) {
    if (!value) return '';
    let d = typeof value === 'number' && value < 1e12 ? new Date(value * 1000) : new Date(value);
    if (!Number.isFinite(d.getTime())) return string(value).slice(0, 30);
    return d.toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false});
  }
  function duration(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return '';
    return number < 1000 ? Math.round(number) + 'ms' : (number / 1000).toFixed(number < 10000 ? 1 : 0) + 's';
  }
  function render() {
    if (!state) return;
    const settings = object(state.settings), bridge = object(state.bridge), codex = object(state.codex);
    $('version').textContent = 'v' + string(state.version || '0.1').replace(/^v/, '');
    $('pageConnection').className = 'connection online';
    $('pageConnection').lastChild.textContent = '本地后台已连接';
    const enabled = settings.enabled === true;
    $('autoStatus').textContent = enabled ? '自动回复已开启' : '自动回复已暂停';
    $('autoStatus').classList.toggle('enabled', enabled);
    const bound = Boolean(settings.accountId && settings.chatId);
    const groupTotal = enabledGroups().length, privateTotal=privateParticipants().length;
    const chosenAccount = accounts.find(row => accountId(row) === settings.accountId);
    const chosenContact = contacts.find(row => contactId(row) === settings.chatId);
    const currentAccount = firstText(bridge.accountName, settings.accountName, accountName(chosenAccount));
    const currentTarget = firstText(bridge.targetName, settings.chatName, settings.targetName, contactName(chosenContact));
    if (bound && !bindingDirty) {
      if (!accounts.length) fillSelect($('accountSelect'),[{accountId:settings.accountId,accountName:currentAccount||'已绑定小号'}],accountId,accountName,'选择你的小号',settings.accountId);
      if (!contacts.length) fillSelect($('contactSelect'),[{chatId:settings.chatId,chatName:currentTarget||'已绑定联系人'}],contactId,contactName,'选择联系人',settings.chatId);
    }
    $('connectTitle').textContent = bound ? '微信已经接好' : '接上你的微信';
    $('connectionIntro').textContent = bound ? `${currentAccount||'小号'}已绑定。聊天范围以「参与会话」为准；更换账号时再操作这里。` : '先登录电脑微信，再让可可认准小号和首次聊天对象。';
    $('autoHint').textContent = !privateTotal && !groupTotal ? '在「参与会话」里勾选联系人或群聊，再开启自动回复。' : enabled ? `正在接收${privateTotal?privateTotal+' 个私聊':''}${privateTotal&&groupTotal?'和':''}${groupTotal?groupTotal+' 个已开启群聊':''}的新消息，需要时自动回复。` : '参与会话已保存。开启后，可可会在指定会话里自动回复。';
    $('accountHelp').textContent = settings.expectedAccountName ? '预期小号：' + settings.expectedAccountName : '选择你已登录的小号';
    $('contactHelp').textContent = settings.expectedChatName ? '首次私聊：' + settings.expectedChatName+'，参与范围可在左侧调整。' : '绑定后可在「参与会话」中调整回复范围。';
    if (!contactQueryInitialized) {
      if (!contactQueryDirty) $('contactQuery').value = firstText(settings.expectedChatName);
      contactQueryInitialized = true;
    }
    const bridgeReady = bridge.available === true || bridge.ready === true;
    $('bridgeStatus').textContent = bridge.error ? '需要处理' : bridgeReady ? (currentAccount || '微信已就绪') : bridge.connected ? '桥接已连接' : '等待检测';
    $('bridgeDetail').textContent = firstText(bridge.error?.message, bridge.error, bridge.message, bridge.detail) || (bridgeReady ? '微信小号已连接' : bridge.connected ? '等待识别已登录的小号' : '小号需要在电脑微信中登录');
    statusLight('bridgeLight', bridge.error ? 'bad' : bridgeReady ? 'good' : bridge.connected ? 'busy' : '');
    $('codexStatus').textContent = codex.error ? '需要处理' : codex.authenticated === false ? '需要登录' : codex.connected && codex.authenticated === true ? '已连接并登录' : codex.connected ? '已连接' : '等待检测';
    $('codexDetail').textContent = firstText(codex.error?.message, codex.error, codex.message) || (codex.model ? '当前模型 · ' + codex.model : codex.authenticated === false ? '请先在 Codex 中登录' : '使用本机已登录的账号');
    const effortNames = {none:'无额外思考',minimal:'轻量思考',low:'低思考',medium:'中等思考',high:'高思考',xhigh:'更高思考'};
    const effort = firstText(codex.effort,settings.effort);
    $('modelCurrent').textContent = (settings.model || codex.model) ? '当前 · ' + firstText(codex.model, settings.model) + (effort ? ' · ' + (effortNames[effort] || effort) : '') : '连接后可选择本账号支持的模型';
    if (!modelDirty && modelsInitialized && settings.model && models.some(row => modelId(row) === settings.model)) $('modelSelect').value = settings.model;
    statusLight('codexLight', codex.error || codex.authenticated === false ? 'bad' : codex.connected ? 'good' : '');
    $('targetStatus').textContent = privateTotal || groupTotal ? [privateTotal?privateTotal+' 个私聊':'',groupTotal?groupTotal+' 个群聊':''].filter(Boolean).join(' · ') : '尚未选择';
    $('targetDetail').textContent = privateTotal || groupTotal ? `${currentAccount || '小号'} · 在「参与会话」统一管理` : '勾选后点击「应用选择」';
    statusLight('targetLight', privateTotal || groupTotal ? 'good' : '');
    $('bindingNote').textContent = bound ? '已绑定。实际回复范围以已应用的参与会话为准。' : '绑定后，自动回复仍由顶部开关控制。';
    if (!personaInitialized) {
      if (!personaDirty) $('persona').value = string(settings.persona);
      personaInitialized = true;
    }
    renderCurrent();
    renderDeliveryReview();
    renderRecovery();
    renderEvents();
    renderMemory();
    renderGroups();
    renderParticipants();
    renderOwner();
    renderSearch();
    renderSendMode();
    ingestRemoteChat();
    renderChat();
    controls();
  }

  const phaseNames = {received:'收到消息', message:'收到消息', inbox:'收到消息', queued:'消息已排队', generating:'可可正在想', thinking:'可可正在想', model:'正在生成回复', vision:'图片处理', searching:'正在联网核实', sending:'正在发送', sent:'已发送', confirmed:'已本地核对', unconfirmed:'发送结果待核对', uncertain:'发送结果待核对', blocked:'发送已停止', cancelled:'后续短句已停止', skipped:'这条先不接话', ignored:'这条先不接话', error:'需要处理', failed:'处理未完成', paused:'自动回复已暂停', enabled:'自动回复已开启', connected:'连接已就绪', binding:'绑定会话', test:'本地试聊', complete:'处理完成', completed:'处理完成'};
  function phaseName(value) { return phaseNames[string(value).toLowerCase()] || string(value) || '互动记录'; }
  const eventType = event => string(event.kind || event.type || event.stage || event.status).toLowerCase();
  const receivedTypes = new Set(['received','message','inbox']);
  const replyTypes = new Set(['sending','sent','confirmed','unconfirmed','uncertain','blocked','cancelled']);
  const eventTime = value => {const time=value?.at||value?.time||value?.timestamp||value?.createdAt;const number=typeof time==='number'?time:Date.parse(time||'');return Number.isFinite(number)?number:0;};
  const safeDiagnostic = value => string(value).replace(/(?:\b[A-Za-z]:[\\/]|\\\\)[^\r\n<>"']+/g,'[本机路径已隐藏]').replace(/\/(?:Users|home|tmp)\/[^\r\n<>"']+/g,'[本机路径已隐藏]').replace(/\b(?:Bearer\s+|sk-)\S+/gi,'[凭证已隐藏]').replace(/\bwxid_[A-Za-z0-9_-]+/g,'[账号ID已隐藏]');
  function sourceMessages(event) {
    if (Array.isArray(event.sourceMessages) && event.sourceMessages.length) return event.sourceMessages.filter(row=>row&&typeof row.text==='string').slice(-12);
    const ids = Array.isArray(event.sourceEventIds)?event.sourceEventIds:[];
    if(ids.length && event.chatId && Array.isArray(state.conversations)){
      const key=firstText(event.accountId,state.settings?.accountId)+':'+event.chatId;
      const rows=state.conversations.filter(row=>row.role==='user'&&ids.includes(row.eventId)&&row.chatId===event.chatId&&(!row.sessionKey||row.sessionKey===key)&&(!event.senderId||row.senderId===event.senderId));
      const linked=ids.map(id=>rows.filter(row=>row.eventId===id));
      if(linked.every(matches=>matches.length===1))return linked.map(matches=>matches[0]).slice(-12).map(row=>({eventId:row.eventId,text:string(row.text),senderId:row.senderId,senderName:row.senderName,...(row.image?{image:row.image}:{})}));
    }
    if(receivedTypes.has(eventType(event))&&typeof event.text==='string')return [{eventId:event.eventId,text:event.text,senderId:event.senderId,senderName:event.senderName,...(event.image?{image:event.image}:{})}];
    return [];
  }
  function messageText(parent, label, text, key, kind='incoming') {
    const block=document.createElement('div');block.className='activity-message '+kind;
    const caption=document.createElement('span');caption.className='activity-message-label';caption.textContent=label;block.append(caption);
    const value=string(text);
    if(value.length>280||value.split('\n').length>5){
      const details=document.createElement('details');details.className='activity-full-text';details.open=expandedActivityText.has(key);
      const summary=document.createElement('summary');summary.textContent=value.slice(0,145)+(value.length>145?'…':'')+'（展开全文）';
      const full=document.createElement('p');full.textContent=value;details.append(summary,full);
      details.addEventListener('toggle',()=>{if(details.open)expandedActivityText.add(key);else expandedActivityText.delete(key);if(expandedActivityText.size>150)expandedActivityText.delete(expandedActivityText.values().next().value);});block.append(details);
    }else{const p=document.createElement('p');p.textContent=value;block.append(p);}
    parent.append(block);return block;
  }
  function imageState(parent, value, {model=false,placeholder=false}={}) {
    const image=object(value),count=Number.isInteger(image.count)?Math.max(0,Math.min(4,image.count)):0;
    const names={original:'原图',compressed:'压缩图',thumbnail:'缩略图',received:'已接收图片'};
    const sources=(Array.isArray(image.sources)?image.sources:[]).map(x=>names[x]).filter(Boolean);
    let text='',bad=false;
    if(model){
      if(image.modelStatus==='submitting')text='正在提交模型（附带'+count+'张图片）';
      else if(image.modelStatus==='response_received')text='模型已返回（附带'+count+'张图片）';
      else if(image.modelStatus==='failed'){bad=true;text=(/^IMAGE_/.test(image.modelErrorCode||'')?'模型未接受图片':'图片请求未完成')+'：'+(safeDiagnostic(image.modelError)||'请查看图片读取状态');}
      else if(image.modelStatus==='not_submitted')text=count?'图片尚未提交模型':'图片未交给模型';
    }else{
      const reason=safeDiagnostic(image.reason||'');
      if(image.status==='ready'||image.status==='partial')text='已读取'+count+'张'+(sources.length?'（'+[...new Set(sources)].join('、')+'）':'');
      if(image.status==='partial'){bad=true;text+='，另有'+(Number.isInteger(image.failedCount)?Math.max(1,image.failedCount):1)+'张未读取'+(reason?'：'+reason:'');}
      if(image.status==='failed'){bad=true;text='未读取：'+(reason||'没有取得可交给模型的图片文件');}
      if(image.status==='pending')text='图片读取中，尚未交给模型';
      if(!text&&placeholder){bad=true;text='这条旧记录未保存图片读取状态，不能据此判断识图成功';}
    }
    if(!text)return;
    const line=document.createElement('p');line.className='activity-image-state'+(bad?' image-failed':'');line.dataset.imageStatus=model?string(image.modelStatus):string(image.status||'unknown');line.textContent=text;parent.append(line);
  }
  function messagePair(parent, event, key, {current=false}={}) {
    const type=eventType(event),sources=sourceMessages(event);
    if(event.trigger==='smart'){const note=document.createElement('p');note.className='activity-reply-state';note.textContent='主动搭话 · '+(/ignored/.test(type)?'本轮选择旁听':type==='sent'?'已加入当前话题':'判断是否加入当前话题');parent.append(note);}
    for(const [index,row] of sources.entries()){
      const block=messageText(parent,'收到的消息'+(row.senderName?' · '+row.senderName:''),row.text,key+':source:'+(row.eventId||index));
      imageState(block,row.image,{placeholder:/^\s*\[图片\]\s*$/.test(row.text)});
    }
    imageState(parent,event.image,{model:true});
    const reply=firstText(event.replyText,event.reply)||(replyTypes.has(type)?firstText(event.text):'');
    const parts=Array.isArray(event.result?.parts)?event.result.parts.filter(row=>typeof row.text==='string'):[];
    if(parts.length){
      const statuses={confirmed:'已确认发送',uncertain:'待核对',unconfirmed:'待核对',blocked:'未发送',cancelled:'已停止',skipped:'未发送'};
      for(const [index,part] of parts.entries()){
        const block=messageText(parent,'可可的回复 · 第'+(Number.isInteger(part.index)?part.index+1:index+1)+'条 · '+(statuses[part.status]||'待核对'),part.text,key+':reply:'+index,'outgoing '+(part.status==='confirmed'?'delivered':'pending-delivery'));
        inputDiagnostic(block,part.inputDiagnostic);
      }
    }else if(reply)messageText(parent,(type==='sending'?'准备发送的回复':/error|failed|blocked|cancelled/.test(type)?'未完成发送的回复':'可可的回复')+(type==='unconfirmed'||type==='uncertain'?' · 待核对':''),reply,key+':reply','outgoing');
    else if(sources.length&&!receivedTypes.has(type)){
      const pending=document.createElement('p');pending.className='activity-reply-state';pending.textContent=type==='recovery'?'本轮未全部发送，见上方会话运行状态':/ignored|skipped/.test(type)?'本次没有回复':/error|failed|blocked|cancelled/.test(type)?'本次未完成回复':type==='searching'?'正在查资料，尚未形成回复':'正在组织回复';parent.append(pending);
    }
    if(reply&&!sources.length&&!current){const note=document.createElement('p');note.className='activity-unlinked';note.textContent='这条旧记录未关联原消息';parent.append(note);}
    if(!parts.length)inputDiagnostic(parent,event.result?.inputDiagnostic);
    if(/blocked|uncertain|unconfirmed/.test(type)){const note=document.createElement('p');note.className='activity-recovery';note.textContent='请先查看微信中的实际发送结果；核对后再恢复自动回复，避免重复发送。';parent.append(note);}
  }
  function inputDiagnostic(parent,value){
    if(!value||!Number.isInteger(value.expectedChars)||value.expectedChars<0||value.expectedChars>5000)return;
    const observed=value.observedChars;if(observed!==null&&(!Number.isInteger(observed)||observed<0||observed>5000))return;
    const line=document.createElement('p');line.className='activity-reply-state';line.textContent='输入核对：计划 '+value.expectedChars+' 字符，'+(observed===null?'输入框暂时不可读':'实际读到 '+observed+' 字符')+'；该条未点击发送。';parent.append(line);
  }
  function renderCurrent() {
    const current = state.current;
    $('currentTask').classList.toggle('hidden', !current);
    if (!current) {currentSignature='';$('currentMessages').replaceChildren();return;}
    $('currentTitle').textContent = safeDiagnostic(firstText(current.message, current.title)) || phaseName(current.stage || current.status || current.type);
    $('currentDetail').textContent = [firstText(current.chatName, current.targetName),firstText(current.senderName),safeDiagnostic(current.detail||''),duration(current.elapsedMs)].filter(Boolean).join(' · ');
    const signature=JSON.stringify(current);if(signature===currentSignature)return;currentSignature=signature;
    const box=$('currentMessages');box.replaceChildren();
    const sources=sourceMessages(current);
    const value=sources.length?current:{...current,sourceMessages:typeof current.text==='string'?[{text:current.text,senderName:current.senderName,...(current.image?{image:current.image}:{})}]:[]};
    messagePair(box,value,'current:'+(current.jobVersion||current.startedAt||''),{current:true});
  }
  function renderDeliveryReview(){
    const value=state.delivery?.pending,items=(Array.isArray(value)?value:Array.isArray(value?.items)?value.items:[]).filter(row=>row&&!row.reviewed&&typeof row.id==='string'&&typeof row.chatId==='string');
    $('deliveryReview').classList.toggle('hidden',!items.length);
    const signature=JSON.stringify(items);if(signature===deliverySignature)return;deliverySignature=signature;
    $('deliveryReviewCount').textContent=items.length+' 条待核对';const list=$('deliveryReviewList');list.replaceChildren();
    for(const row of items.slice(0,20)){
      const card=document.createElement('div');card.className='delivery-review-item';
      const target=[...savedParticipants(),...directoryRows].find(item=>contactId(item)===row.chatId);
      const meta=document.createElement('p');meta.className='delivery-review-meta';meta.textContent=[firstText(row.chatName,target?.name,'已选择的会话'),date(row.sentAt||row.createdAt),row.status==='blocked'?'发送被阻止':'发送结果待核对'].filter(Boolean).join(' · ');card.append(meta);
      if(row.text)messageText(card,'当时准备发送的回复',row.text,'review:'+row.id,'outgoing pending-delivery');
      else{const note=document.createElement('p');note.className='activity-unlinked';note.textContent='旧记录没有保留完整回复，请在微信中按时间核对。';card.append(note);}
      const button=document.createElement('button');button.type='button';button.className='button secondary small';button.dataset.reviewSend=row.id;button.textContent='已核对，跳过旧消息';button.disabled=pending.has('delivery-review:'+row.id);
      button.addEventListener('click',()=>task('delivery-review:'+row.id,button,async()=>{await action('review-send',{id:row.id,chatId:row.chatId});await refresh(true);notice('旧消息已跳过，不会重新发送。');}));card.append(button);list.append(card);
    }
  }
  const recoveryRows=()=>Array.isArray(state?.recovery)?state.recovery:[];
  function recoveryText(row){
    if(row.kind==='review')return '开关已开启 · 发送状态待核对';
    if(row.kind==='attention')return '开关已开启 · 等待修复连接或目标设置';
    const seconds=Math.max(0,Math.ceil((Number(row.until)-Date.now())/1000));
    return seconds?'开关已开启 · 暂避 '+seconds+' 秒后处理新来信':'开关已开启 · 等待新来信验证恢复';
  }
  function renderRecovery(){
    const rows=recoveryRows();$('routeRecovery').classList.toggle('hidden',!rows.length);const list=$('routeRecoveryList');list.replaceChildren();
    for(const row of rows){
      const card=document.createElement('div');card.className='delivery-review-item';
      const label=document.createElement('p');label.className='delivery-review-meta';label.textContent=firstText(row.chatName,'会话')+' · '+recoveryText(row);
      const reason=document.createElement('p');reason.className='field-help';reason.textContent=safeDiagnostic(row.reason);card.append(label,reason);
      if(row.kind!=='waiting'){
        const button=document.createElement('button');button.className='button secondary small';button.type='button';button.dataset.recoveryResume=row.chatId;button.textContent=row.kind==='review'?'已核对，重新连接':'重新连接并继续接收';button.disabled=pending.has('recovery:'+row.chatId);
        button.addEventListener('click',()=>task('recovery:'+row.chatId,button,async()=>{const result=await action('recovery-resume',{chatId:row.chatId});await refresh(true);notice(result.resumed?'已重新连接，只接收新消息，旧回复不会重发。':'连接已核验，自动回复保持暂停；开启后接收新消息。');}));card.append(button);
      }
      list.append(card);
    }
  }
  function renderEvents() {
    const events = Array.isArray(state.events) ? state.events : [];
    const signature=JSON.stringify({events,conversations:state.conversations});if(signature===activitySignature)return;activitySignature=signature;
    $('activityEmpty').classList.toggle('hidden', events.length > 0);
    const list = $('eventList');
    list.replaceChildren();
    const groups=new Map(),sorted=[];
    for(const raw of events.slice().sort((a,b)=>eventTime(b)-eventTime(a))){
      const event=typeof raw==='string'?{message:raw}:object(raw),sources=sourceMessages(event);
      const ids=sources.map(row=>row.eventId).filter(Boolean),key=event.chatId&&ids.length===sources.length&&ids.length?JSON.stringify([event.accountId||'',event.chatId,event.senderId||'',sources.map(row=>[row.eventId,row.senderId||''])]):'';
      if(key&&groups.has(key)){
        const latest=groups.get(key);
        if(!firstText(latest.replyText,latest.reply)&&replyTypes.has(eventType(event))&&event.text)latest.replyText=event.text;
        continue;
      }
      const row={...event};if(key)groups.set(key,row);sorted.push(row);
    }
    $('activityCount').textContent = sorted.length + ' 条互动';
    for (const value of sorted.slice(0,30)) {
      const event = typeof value === 'string' ? {message: value} : object(value);
      const type = string(event.kind || event.type || event.stage || event.status).toLowerCase();
      const li = document.createElement('li');li.dataset.phase=type;
      const dot = document.createElement('span');
      dot.className = 'event-dot' + (/error|fail|blocked|uncertain|unconfirmed/.test(type) ? ' bad' : /sent|confirmed|complete|connected/.test(type) ? ' good' : /generat|thinking|searching|sending|queue/.test(type) ? ' busy' : '');
      const body = document.createElement('div');body.className='event-body';
      const title = document.createElement('div'); title.className = 'event-title';
      const caption=safeDiagnostic(firstText(event.message,event.title));
      title.textContent=phaseName(type)+(caption&&caption!==phaseName(type)?' · '+caption:'');
      const details = [firstText(event.chatName, event.targetName),firstText(event.senderName),safeDiagnostic(firstText(event.detail, event.error?.message, event.error))];
      if (event.durationMs != null) details.push(duration(event.durationMs));
      if (event.timings && typeof event.timings === 'object') {
        const names = {firstTokenMs:'首字',generationMs:'生成',modelMs:'模型',sendMs:'发送',totalMs:'总计'};
        for (const [key, label] of Object.entries(names)) if (event.timings[key] != null) details.push(label + ' ' + duration(event.timings[key]));
      }
      body.append(title);
      if (details.some(Boolean)) { const p = document.createElement('p'); p.className = 'event-detail'; p.textContent = details.filter(Boolean).join(' · '); body.append(p); }
      const pair=document.createElement('div');pair.className='message-pair';messagePair(pair,event,'event:'+(event.id||event.chatId+':'+eventTime(event)));if(pair.childNodes.length)body.append(pair);
      const time = document.createElement('time'); time.className = 'event-time'; time.textContent = date(event.at || event.time || event.timestamp || event.createdAt);
      li.append(dot, body, time); list.append(li);
    }
  }
  function memoryRows() {
    const memory = state?.memory;
    if (Array.isArray(memory)) return memory;
    if (Array.isArray(memory?.items)) return memory.items;
    return [];
  }
  function renderMemory() {
    const routes=memoryRoutes(),selected=$('memoryScope').value||'all';
    const scopeRows=[{id:'all',name:'全部会话'},{id:'private',name:'全部私聊'},{id:'group',name:'全部群聊'},...routes.map(row=>({id:'route:'+row.routeKey,name:(row.type==='group'?'群 · ':'私聊 · ')+row.name}))];
    const optionsSignature=JSON.stringify(scopeRows);
    if($('memoryScope').dataset.options!==optionsSignature){fillSelect($('memoryScope'),scopeRows,row=>row.id,row=>row.name,'选择会话',selected);if(!$('memoryScope').value)$('memoryScope').value='all';$('memoryScope').dataset.options=optionsSignature;}
    const rows=filteredMemoryRows(),summaries=filteredSummaries(),stats=object(state?.memoryStats);
    $('memoryCount').textContent=String(memoryRows().length);
    $('filteredMemoryCount').textContent=String(rows.length);$('summaryCount').textContent=String(summaries.length);
    $('memoryStats').textContent=`共 ${memoryRows().length} 条长期记忆 · ${(Array.isArray(state?.summaries)?state.summaries:[]).length} 段摘要 · 已整理 ${Number(stats.compressions)||0} 次`+(Number(stats.pending)>0?' · 正在整理上下文':'');
    $('clearMemory').textContent=$('memoryScope').value==='all'?'清空全部会话记忆':'清空所选会话记忆';
    $('memoryEmpty').classList.toggle('hidden',rows.length>0);$('summaryEmpty').classList.toggle('hidden',summaries.length>0);
    const signature=JSON.stringify({rows,summaries,scope:$('memoryScope').value});if(signature===memorySignature)return;memorySignature=signature;
    const list=$('memoryList');list.replaceChildren();
    for(const row of rows){
      const text=typeof row==='string'?row:firstText(row.text,row.content,row.fact,row.note);if(!text)continue;
      const li=document.createElement('li');li.className='memory-row';
      const header=document.createElement('div');header.className='memory-row-header';const label=document.createElement('span');label.className='memory-row-scope';label.textContent=memoryRowName(row);header.append(label);
      if(row&&typeof row==='object'&&row.id){const remove=document.createElement('button');remove.type='button';remove.className='text-button danger';remove.textContent='忘记';remove.dataset.memoryDelete=row.id;remove.setAttribute('aria-label','忘记这条记忆');remove.addEventListener('click',()=>task('memory',remove,async()=>{await action('memory-delete',{id:row.id});await refresh(true);notice('这条记忆已忘记。');}));header.append(remove);}
      const p=document.createElement('p');p.className='memory-row-text';p.textContent=text;li.append(header,p);list.append(li);
    }
    const summaryList=$('summaryList');summaryList.replaceChildren();
    for(const row of summaries){const item=document.createElement('details');item.className='summary-item';const summary=document.createElement('summary');summary.textContent=memoryRowName(row)+(row.coveredMessages?' · '+row.coveredMessages+' 条消息':'');const p=document.createElement('p');p.textContent=string(row.text);item.append(summary,p);summaryList.append(item);}
  }
  function memoryRouteKey(row){
    if(!row||typeof row!=='object')return '';
    return firstText(row.routeKey)||(row.chatId&&state?.settings?.accountId?state.settings.accountId+':'+row.chatId:firstText(row.sessionKey).split(':member:')[0]);
  }
  function memoryRoutes(){
    const map=new Map(),account=firstText(state?.settings?.accountId);
    const configured=[...(Array.isArray(state?.settings?.contacts)?state.settings.contacts:privateParticipants()).map(row=>({...row,type:'private'})),...savedGroups().map(row=>({...row,type:'group'}))];
    for(const row of [...configured,...directoryRows]){const id=contactId(row);if(id&&account)map.set(account+':'+id,{routeKey:account+':'+id,chatId:id,type:row.type==='group'?'group':'private',name:contactName(row)});}
    for(const row of [...memoryRows(),...(Array.isArray(state?.summaries)?state.summaries:[])]){const key=memoryRouteKey(row);if(!key||key==='local-preview'||map.has(key))continue;const id=firstText(row.chatId)||key.slice(account.length+1);map.set(key,{routeKey:key,chatId:id,type:id.includes('@chatroom')?'group':'private',name:firstText(row.chatName,row.name,id,'未命名会话')});}
    return [...map.values()];
  }
  function memoryRowName(row){const key=memoryRouteKey(row);const route=memoryRoutes().find(item=>item.routeKey===key);return route?(route.type==='group'?'群 · ':'私聊 · ')+route.name+(row?.senderName?' · '+row.senderName:''):key==='local-preview'?'本地试聊':key?'已归档会话':'历史记忆';}
  function memoryMatches(row){const selected=$('memoryScope').value||'all',key=memoryRouteKey(row);if(selected==='all')return true;if(selected.startsWith('route:'))return key===selected.slice(6);const route=memoryRoutes().find(item=>item.routeKey===key);return route?.type===selected;}
  function filteredMemoryRows(){return memoryRows().filter(memoryMatches);}
  function filteredSummaries(){return (Array.isArray(state?.summaries)?state.summaries:[]).filter(memoryMatches);}

  function participantRows(){
    const rows=new Map();
    for(const row of [...directoryRows,...savedParticipants(),...participantSelection.values()]){const id=contactId(row);if(!id)continue;const value={...row,chatId:id,type:row.type==='group'?'group':'private',name:contactName(row)};const key=participantKey(value);rows.set(key,{...rows.get(key),...value});}
    return [...rows.values()];
  }
  function participantMatches(){
    const q=$('participantsQuery').value.trim().toLocaleLowerCase(),type=$('participantsType').value;
    return participantRows().filter(row=>(type==='all'||type==='selected'&&participantSelection.has(participantKey(row))||type===row.type)&&(!q||[row.name,row.chatId,row.remark].some(value=>string(value).toLocaleLowerCase().includes(q))));
  }
  function renderParticipants(){
    const account=firstText(state?.settings?.accountId),saved=savedParticipants();
    if(directoryAccount!==account){directoryAccount=account;directoryRows=[];directoryLoaded=false;directoryMeta={};participantsDirty=false;participantsSignature='';participantSelection.clear();participantsRevision++;participantPageSize=80;}
    const signature=JSON.stringify(saved);
    if(!participantsDirty&&signature!==participantsSignature){participantSelection=new Map(saved.map(row=>[participantKey(row),row]));participantsSignature=signature;}
    const rows=participantMatches(),selected=[...participantSelection.values()];
    const groups=selected.filter(row=>row.type==='group').length,privateCount=selected.length-groups;
    $('participantsSavedCount').textContent=saved.length+' 个参与';
    $('participantsCount').textContent=`已选 ${selected.length} 个（群 ${groups} · 私聊 ${privateCount}）`;
    $('directoryStatus').textContent=directoryLoaded?`${directoryRows.length} 个可选会话`+(directoryMeta.truncated?' · 目录尚未完整加载':' · 通讯录已读取'):'尚未加载通讯录 · 已显示当前参与会话';
    $('participantsDraftHint').textContent=participantsDirty?'有未应用的选择':'当前选择已保存';$('participantsDraftHint').classList.toggle('dirty',participantsDirty);
    $('participantsEmpty').classList.toggle('hidden',rows.length>0);$('participantsEmpty').textContent=directoryLoaded?'没有符合条件的会话。':'加载通讯录后，可搜索并批量勾选。';
    $('showMoreParticipants').classList.toggle('hidden',rows.length<=participantPageSize);$('showMoreParticipants').textContent=`显示更多（当前 ${Math.min(rows.length,participantPageSize)} / ${rows.length}）`;
    const renderSignature=JSON.stringify({rows:rows.slice(0,participantPageSize),keys:[...participantSelection.keys()],pending:pending.has('participants')});if(renderSignature===participantsRenderSignature)return;participantsRenderSignature=renderSignature;
    const list=$('participantsList');const scroll=list.scrollTop;list.replaceChildren();
    for(const row of rows.slice(0,participantPageSize)){
      const key=participantKey(row),selected=participantSelection.has(key);const label=document.createElement('label');label.className='participant-row'+(selected?' selected':'');
      const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=selected;checkbox.dataset.participantCheckbox=key;checkbox.disabled=pending.has('participants');checkbox.setAttribute('aria-label',(row.type==='group'?'群聊 ':'私聊 ')+row.name);
      checkbox.addEventListener('change',()=>{if(checkbox.checked)participantSelection.set(key,row);else participantSelection.delete(key);participantsChanged();});
      const body=document.createElement('span');body.className='participant-row-body';const name=document.createElement('span');name.className='participant-row-name';name.textContent=row.name;const id=document.createElement('span');id.className='participant-row-id';id.textContent=row.chatId;body.append(name,id);
      const kind=document.createElement('span');kind.className='participant-type '+row.type;kind.textContent=row.type==='group'?'群聊'+(row.memberCount?' · '+row.memberCount+'人':''):'私聊';label.append(checkbox,body,kind);list.append(label);
    }
    list.scrollTop=scroll;
  }
  function participantsChanged(){participantsDirty=true;participantsRevision++;renderParticipants();controls();}
  $('loadDirectory').addEventListener('click',()=>task('directory',$('loadDirectory'),async()=>{
    const account=firstText(state?.settings?.accountId);if(!account)return;
    const result=await action('directory',{accountId:account});
    if(account!==state?.settings?.accountId)return;
    if(!Array.isArray(result?.items))throw Error('未取得通讯录目录，请检查微信连接后重试。');
    directoryRows=result.items.filter(row=>['private','group'].includes(row.type)&&contactId(row));directoryLoaded=true;directoryMeta=result;renderParticipants();renderMemory();renderOwner();notice(result.truncated?'已加载部分通讯录，现有选择保持不变。':'通讯录已加载，现有选择保持不变。');
  }));
  $('participantsQuery').addEventListener('input',()=>{participantPageSize=80;renderParticipants();controls();});
  $('participantsType').addEventListener('change',()=>{participantPageSize=80;renderParticipants();controls();});
  $('showMoreParticipants').addEventListener('click',()=>{participantPageSize+=80;renderParticipants();controls();});
  $('selectFiltered').addEventListener('click',()=>{for(const row of participantMatches())participantSelection.set(participantKey(row),row);participantsChanged();});
  $('clearFiltered').addEventListener('click',()=>{for(const row of participantMatches())participantSelection.delete(participantKey(row));participantsChanged();});
  $('resetParticipants').addEventListener('click',()=>{participantsDirty=false;participantsSignature='';participantsRevision++;renderParticipants();controls();});
  $('saveParticipants').addEventListener('click',()=>task('participants',$('saveParticipants'),async()=>{
    const revision=participantsRevision,account=firstText(state?.settings?.accountId),participants=[...participantSelection.values()].map(({chatId,type})=>({chatId,type}));
    await action('participants-save',{participants});
    if(account===state?.settings?.accountId&&revision===participantsRevision){participantsDirty=false;participantsSignature='';}
    await refresh(true);notice(participants.length?'参与会话已更新，群聊接话规则已保留。':'已取消全部参与会话，自动回复已暂停。');
  }));
  $('memoryScope').addEventListener('change',()=>{memorySignature='';renderMemory();controls();});
  $('compressContext').addEventListener('click',()=>task('memory',$('compressContext'),async()=>{const scope=$('memoryScope').value;if(!scope.startsWith('route:'))return;await action('context-compress',{routeKey:scope.slice(6)});await refresh(true);notice('已安排整理这段上下文，不会发送微信消息。');}));

  function renderOwner(){
    const settings=object(state?.settings),account=firstText(settings.accountId);
    if(ownerAccount!==account){ownerAccount=account;ownerDirty=false;ownerOptionsSignature='';ownerRevision++;$('ownerHint').textContent='尚未修改';$('ownerHint').classList.remove('dirty');}
    const selected=ownerDirty?$('ownerSelect').value:firstText(settings.ownerId);
    const rows=new Map();
    for(const row of [...privateParticipants(),...directoryRows.filter(row=>row.type==='private')]){const id=contactId(row);if(id&&id!==account&&!id.endsWith('@chatroom'))rows.set(id,{chatId:id,name:contactName(row)});}
    if(settings.ownerId&&!rows.has(settings.ownerId))rows.set(settings.ownerId,{chatId:settings.ownerId,name:firstText(settings.ownerName,'已保存的主人账号')});
    if(selected&&!rows.has(selected))rows.set(selected,{chatId:selected,name:'正在选择的账号'});
    const options=[...rows.values()],signature=JSON.stringify(options);
    if(signature!==ownerOptionsSignature){fillSelect($('ownerSelect'),options,contactId,row=>contactName(row)+' · '+contactId(row),directoryLoaded?'选择主人的账号':'加载联系人后选择',selected);ownerOptionsSignature=signature;}
    if(!ownerDirty){$('ownerEnabled').checked=settings.ownerEnabled===true;$('ownerSelect').value=firstText(settings.ownerId);$('ownerName').value=string(settings.ownerName);$('ownerTitle').value=firstText(settings.ownerTitle,'主人');}
    const active=settings.ownerEnabled===true&&settings.ownerId;
    $('ownerStatus').textContent=active?'已认准 '+firstText(settings.ownerTitle,'主人')+' · '+firstText(settings.ownerName,settings.ownerId):settings.ownerId?'主人账号已保存，身份称呼尚未开启。':'尚未设置主人。';
    $('ownerAccountHint').textContent=directoryLoaded?'只显示当前小号的好友；主人身份按账号 ID 核验。':'可先点「加载联系人」，现有参与名单不会改变。';
  }
  function ownerChanged() {ownerDirty=true;ownerRevision++;$('ownerHint').textContent='有未保存的修改';$('ownerHint').classList.add('dirty');controls();}
  $('loadOwnerContacts').addEventListener('click',()=>{if(!$('loadDirectory').disabled)$('loadDirectory').click();});
  $('ownerSelect').addEventListener('change',()=>{const selected=$('ownerSelect').value;const row=directoryRows.find(row=>row.type==='private'&&contactId(row)===selected)||privateParticipants().find(row=>contactId(row)===selected);if(row)$('ownerName').value=contactName(row);ownerChanged();});
  $('ownerEnabled').addEventListener('change',ownerChanged);
  for(const id of ['ownerName','ownerTitle'])$(id).addEventListener('input',ownerChanged);
  $('saveOwner').addEventListener('click',()=>task('owner',$('saveOwner'),async()=>{
    const revision=ownerRevision,account=ownerAccount,params={ownerId:$('ownerSelect').value,ownerName:$('ownerName').value.trim(),ownerTitle:$('ownerTitle').value.trim()||'主人',ownerEnabled:$('ownerEnabled').checked};
    if(params.ownerEnabled&&!params.ownerId)throw Error('请先选择主人的微信账号。');
    await action('settings',params);
    if(revision===ownerRevision&&account===state?.settings?.accountId){ownerDirty=false;$('ownerHint').textContent='已保存';$('ownerHint').classList.remove('dirty');}
    await refresh(true);notice('主人设定已保存，参与会话名单保持不变。');
  }));

  function renderSendMode(){
    if(!sendModeDirty){$('textSendMode').value=state?.settings?.textSendMode||'background';$('textEncoding').value=state?.settings?.textEncoding||'auto';}
    const background=$('textSendMode').value==='background';
    $('textEncoding').disabled=!background;
    $('sendModeStatus').textContent=sendModeDirty?'有未保存的修改':background?'已选择后台发送 · 不自动切前台':'已选择前台兼容 · 发送后恢复窗口';
    $('sendModeHint').textContent=background?'微信可最小化：回复时临时还原到其他窗口后面，完成后重新最小化。多行文字请选前台兼容；找不到会话时先在微信打开一次。':'前台兼容会短暂操作微信；后台不可用时可手动选择此模式。';
    $('saveSendMode').disabled=!state||!sendModeDirty||pending.has('send-mode');
  }
  for(const id of ['textSendMode','textEncoding'])$(id).addEventListener('change',()=>{sendModeDirty=true;renderSendMode();});
  $('saveSendMode').addEventListener('click',()=>task('send-mode',$('saveSendMode'),async()=>{
    const textSendMode=$('textSendMode').value,textEncoding=$('textEncoding').value;
    await action('settings',{textSendMode,textEncoding});
    if($('textSendMode').value===textSendMode&&$('textEncoding').value===textEncoding)sendModeDirty=false;
    await refresh(true);renderSendMode();notice('文字发送方式已保存。');
  }));
  function renderSearch(){
    if(!searchSettingInitialized){if(!searchSettingDirty)$('webSearchEnabled').checked=state?.settings?.webSearchEnabled===true;searchSettingInitialized=true;}
    if(!searchSettingDirty)$('webSearchEnabled').checked=state?.settings?.webSearchEnabled===true;
    const search=object(state?.search),previous=object(search.lastResult);
    const result=search.status==='error'||search.status==='searching'?{}:previous;
    const attempted=firstText(search.lastAttempt?.query,previous.query);
    const step=object(search.lastAttempt?.step);
    let progress='正在核实：'+(attempted||'公开资料');
    if(step.tool==='search_web'&&step.query)progress='正在搜索：'+string(step.query);
    if(step.tool==='open_page'&&step.url){try{progress='正在读网页：'+new URL(step.url).hostname;}catch{progress='正在读取网页正文';}}
    if(step.tool==='planning')progress='正在选择查询词与来源：'+(attempted||'公开资料');
    const failure=firstText(search.error,search.message);
    $('searchStatus').textContent=search.status==='searching'?progress:failure?(attempted?'本次查询：'+attempted+' · ':'')+failure:(result.at?'上次查询 · '+date(result.at)+(result.webSearched===false?' · 未执行联网搜索':result.pagesRead?' · 已读 '+result.pagesRead+' 个网页正文':' · 搜索摘要'):state?.settings?.webSearchEnabled?'已允许需要公开资料时自主检索':'聊天联网查询未开启');
    const signature=JSON.stringify(result);if(signature===searchResultSignature)return;searchResultSignature=signature;
    $('searchResult').classList.toggle('hidden',!firstText(result.answer,result.text));$('searchAnswer').textContent=firstText(result.answer,result.text);
    const sources=$('searchSources');sources.replaceChildren();for(const row of Array.isArray(result.sources)?result.sources:[]){const raw=typeof row==='string'?row:firstText(row.url,row.link);let url;try{url=new URL(raw);}catch{continue;}if(!['https:','http:'].includes(url.protocol))continue;const li=document.createElement('li'),a=document.createElement('a');a.href=url.href;a.target='_blank';a.rel='noopener noreferrer';a.textContent=firstText(row.title,row.name,url.hostname)+(row.readLevel==='page'?' · 已读正文':row.readLevel==='snippet'?' · 搜索摘要':'');li.append(a);sources.append(li);}
  }
  $('webSearchEnabled').addEventListener('change',()=>{searchSettingDirty=true;$('searchSettingHint').textContent='有未保存的修改';$('searchSettingHint').classList.add('dirty');controls();});
  $('saveSearchSetting').addEventListener('click',()=>task('search-settings',$('saveSearchSetting'),async()=>{const enabled=$('webSearchEnabled').checked;await action('settings',{webSearchEnabled:enabled});if($('webSearchEnabled').checked===enabled){searchSettingDirty=false;$('searchSettingHint').textContent='已保存';$('searchSettingHint').classList.remove('dirty');}await refresh(true);notice('联网查询设置已保存。');}));
  $('searchQuery').addEventListener('input',()=>controls());
  $('testSearch').addEventListener('click',()=>task('search-test',$('testSearch'),async()=>{const query=$('searchQuery').value.trim();if(!query)return;await action('search-test',{query});await refresh(true);notice('查询结果仅显示在这里，不会发送微信。');}));
  const groupModeLabels = {mention:'仅被 @ 时',addressed:'被 @、叫名字或接着聊',smart:'主动搭话'};
  function groupModeHelp() {
    const descriptions = {
      mention:'群消息只有真正 @ 小号时才进入接话流程。',
      addressed:'被 @ 或叫到名字时接话，窗口内同一位群友可以继续聊。',
      smart:'群里有新消息时，结合最近的聊天判断能否自然加入；可以选择旁听。纯表情和简短附和不反复调用模型，每次判断至少间隔20秒。'
    };
    $('groupModeHelp').textContent = descriptions[$('groupMode').value] || descriptions.addressed;
    $('groupProactiveOptions').classList.toggle('hidden',$('groupMode').value!=='smart');
  }
  function setGroupPolicy(row) {
    $('groupMode').value = Object.hasOwn(groupModeLabels,row.mode) ? row.mode : 'addressed';
    $('groupAliases').value = Array.isArray(row.aliases) ? row.aliases.join('，') : '';
    $('groupCooldown').value = Number.isInteger(row.cooldownSeconds) ? row.cooldownSeconds : 8;
    $('groupFollowup').value = Number.isInteger(row.followupSeconds) ? row.followupSeconds : 90;
    $('groupProactiveInterval').value = Number.isInteger(row.proactiveIntervalSeconds) ? row.proactiveIntervalSeconds : 120;
    $('groupProactiveMax').value = Number.isInteger(row.proactiveMaxPerHour) ? row.proactiveMaxPerHour : 3;
    groupPolicyDirty=false;
    groupModeHelp();
  }
  function renderGroups() {
    const rows=savedGroups();
    if(!groupPersonaInitialized){
      if(!groupPersonaDirty)$('groupPersona').value=string(state?.settings?.groupPersona);
      groupPersonaInitialized=true;
    }
    if(!groupQueryInitialized){
      if(!$('groupQuery').value) $('groupQuery').value=firstText(state?.settings?.expectedGroupName);
      if(state?.settings?.expectedGroupName) $('groupPanel').open=true;
      groupQueryInitialized=true;
      groupModeHelp();
    }
    $('groupCount').textContent=String(rows.length);
    $('groupEnabledCount').textContent=enabledGroups().length+' 个开启';
    $('groupEmpty').classList.toggle('hidden',rows.length>0);
    const signature=JSON.stringify({rows,recovery:recoveryRows().map(row=>({...row,display:recoveryText(row)}))});
    if(signature===groupListSignature)return;
    groupListSignature=signature;
    const list=$('groupList');list.replaceChildren();
    for(const row of rows){
      const id=groupId(row);if(!id)continue;
      const article=document.createElement('article');article.className='group-row';
      const head=document.createElement('div');head.className='group-row-head';
      const name=document.createElement('strong');name.textContent=groupName(row);name.title=groupName(row);
      const toggle=document.createElement('button');toggle.type='button';toggle.className='group-switch'+(row.enabled!==false?' on':'');toggle.dataset.groupAction='toggle';toggle.setAttribute('role','switch');toggle.setAttribute('aria-checked',String(row.enabled!==false));toggle.setAttribute('aria-label',groupName(row)+'的群聊自动回复');
      const indicator=document.createElement('span');indicator.className='switch-track';
      const caption=document.createElement('span');caption.textContent=row.enabled!==false?'已开启':'已关闭';toggle.append(indicator,caption);
      toggle.addEventListener('click',()=>task('group-mutate',toggle,async()=>{await action('group-toggle',{chatId:id,enabled:row.enabled===false});await refresh(true);notice('群聊开关已更新。');}));
      head.append(name,toggle);
      const policy=document.createElement('p');policy.className='group-row-policy';policy.textContent=(groupModeLabels[row.mode]||groupModeLabels.addressed)+' · 冷却 '+(row.cooldownSeconds??8)+' 秒 · 接话 '+(row.followupSeconds??90)+' 秒';
      if(row.mode==='smart')policy.textContent+=' · 主动间隔 '+(row.proactiveIntervalSeconds??120)+' 秒 · 每小时最多 '+(row.proactiveMaxPerHour??3)+' 次';
      const footer=document.createElement('div');footer.className='group-row-footer';
      const aliases=document.createElement('span');aliases.className='group-row-aliases';aliases.textContent=Array.isArray(row.aliases)&&row.aliases.length?'称呼：'+row.aliases.join('、'):'使用默认称呼';
      const buttons=document.createElement('span');buttons.className='group-row-actions';
      const proactive=document.createElement('button');proactive.type='button';proactive.className='text-button';proactive.dataset.groupAction='proactive';proactive.setAttribute('aria-label',groupName(row)+(row.mode==='smart'?'关闭':'开启')+'主动搭话');proactive.textContent=row.mode==='smart'?'关闭主动搭话':'开启主动搭话';
      proactive.addEventListener('click',()=>task('group-mutate',proactive,async()=>{await action('group-proactive',{chatId:id,enabled:row.mode!=='smart'});await refresh(true);notice(row.mode==='smart'?'已关闭主动搭话，恢复原来的点名接话规则。':'已允许这个群主动搭话；仍以群开关和自动回复总开关为准。');}));
      const edit=document.createElement('button');edit.type='button';edit.className='text-button';edit.dataset.groupAction='edit';edit.textContent='编辑';edit.addEventListener('click',()=>{
        groupRevision++;groupSearchVersion++;
        $('groupQuery').value=groupName(row);
        groupCandidates=[row,...groupCandidates.filter(item=>groupId(item)!==id)];
        fillSelect($('groupSelect'),groupCandidates,groupId,groupName,'选择群聊',id);
        setGroupPolicy(row);$('groupDraftHint').textContent='正在编辑这个群的配置';$('groupDraftHint').classList.add('dirty');$('groupPanel').open=true;controls();
      });
      const remove=document.createElement('button');remove.type='button';remove.className='text-button danger';remove.dataset.groupAction='remove';remove.textContent='移除';remove.addEventListener('click',()=>task('group-mutate',remove,async()=>{
        await action('group-remove',{chatId:id});
        if($('groupSelect').value===id){groupCandidates=groupCandidates.filter(item=>groupId(item)!==id);fillSelect($('groupSelect'),groupCandidates,groupId,groupName,'查找后选择群聊');$('groupDraftHint').textContent='该群已移除，私聊绑定保持不变';}
        await refresh(true);notice('这个群已移除，私聊绑定保持不变。');
      }));
      buttons.append(proactive,edit,remove);footer.append(aliases,buttons);article.append(head,policy);
      const health=recoveryRows().find(item=>item.chatId===id);
      if(health||row.pausedReason){const reason=document.createElement('p');reason.className='field-help';reason.textContent=health?recoveryText(health)+'：'+safeDiagnostic(health.reason):'旧版自动暂停原因：'+safeDiagnostic(row.pausedReason);article.append(reason);}
      article.append(footer);list.append(article);
    }
  }
  async function searchGroups() {
    const account=groupAccountId(),query=$('groupQuery').value.trim();
    if(!account||!query)return;
    const revision=groupSearchVersion,selectedBefore=$('groupSelect').value;
    const result=await action('groups',{accountId:account,query});
    const rows=Array.isArray(result)?result:result?.groups;
    if(!Array.isArray(rows))throw Error('未取得群聊列表，请检查微信连接后重试。');
    if(revision!==groupSearchVersion||account!==groupAccountId())return;
    groupCandidates=rows.filter(row=>groupId(row));
    const exact=groupCandidates.filter(row=>groupName(row)===query||groupId(row)===query);
    const selected=groupCandidates.some(row=>groupId(row)===selectedBefore)?selectedBefore:exact.length===1?groupId(exact[0]):'';
    fillSelect($('groupSelect'),groupCandidates,groupId,groupName,groupCandidates.length?'选择要接入的群':'没有找到匹配的群',selected);
    const existing=savedGroups().find(row=>groupId(row)===selected);
    if(existing&&!groupPolicyDirty)setGroupPolicy(existing);
    $('groupDraftHint').textContent=groupCandidates.length?'选择群聊后保存接话规则':'没有找到，请换个群名再试';controls();
  }
  function groupDraftChanged(policy=false){groupRevision++;if(policy)groupPolicyDirty=true;$('groupDraftHint').textContent='有未保存的群聊配置';$('groupDraftHint').classList.add('dirty');groupModeHelp();controls();}
  $('loadGroups').addEventListener('click',()=>task('groups-list',$('loadGroups'),()=>searchGroups()));
  $('groupQuery').addEventListener('input',()=>{groupRevision++;groupSearchVersion++;groupCandidates=[];fillSelect($('groupSelect'),[],groupId,groupName,'查找后选择群聊');$('groupDraftHint').textContent='输入群名后查找';controls();});
  $('groupQuery').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();if(!$('loadGroups').disabled)task('groups-list',$('loadGroups'),()=>searchGroups());}});
  $('groupSelect').addEventListener('change',()=>{const existing=savedGroups().find(row=>groupId(row)===$('groupSelect').value);if(existing)setGroupPolicy(existing);groupDraftChanged();});
  $('groupMode').addEventListener('change',()=>groupDraftChanged(true));
  for(const id of ['groupAliases','groupCooldown','groupFollowup','groupProactiveInterval','groupProactiveMax'])$(id).addEventListener('input',()=>groupDraftChanged(true));
  $('clearGroupDraft').addEventListener('click',()=>{groupRevision++;groupSearchVersion++;setGroupPolicy({});fillSelect($('groupSelect'),groupCandidates,groupId,groupName,'选择要接入的群');$('groupDraftHint').textContent='选择群聊后添加';$('groupDraftHint').classList.remove('dirty');controls();});
  $('saveGroup').addEventListener('click',()=>task('group-mutate',$('saveGroup'),async()=>{
    const selected=$('groupSelect').value;if(!selected)return;
    const row=groupCandidates.find(item=>groupId(item)===selected)||savedGroups().find(item=>groupId(item)===selected);
    if(!row)throw Error('请先查找并选择群聊。');
    const cooldown=Number($('groupCooldown').value),followup=Number($('groupFollowup').value);
    if(!Number.isInteger(cooldown)||cooldown<3||cooldown>120||!Number.isInteger(followup)||followup<15||followup>600)throw Error('回复冷却需为3—120秒，接话窗口需为15—600秒。');
    const proactiveIntervalSeconds=Number($('groupProactiveInterval').value),proactiveMaxPerHour=Number($('groupProactiveMax').value);
    if(!Number.isInteger(proactiveIntervalSeconds)||proactiveIntervalSeconds<30||proactiveIntervalSeconds>3600||!Number.isInteger(proactiveMaxPerHour)||proactiveMaxPerHour<1||proactiveMaxPerHour>20)throw Error('主动搭话间隔需为30—3600秒，每小时上限需为1—20次。');
    const aliases=[...new Set($('groupAliases').value.split(/[,，\n]/).map(item=>item.trim()).filter(Boolean))];
    if(aliases.length>12||aliases.some(item=>item.length>40))throw Error('群里称呼最多 12 个，每个不超过 40 字。');
    const revision=groupRevision,existing=savedGroups().find(item=>groupId(item)===selected);
    await action('group-save',{chatId:selected,name:groupName(row),mode:$('groupMode').value,aliases,cooldownSeconds:cooldown,followupSeconds:followup,proactiveIntervalSeconds,proactiveMaxPerHour,enabled:existing?.enabled!==false});
    await refresh(true);
    if(revision===groupRevision){groupPolicyDirty=false;$('groupDraftHint').textContent='群聊配置已保存';$('groupDraftHint').classList.remove('dirty');}
    notice('群聊配置已保存，私聊绑定保持不变。');
  }));
  $('groupPersona').addEventListener('input',()=>{groupPersonaDirty=true;$('groupPersonaHint').textContent='有未保存的修改';$('groupPersonaHint').classList.add('dirty');});
  $('saveGroupPersona').addEventListener('click',()=>task('group-persona',$('saveGroupPersona'),async()=>{
    const body=$('groupPersona').value;await action('settings',{groupPersona:body});
    if($('groupPersona').value===body){groupPersonaDirty=false;$('groupPersonaHint').textContent='已保存';$('groupPersonaHint').classList.remove('dirty');}
    await refresh(true);notice('群聊公开设定已保存。');
  }));
  function ingestRemoteChat() {
    let rows = state.localChat || state.testChat?.messages || state.preview?.messages;
    if (!Array.isArray(rows) && Array.isArray(state.conversations)) {
      const local = state.conversations.find(item => item?.kind === 'local' || item?.id === 'local-test' || item?.id === 'test' || item?.sessionKey === 'local-test');
      rows = local?.messages;
    }
    if (!Array.isArray(rows) || !rows.length) return;
    const signature = JSON.stringify(rows);
    if (signature === lastRemoteChat) return;
    lastRemoteChat = signature;
    const normalized = rows.map(row => ({role: row.role === 'user' ? 'user' : 'assistant',text:firstText(row.text,row.content,row.reply),error:row.error})).filter(row => row.text);
    if (!normalized.length) return;
    localMessages = normalized;
    if (normalized[normalized.length - 1].role === 'assistant') localPending = null;
  }
  function renderChat() {
    const feed = $('chatFeed');
    const atBottom = feed.scrollHeight - feed.clientHeight - feed.scrollTop < 60;
    const fragment = document.createDocumentFragment();
    if (!localMessages.length && !localPending) {
      const empty = document.createElement('div'); empty.className = 'chat-empty';
      const icon = document.createElement('div'); icon.className = 'empty-icon'; icon.textContent = '“';
      const strong = document.createElement('strong'); strong.textContent = '先打个招呼吧';
      const p = document.createElement('p'); p.textContent = '可可的回复会出现在这里。'; empty.append(icon,strong,p); fragment.append(empty);
    }
    const messages = localMessages.slice(-30);
    if (localPending) messages.push({role:'assistant',text:localPending.text || '可可正在想…',pending:true});
    for (const message of messages) {
      const row = document.createElement('div'); row.className = 'chat-message ' + message.role + (message.pending ? ' pending' : '') + (message.error ? ' error' : '');
      let avatar;
      if (message.role === 'user') { avatar = document.createElement('span'); avatar.className = 'chat-avatar user-avatar'; avatar.textContent = '你'; }
      else { avatar = document.createElement('img'); avatar.className = 'chat-avatar'; avatar.src = '/assets/koko-app.png'; avatar.alt = '可可'; }
      const bubble = document.createElement('div'); bubble.className = 'chat-bubble'; bubble.textContent = message.text;
      row.append(avatar,bubble); fragment.append(row);
    }
    const newSignature = JSON.stringify(messages);
    if (feed.dataset.rendered === newSignature) return;
    feed.dataset.rendered = newSignature;
    feed.replaceChildren(fragment);
    if (atBottom || localPending) feed.scrollTop = feed.scrollHeight;
  }
  function fillSelect(element, rows, getId, getName, placeholder, selected = '') {
    element.replaceChildren();
    const initial = document.createElement('option'); initial.value = ''; initial.textContent = placeholder; element.append(initial);
    const used = new Set();
    for (const row of rows) {
      const id = getId(row); if (!id || used.has(id)) continue; used.add(id);
      const option = document.createElement('option'); option.value = id; option.textContent = getName(row) || id; element.append(option);
    }
    if (selected && used.has(selected)) element.value = selected;
  }
  async function refresh(force = false) {
    if (refreshFlight) { await refreshFlight; if (!force) return; }
    refreshFlight = (async () => {
      try { state = object(await request('/api/state')); render(); }
      catch (err) {
        $('pageConnection').className = 'connection offline';
        $('pageConnection').lastChild.textContent = '后台连接未完成';
        if (!state) error(err.message);
      }
    })();
    try { await refreshFlight; } finally { refreshFlight = null; }
  }
  async function refreshAccounts({autoContacts = false} = {}) {
    const revision = selectionVersion;
    const result = await action('accounts');
    const rows = Array.isArray(result) ? result : result?.accounts;
    if (!Array.isArray(rows)) throw new Error(firstText(result?.error,result?.message) || '没有取得账号列表，请检查微信是否已经登录。');
    accounts = rows;
    if (revision !== selectionVersion) return;
    const selected = bindingDirty ? $('accountSelect').value : string(state?.settings?.accountId);
    const expected = firstText(state?.settings?.expectedAccountName);
    const exact = expected ? rows.filter(row => accountName(row) === expected) : [];
    fillSelect($('accountSelect'),rows,accountId,accountName,rows.length ? '请选择微信小号' : '暂未找到已登录账号',selected || (exact.length === 1 ? accountId(exact[0]) : ''));
    if (autoContacts && $('accountSelect').value) await refreshContacts();
    controls();
  }
  async function refreshContacts() {
    const selectedAccount = $('accountSelect').value;
    if (!selectedAccount) return;
    const query = contactQuery();
    if (!query) {
      fillSelect($('contactSelect'),[],contactId,contactName,'请输入昵称或备注后查找');
      controls();
      return;
    }
    const revision = selectionVersion;
    const result = await action('contacts',{accountId:selectedAccount,query});
    const rows = Array.isArray(result) ? result : result?.contacts;
    if (!Array.isArray(rows)) throw new Error(firstText(result?.error,result?.message) || '没有取得联系人列表，请先确认小号连接。');
    if (selectedAccount !== $('accountSelect').value || revision !== selectionVersion) return;
    contacts = rows;
    const selected = bindingDirty ? $('contactSelect').value : string(state?.settings?.chatId);
    const expected = query;
    const exact = rows.filter(row => contactName(row) === expected || contactId(row) === expected);
    fillSelect($('contactSelect'),rows,contactId,contactName,rows.length ? '请选择允许回复的联系人' : '暂未找到联系人',selected || (exact.length === 1 ? contactId(exact[0]) : ''));
    render();
  }
  async function refreshModels() {
    const selectedBefore = $('modelSelect').value;
    const result = await action('models');
    const rows = Array.isArray(result) ? result : result?.models;
    if (!Array.isArray(rows)) throw new Error('未取得可用模型列表，请检查 Codex 连接后重试。');
    models = rows.filter(row => modelId(row));
    modelsInitialized = true;
    const selected = modelDirty ? selectedBefore : firstText(result?.selected,state?.settings?.model,state?.codex?.model);
    fillSelect($('modelSelect'),models,modelId,row=>{
      const id=modelId(row),name=firstText(row.name,row.displayName);
      return name && name!==id ? name+' · '+id : id;
    },models.length ? '选择模型' : '此账号暂未返回可用模型',selected);
    $('modelNote').textContent = models.length ? '切换模型会暂停自动回复，保存后可重新开启。' : '未取得可选模型，请确认 Codex 已登录后刷新。';
    await refresh(true);
    controls();
  }
  $('loadModels').addEventListener('click',()=>task('models',$('loadModels'),()=>refreshModels()));
  $('modelSelect').addEventListener('change',()=>{modelDirty=true;$('modelNote').textContent='有未保存的模型选择。切换会暂停自动回复，保存后可重新开启。';controls();});
  $('saveModel').addEventListener('click',()=>task('model',$('saveModel'),async()=>{
    const model=$('modelSelect').value;
    if(!model)return;
    await action('settings',{model});
    if($('modelSelect').value===model)modelDirty=false;
    await refresh(true);
    $('modelNote').textContent='模型已保存。自动回复已暂停，需要时可在顶部重新开启。';
    notice('模型已切换，自动回复已暂停。');
  }));
  $('autoToggle').addEventListener('click', () => task('auto',$('autoToggle'),async()=>{
    const enabled = state?.settings?.enabled === true;
    await action(enabled ? 'pause' : 'enable');
    notice(enabled ? '自动回复已暂停，你可以接管微信。' : '自动回复已开启，可可会处理指定会话的新消息。');
    await refresh(true);
  }));
  $('takeOver').addEventListener('click', () => task('auto',$('takeOver'),async()=>{await action('pause');await refresh(true);notice('已暂停自动回复，现在由你接管。');}));
  $('diagnose').addEventListener('click', () => task('diagnose',$('diagnose'),async()=>{
    $('diagnostic').classList.remove('hidden'); $('diagnostic').textContent = '正在检查微信与 Codex 连接…';
    const result = await action('diagnose');
    const text = firstText(result?.message,result?.summary,result?.detail) || '检测完成，连接状态已更新。';
    $('diagnostic').textContent = text;
    await refresh(true);
    await refreshAccounts({autoContacts:true});
  }));
  $('loadAccounts').addEventListener('click', () => task('accounts',$('loadAccounts'),()=>refreshAccounts({autoContacts:true})));
  $('loadContacts').addEventListener('click', () => task('contacts',$('loadContacts'),()=>refreshContacts()));
  $('accountSelect').addEventListener('change',()=>{
    selectionVersion++; bindingDirty=true; contacts=[];
    fillSelect($('contactSelect'),[],contactId,contactName,'正在加载联系人'); controls();
    task('contacts',$('loadContacts'),()=>refreshContacts());
  });
  $('contactSelect').addEventListener('change',()=>{selectionVersion++;bindingDirty=true;controls();});
  $('contactQuery').addEventListener('input',()=>{
    contactQueryDirty=true;selectionVersion++;bindingDirty=true;contacts=[];
    fillSelect($('contactSelect'),[],contactId,contactName,'查找后选择联系人');controls();
  });
  $('contactQuery').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();if(!$('loadContacts').disabled)task('contacts',$('loadContacts'),()=>refreshContacts());}});
  $('bind').addEventListener('click',()=>task('bind',$('bind'),async()=>{
    await action('bind',{accountId:$('accountSelect').value,chatId:$('contactSelect').value});
    bindingDirty=false;await refresh(true);notice('会话已绑定。确认状态后，在顶部开启自动回复。');
  }));
  $('persona').addEventListener('input',()=>{personaDirty=true;$('personaHint').textContent='有未保存的修改';$('personaHint').classList.add('dirty');});
  $('savePersona').addEventListener('click',()=>task('persona',$('savePersona'),async()=>{
    const body=$('persona').value;await action('settings',{persona:body});
    if($('persona').value===body){personaDirty=false;$('personaHint').textContent='已保存';$('personaHint').classList.remove('dirty');}
    await refresh(true);notice('人设已保存。');
  }));
  $('clearMemory').addEventListener('click',()=>task('memory',$('clearMemory'),async()=>{
    const scope=$('memoryScope').value||'all';
    if(scope==='all')await action('memory-clear',{});
    else if(scope.startsWith('route:'))await action('memory-clear',{routeKey:scope.slice(6)});
    else for(const row of memoryRoutes().filter(row=>row.type===scope))await action('memory-clear',{routeKey:row.routeKey});
    await refresh(true);notice('所选范围的记忆和摘要已清空。');
  }));
  async function submitTest() {
    const text=$('testMessage').value.trim();if(!text||pending.has('test-chat')||localPending)return;
    await task('test-chat',$('testSend'),async()=>{
      $('testMessage').value='';localMessages.push({role:'user',text});localPending={text:'可可正在想…',startedAt:Date.now()};$('testSend').textContent='等待回复';$('testHint').textContent='正在调用本机 Codex…';renderChat();
      try {
        const result=await action('test-chat',{text});
        const reply=firstText(result?.reply,result?.text,result?.message?.content,result?.result?.reply);
        if(reply){localMessages.push({role:'assistant',text:reply});localPending=null;}
        else if(result?.should_reply===false){localMessages.push({role:'assistant',text:'这句可可选择先不接话。'});localPending=null;}
        await refresh(true);
        if(localPending&&!result?.job&&!result?.jobId&&!result?.pending&&!state?.current){localPending=null;localMessages.push({role:'assistant',text:'请求已完成，回复结果请查看最近互动。'});}
      } catch(err){localPending=null;localMessages.push({role:'assistant',text:err.message||String(err),error:true});throw err;}
      finally{$('testHint').textContent='Enter 发送 · Shift + Enter 换行';renderChat();}
    });
  }
  $('testForm').addEventListener('submit',event=>{event.preventDefault();submitTest();});
  $('testMessage').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();submitTest();}});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
  refresh().then(()=>{if(state)task('models',$('loadModels'),()=>refreshModels());});
  setInterval(()=>{if(!document.hidden)refresh();},5000);
})();
