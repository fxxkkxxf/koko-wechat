import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import readline from 'node:readline';
import path from 'node:path';

export class BridgeClient extends EventEmitter {
  constructor({root,python,stateDirectory,spawnImpl=spawn}){super();this.root=root;this.python=python;this.stateDirectory=stateDirectory;this.spawn=spawnImpl;this.seq=0;this.pending=new Map();this.state={connected:false,available:false,error:null};}
  status(){return {...this.state};}
  async connect(){
    if(this.child)return this.status();
    if(!this.python){this.state.error='尚未配置微信桥接运行环境';return this.status();}
    const child=this.spawn(this.python,['-u',path.join(this.root,'bridge','worker.py')],{windowsHide:true,stdio:['pipe','pipe','pipe'],cwd:this.root,env:{...process.env,PYTHONIOENCODING:'utf-8',...(this.stateDirectory?{KOKO_WECHAT_STATE:this.stateDirectory}:{})}});this.child=child;
    child.stderr?.resume();
    readline.createInterface({input:child.stdout}).on('line',line=>{let x;try{x=JSON.parse(line);}catch{return;}if(x.event){if(x.event==='status')this.state={...this.state,...x.data,connected:true};this.emit(x.event,x.data);return;}const p=this.pending.get(x.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(x.id);if(x.ok){const result=x.result??x.data;if(['status','bind','start','stop'].includes(p.method)&&result&&typeof result==='object')this.state={...this.state,...result,connected:true};p.resolve(result);}else p.reject(Object.assign(Error(x.error||'微信桥接操作失败'),{code:x.code||'BRIDGE_ERROR'}));});
    child.once('error',e=>this.failed('微信桥接无法启动：'+e.message));
    child.once('exit',()=>this.failed('微信桥接已退出，请重新检测连接'));
    try{const result=await this.call('status');this.state={...this.state,...result,connected:true};}catch(e){this.state.error=e.message;}
    return this.status();
  }
  failed(message){this.child=null;this.state={...this.state,connected:false,available:false,error:message};for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error(message));}this.pending.clear();this.emit('status',this.status());}
  async call(method,params={}){
    if(!this.child)throw Error(this.state.error||'微信桥接未连接');
    const id=++this.seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error(['send','send_batch'].includes(method)?'微信发送结果不明，请查看微信，勿重复发送':'微信检测等待超时，请检查登录状态'));},method==='doctor'||method==='accounts'?120000:method==='send'?45000:90000);this.pending.set(id,{resolve,reject,timer,method});this.child.stdin.write(JSON.stringify({id,method,params})+'\n',e=>{if(e){clearTimeout(timer);this.pending.delete(id);reject(Error('微信桥接连接已断开'));}});});
  }
  close(){this.child?.kill();}
}
