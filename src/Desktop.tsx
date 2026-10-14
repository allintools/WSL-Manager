import {useCallback,useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {Activity,Box,Folder,Globe2,Maximize2,Minus,Network,Package,Plus,RefreshCw,ServerCog,TerminalSquare,X} from 'lucide-react';
import {Files} from './Files';
import {Overview,Processes,Services,Software,Network as NetworkPanel} from './Panels';
import {Terminal,type Session} from './Terminal';
import {useData,useUI} from './ui';
import './desktop.css';

type User={name:string;uid:number;home:string;default:boolean;root:boolean};
type Users={default:string;arch:string;users:User[]};
type Connection={meta:{version:string;os:string;arch:string;user:string;home:string;root:boolean};proxyPort:number;user:string};
type Kind='files'|'terminal'|'resources'|'processes'|'software'|'services'|'network';
type DeskWindow={id:string;kind:Kind;x:number;y:number;w:number;h:number;z:number;minimized:boolean;maximized:boolean;cwd?:string};
const apps:{kind:Kind|'browser';label:string;icon:typeof Folder}[]=[
 {kind:'files',label:'文件',icon:Folder},{kind:'terminal',label:'终端',icon:TerminalSquare},
 {kind:'resources',label:'资源',icon:Activity},{kind:'processes',label:'进程',icon:Box},
 {kind:'software',label:'软件',icon:Package},{kind:'services',label:'服务',icon:ServerCog},
 {kind:'network',label:'网络',icon:Network},{kind:'browser',label:'浏览器',icon:Globe2}
];
const appName=(kind:Kind)=>apps.find(a=>a.kind===kind)?.label||kind;
const desktopRPC=<T,>(method:string,distro:string,user?:string,name?:string,confirmed?:boolean)=>invoke<T>('desktop_rpc',{method,distro,user,name,confirmed});

export function Desktop({distro,visible,running,setDirty}:{distro:string;visible:boolean;running:boolean;setDirty:(v:boolean)=>void}){
 const ui=useUI(),[users,setUsers]=useState<Users|null>(null),[user,setUser]=useState(''),[connection,setConnection]=useState<Connection|null>(null),[stage,setStage]=useState<'loading'|'install'|'ready'|'error'>('loading'),[everReady,setEverReady]=useState(false),[fileDirty,setFileDirty]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),[windows,setWindows]=useState<DeskWindow[]>([]),[clock,setClock]=useState(new Date());
 const z=useRef(1),stageRef=useRef<HTMLDivElement>(null);
 const markFileDirty=(value:boolean)=>{setFileDirty(value);setDirty(value)};
 useEffect(()=>{const timer=setInterval(()=>setClock(new Date()),30000);return()=>clearInterval(timer)},[]);
 const loadUsers=useCallback(async()=>{
   setStage('loading');setError('');
   try {const value=await desktopRPC<Users>('users',distro);setUsers(value);
     const saved=localStorage.getItem('desktop-user:'+distro);
     const chosen=value.users.find(u=>u.name===saved&&!u.root)||value.users.find(u=>u.default&&!u.root)||value.users.find(u=>!u.root);
     if(chosen)setUser(chosen.name);else {setUser('');setStage('install')}
   } catch(e){setError(String(e));setStage('error')}
 },[distro]);
 useEffect(()=>{if(running){void loadUsers()}else{setConnection(null);setError('发行版已停止，请先启动');setStage('error')}},[loadUsers,running]);
 useEffect(()=>{if(!user||!running)return;let cancelled=false;setConnection(null);setStage('loading');
   desktopRPC('installed',distro,user).then(()=>desktopRPC<Connection>('connect',distro,user)).then(value=>{if(!cancelled){setConnection(value);setStage('ready');setEverReady(true);setError('')}})
     .catch(e=>{if(!cancelled){const message=String(e);setStage(message.includes('尚未安装')||message.includes('版本不匹配')?'install':'error');setError(message)}});
   return()=>{cancelled=true};
 },[distro,user,running]);
 useEffect(()=>{if(stage!=='ready'||!user)return;const timer=setInterval(()=>{void desktopRPC('health',distro,user).catch(e=>{setConnection(null);setError(String(e));setStage('error')})},12000);return()=>clearInterval(timer)},[stage,distro,user]);
 useEffect(()=>{const area=stageRef.current;if(!area)return;const observer=new ResizeObserver(()=>{if(!area.clientWidth||!area.clientHeight)return;setWindows(current=>{let changed=false;const next=current.map(win=>{const w=Math.min(win.w,Math.max(360,area.clientWidth-16)),h=Math.min(win.h,Math.max(260,area.clientHeight-16)),x=Math.max(0,Math.min(win.x,area.clientWidth-w-8)),y=Math.max(0,Math.min(win.y,area.clientHeight-h-8));if(x!==win.x||y!==win.y||w!==win.w||h!==win.h){changed=true;return {...win,x,y,w,h}}return win});return changed?next:current})});observer.observe(area);return()=>observer.disconnect()},[everReady]);
 const chooseUser=(next:string)=>{localStorage.setItem('desktop-user:'+distro,next);setUser(next)};
 const install=async()=>{if(!user)return;setBusy(true);const result=await ui.run(`安装 ${distro} 桌面 Agent`,()=>desktopRPC('install',distro,user));setBusy(false);
   if(result){setStage('loading');try{const value=await desktopRPC<Connection>('connect',distro,user);setConnection(value);setStage('ready');setEverReady(true);setError('')}catch(e){setStage('error');setError(String(e))}}
 };
 const createUser=async()=>{const input=await ui.ask({title:'创建普通 Linux 用户',description:`将在 ${distro} 中创建用户和 home 目录。此操作不会修改发行版默认用户。`,fields:[{name:'name',label:'用户名',placeholder:'例如 developer'}],root:true,submit:'创建用户'});if(!input)return;
   const result=await ui.run(`创建 ${input.name}`,()=>desktopRPC('create-user',distro,undefined,input.name));if(result){await loadUsers();chooseUser(input.name)}
 };
 const reconnect=async()=>{if(!user||!running)return;setStage('loading');try{const value=await desktopRPC<Connection>('connect',distro,user);setConnection(value);setError('');setStage('ready');setEverReady(true)}catch(e){setError(String(e));setStage('error')}};
 const updateAgent=async()=>{if(!user)return;setBusy(true);const result=await ui.run(`更新 ${distro} 桌面 Agent`,()=>desktopRPC('install',distro,user));setBusy(false);if(result)await reconnect()};
 const uninstallAgent=async()=>{if(!user||!await ui.ask({title:`卸载 ${distro} 的 Agent？`,description:`只删除 ${user} 的 ~/.local/bin/linuxdesk-agent 和上一版本备份。用户文件与浏览器数据保留。${fileDirty?'文件编辑器中还有未保存的修改。':''}`,danger:true,submit:'卸载 Agent'}))return;
   const result=await ui.run(`卸载 ${distro} 桌面 Agent`,()=>desktopRPC('uninstall',distro,user,undefined,true));if(result){setConnection(null);setWindows([]);setEverReady(false);markFileDirty(false);setStage('install')}};
 const openApp=(kind:Kind,cwd?:string)=>{
   setWindows(current=>{const existing=kind==='terminal'?undefined:current.find(w=>w.kind===kind);const nextZ=++z.current;
     if(existing)return current.map(w=>w.id===existing.id?{...w,minimized:false,z:nextZ}:w);
     const count=current.length;const area=stageRef.current,width=area?.clientWidth||900,height=area?.clientHeight||550,w=Math.min(kind==='terminal'?720:kind==='files'?760:660,width-16),h=Math.min(kind==='terminal'?440:470,height-16);
     return [...current,{id:crypto.randomUUID(),kind,x:Math.max(0,Math.min(50+(count%5)*30,width-w-8)),y:Math.max(0,Math.min(58+(count%5)*26,height-h-8)),w,h,z:nextZ,minimized:false,maximized:false,cwd}];
   });
 };
 const browser=async()=>{if(!connection)return;await ui.run(`打开 ${distro} 浏览器`,()=>invoke('browser_open',{distro,user,url:'https://example.com'}))};
 const activate=(id:string)=>{const nextZ=++z.current;setWindows(ws=>ws.map(w=>w.id===id?{...w,z:nextZ,minimized:false}:w))};
 const update=(id:string,patch:Partial<DeskWindow>)=>setWindows(ws=>ws.map(w=>w.id===id?{...w,...patch}:w));
 const close=async(id:string)=>{const target=windows.find(w=>w.id===id);if(target?.kind==='files'&&fileDirty&&!await ui.ask({title:'关闭文件管理器？',description:'文件编辑器中有未保存的修改。',danger:true,submit:'放弃修改并关闭'}))return;setWindows(ws=>ws.filter(w=>w.id!==id))};
 const drag=(event:React.PointerEvent<HTMLDivElement>,window:DeskWindow)=>{if(window.maximized||event.button!==0)return;const startX=event.clientX,startY=event.clientY,originX=window.x,originY=window.y;
   event.currentTarget.setPointerCapture(event.pointerId);const element=event.currentTarget;
   const move=(e:PointerEvent)=>{const area=stageRef.current,scale=area?area.getBoundingClientRect().width/area.clientWidth:1;update(window.id,{x:Math.max(0,Math.min(originX+(e.clientX-startX)/scale,(area?.clientWidth||1000)-Math.min(window.w,(area?.clientWidth||1000)-16)-8)),y:Math.max(0,Math.min(originY+(e.clientY-startY)/scale,(area?.clientHeight||600)-Math.min(window.h,(area?.clientHeight||600)-16)-8))})};
   const stop=()=>{element.removeEventListener('pointermove',move);element.removeEventListener('pointerup',stop);element.removeEventListener('pointercancel',stop)};
   element.addEventListener('pointermove',move);element.addEventListener('pointerup',stop);element.addEventListener('pointercancel',stop);
 };
 const resize=(event:React.PointerEvent<HTMLDivElement>,window:DeskWindow)=>{event.preventDefault();event.stopPropagation();const sx=event.clientX,sy=event.clientY,ow=window.w,oh=window.h;const element=event.currentTarget;element.setPointerCapture(event.pointerId);
   const move=(e:PointerEvent)=>{const area=stageRef.current,scale=area?area.getBoundingClientRect().width/area.clientWidth:1;update(window.id,{w:Math.min(Math.max(360,ow+(e.clientX-sx)/scale),(area?.clientWidth||1000)-window.x-8),h:Math.min(Math.max(260,oh+(e.clientY-sy)/scale),(area?.clientHeight||600)-window.y-8)})};
   const stop=()=>{element.removeEventListener('pointermove',move);element.removeEventListener('pointerup',stop);element.removeEventListener('pointercancel',stop)};
   element.addEventListener('pointermove',move);element.addEventListener('pointerup',stop);element.addEventListener('pointercancel',stop);
 };
 return <div className="linux-desktop" aria-label={`${distro} 桌面`} style={{display:visible?'flex':'none'}}>
   {stage!=='ready'&&!everReady?<div className="desktop-onboarding"><div className="desktop-onboarding-icon"><Box size={30}/></div><h2>{stage==='loading'?'正在连接 Linux 桌面':stage==='install'?'安装 Linux 桌面 Agent':'无法连接桌面'}</h2>
     <p>{stage==='loading'?'正在检查发行版、用户和 Agent 状态…':stage==='install'?`${error&&error.includes('版本不匹配')?error+'。':''}Go Agent 安装在 ${distro} 所选用户的 ~/.local/bin 中，不需要常驻 root。`:error}</p>
     {users&&<label>Linux 用户<select value={user} onChange={e=>chooseUser(e.target.value)}><option value="">请选择普通用户</option>{users.users.filter(u=>!u.root).map(u=><option key={u.name} value={u.name}>{u.name}{u.default?'（默认）':''}</option>)}</select></label>}
     <div className="actions">{stage==='install'&&user&&<button className="primary" disabled={busy} onClick={install}>{busy?'安装中…':'安装并连接'}</button>}{users&&!users.users.some(u=>!u.root)&&<button onClick={createUser}><Plus size={15}/>创建普通用户</button>}{stage==='error'&&<button onClick={()=>user?void reconnect():void loadUsers()}><RefreshCw size={15}/>重试</button>}</div>
   </div>:<><div className="desktop-status"><div><span className={stage==='ready'?'live-dot':'quiet-dot'}/> {distro} <span className="muted">· {connection?.meta.os||'连接中断'} · {connection?.user||user}</span></div><div className="desktop-status-actions"><span className="muted">Agent {connection?.meta.version||'—'}</span><button title="更新 Agent" disabled={busy||stage!=='ready'} onClick={updateAgent}><RefreshCw size={13}/>更新</button><button title="卸载 Agent" disabled={stage!=='ready'} onClick={uninstallAgent}>卸载</button></div></div>
     <div ref={stageRef} className="desktop-stage"><div className="desktop-launchers">{apps.map(a=><button key={a.kind} title={`打开${a.label}`} onClick={()=>a.kind==='browser'?void browser():openApp(a.kind)}><a.icon size={26}/><span>{a.label}</span></button>)}</div>
     {windows.map(w=><div key={w.id} className={`desktop-window ${w.maximized?'maximized':''}`} style={{left:w.maximized?8:w.x,top:w.maximized?8:w.y,width:w.maximized?'calc(100% - 16px)':w.w,height:w.maximized?'calc(100% - 16px)':w.h,zIndex:w.z,display:w.minimized?'none':'flex'}} onPointerDown={()=>activate(w.id)}>
       <div className="desktop-window-title" onPointerDown={e=>drag(e,w)} onDoubleClick={()=>update(w.id,{maximized:!w.maximized})}><strong>{appName(w.kind)}</strong><span className="muted">{distro}</span><div className="desktop-window-controls" onPointerDown={e=>e.stopPropagation()}><button title="最小化" onClick={()=>update(w.id,{minimized:true})}><Minus size={14}/></button><button title={w.maximized?'还原':'最大化'} onClick={()=>update(w.id,{maximized:!w.maximized})}><Maximize2 size={13}/></button><button title="关闭" onClick={()=>close(w.id)}><X size={15}/></button></div></div>
       <div className="desktop-window-body"><DeskApp kind={w.kind} distro={distro} user={user} home={connection?.meta.home||users?.users.find(u=>u.name===user)?.home||'/'} cwd={w.cwd} visible={visible&&!w.minimized} terminal={openApp} setDirty={markFileDirty}/></div>{!w.maximized&&<div className="desktop-resize" onPointerDown={e=>resize(e,w)}/>}</div>)}
     {stage!=='ready'&&<div className="desktop-offline"><h3>{stage==='loading'?'正在重新连接…':'桌面连接已中断'}</h3><p>{error||'文件编辑窗口已保留。'}</p><button className="primary" disabled={!running||stage==='loading'} onClick={()=>void reconnect()}><RefreshCw size={14}/>重新连接</button></div>}
     </div><div className="desktop-taskbar"><button className="desktop-app-menu" title="应用" onClick={()=>openApp('files')}><Box size={18}/></button>{windows.map(w=><button key={w.id} className={w.minimized?'minimized':''} onClick={()=>activate(w.id)}>{apps.find(a=>a.kind===w.kind)?.icon&&(() => {const Icon=apps.find(a=>a.kind===w.kind)!.icon;return <Icon size={15}/>})()}{appName(w.kind)}</button>)}<button onClick={()=>void browser()}><Globe2 size={15}/>浏览器 ↗</button><span className="desktop-clock">{clock.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</span></div></>}
 </div>;
}

function DeskApp({kind,distro,user,home,cwd,visible,terminal,setDirty}:{kind:Kind;distro:string;user:string;home:string;cwd?:string;visible:boolean;terminal:(kind:Kind,cwd?:string)=>void;setDirty:(v:boolean)=>void}){
 if(kind==='files')return <Files distro={distro} home={home} terminal={path=>terminal('terminal',path)} setDirty={setDirty}/>;
 if(kind==='terminal')return <DesktopTerminal distro={distro} user={user} cwd={cwd} visible={visible}/>;
 if(kind==='resources')return <DesktopOverview distro={distro}/>;
 if(kind==='processes')return <Processes distro={distro}/>;
 if(kind==='software')return <Software distro={distro}/>;
 if(kind==='services')return <Services distro={distro}/>;
 return <NetworkPanel distro={distro}/>;
}
function DesktopOverview({distro}:{distro:string}){const info=useData('system.info',distro);return <Overview distro={distro} info={info.data} resources/>}
function DesktopTerminal({distro,user,cwd,visible}:{distro:string;user:string;cwd?:string;visible:boolean}){const [session]=useState<Session>(()=>({id:crypto.randomUUID(),distro,user,cwd}));return <Terminal session={session} visible={visible}/>}
