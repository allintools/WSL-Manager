import {useEffect,useMemo,useState} from 'react';
import {ArrowDownToLine,CloudDownload,Globe,HardDriveDownload,RefreshCw,RotateCw,Search,ShieldAlert} from 'lucide-react';
import {rpc,type Distro} from './api';
import {useData,useUI} from './ui';

type OnlineDistro={name:string;friendlyName:string};
type DebianRelease={id:string;name:string;codename:string};
type Host={version?:string;status?:string;defaultVersion?:number|null};

export function Versions({distros,host,reloadDistros,reloadHost}:{distros:Distro[];host:Host|null;reloadDistros:()=>void;reloadHost:()=>void}){
 const catalog=useData<OnlineDistro[]>('host.online'),debianReleases=useData<DebianRelease[]>('host.debian-releases'),ui=useUI();
 const [query,setQuery]=useState(''),[source,setSource]=useState<'store'|'web'>('store'),[preview,setPreview]=useState(false),[location,setLocation]=useState(''),[defaultVersion,setDefaultVersion]=useState(host?.defaultVersion||2);
 useEffect(()=>{if(host?.defaultVersion)setDefaultVersion(host.defaultVersion)},[host?.defaultVersion]);
 const installed=useMemo(()=>new Set(distros.map(d=>d.name)),[distros]);
 const available=(catalog.data||[]).filter(d=>!installed.has(d.name)).filter(d=>`${d.name} ${d.friendlyName}`.toLowerCase().includes(query.toLowerCase()));
 const update=async(webDownload:boolean)=>{
   const v=await ui.ask({title:preview?'更新到 WSL 预览版？':'更新 WSL 引擎？',description:`将通过 ${webDownload?'web-download':'Microsoft Store'} 获取 WSL${preview?' 预览版':''}更新。更新完成后可在平台信息中核对版本。`,submit:'开始更新'});if(!v)return;
   const result=await ui.run(`更新 WSL${preview?' 预览版':''}`,()=>rpc('host.update',undefined,{webDownload,preRelease:preview,confirmed:true}));if(result)reloadHost();
 };
 const setDefault=async()=>{
   if(defaultVersion===host?.defaultVersion)return;
   const v=await ui.ask({title:`将新发行版默认设为 WSL ${defaultVersion}？`,description:'只影响之后安装或导入时未指定版本的发行版，不会转换现有发行版。',submit:'设置默认版本'});if(!v)return;
   const result=await ui.run(`设置默认 WSL ${defaultVersion}`,()=>rpc('host.set-default-version',undefined,{version:defaultVersion,confirmed:true}));if(result)reloadHost();
 };
 const install=async(d:OnlineDistro)=>{
   const v=await ui.ask({title:`下载并安装 ${d.name}？`,description:`${d.friendlyName}\n来源：${source==='web'?'web-download':'Microsoft Store'}\n${location.trim()?`安装位置：${location.trim()}`:'使用 WSL 默认安装位置'}\n安装后不会自动启动。`,submit:'下载并安装'});if(!v)return;
   const result=await ui.run(`下载并安装 ${d.name}`,()=>rpc('distro.install',undefined,{name:d.name,location:location.trim(),webDownload:source==='web',confirmed:true}));if(result){reloadDistros();catalog.reload();}
 };
 const installDebianRelease=async(d:DebianRelease)=>{
   const name=`Debian-${d.name.match(/\d+/)?.[0]||d.id}`;
   const v=await ui.ask({title:`下载并安装 ${d.name} (${d.codename})？`,description:`从 Debian 官方云镜像下载并校验 SHA-512 后导入为 WSL 2。发行版名称：${name}\n${location.trim()?`安装位置：${location.trim()}`:'使用应用默认安装位置'}\n首次启动默认进入 root。`,submit:'下载并安装'});if(!v)return;
   const result=await ui.run(`下载并安装 ${d.name}`,()=>rpc('distro.install-debian-release',undefined,{release:d.id,name,location:location.trim(),confirmed:true}));if(result){reloadDistros();catalog.reload();}
 };
 const convert=async(d:Distro)=>{
   const next=d.version===2?1:2;
   const v=await ui.ask({title:`将 ${d.name} 转换为 WSL ${next}？`,description:'转换可能需要较长时间。发行版中的文件会保留；转换期间请勿关闭电脑或中断进程。',submit:`转换为 WSL ${next}`});if(!v)return;
   const result=await ui.run(`转换 ${d.name} → WSL ${next}`,()=>rpc('distro.set-version',d.name,{version:next,confirmed:true}));if(result)reloadDistros();
 };
 const lines=(host?.version||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
 return <div className="versions-page">
  <div className="page-heading"><div><h1>版本管理</h1><p>管理 WSL 引擎、发行版下载与 WSL 1 / 2 运行模式。</p></div><button onClick={()=>{reloadHost();catalog.reload();reloadDistros()}}><RefreshCw size={15}/>刷新状态</button></div>
  <section className="version-engine panel">
   <div className="section-heading"><div><h3>WSL 引擎</h3><p className="muted">Windows 上的 WSL 组件、Linux 内核与新发行版默认运行模式。</p></div><span className="tag">{host?.defaultVersion?`默认 WSL ${host.defaultVersion}`:'版本状态'}</span></div>
   <div className="engine-layout"><div className="engine-readout"><div className="version-readout-icon"><RotateCw size={19}/></div><div><strong>{lines[0]||'正在读取 WSL 版本…'}</strong><p>{lines.slice(1,3).join(' · ')||'查看内核与组件版本'}</p></div></div>
    <div className="engine-actions"><label className="version-check"><input type="checkbox" checked={preview} onChange={e=>setPreview(e.target.checked)}/>包含预览版</label><div className="actions"><button disabled={catalog.loading} onClick={()=>void update(false)}><RefreshCw size={15}/>从 Store 更新</button><button className="primary" onClick={()=>void update(true)}><CloudDownload size={16}/>web-download 更新</button></div></div>
   </div>
   <div className="default-version-row"><div><strong>新发行版默认版本</strong><p className="muted">更改仅影响之后新安装的发行版。</p></div><div className="actions"><select aria-label="新发行版默认 WSL 版本" value={defaultVersion} onChange={e=>setDefaultVersion(Number(e.target.value))}><option value={2}>WSL 2</option><option value={1}>WSL 1</option></select><button disabled={defaultVersion===host?.defaultVersion} onClick={()=>void setDefault()}>保存</button></div></div>
   <details className="engine-details"><summary>查看完整版本与状态信息</summary><pre>{`${host?.version||''}\n${host?.status||''}`.trim()||'正在读取…'}</pre></details>
  </section>

  <section className="version-catalog panel">
   <div className="section-heading"><div><h3>下载发行版</h3><p className="muted">列表来自本机 WSL 在线目录；安装通过微软支持的 WSL 命令完成。</p></div><button className="text-button" onClick={catalog.reload}><RefreshCw size={15}/>刷新目录</button></div>
   <div className="catalog-controls"><label className="search"><Search size={15}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索发行版名称" aria-label="搜索可安装发行版"/></label><div className="segmented" role="group" aria-label="下载来源"><button className={source==='store'?'selected':''} aria-pressed={source==='store'} onClick={()=>setSource('store')}>Microsoft Store</button><button className={source==='web'?'selected':''} aria-pressed={source==='web'} onClick={()=>setSource('web')}>web-download</button></div></div>
   <label className="version-location"><span>安装位置 <small className="muted">可选；留空使用 WSL 默认路径</small></span><input value={location} onChange={e=>setLocation(e.target.value)} placeholder="例如 D:\\WSL\\Debian" aria-label="发行版安装位置"/></label>
   {catalog.loading?<div className="catalog-state"><RefreshCw size={16} className="spin"/>正在查询 WSL 在线发行版目录…</div>:catalog.error?<div className="catalog-state error-text"><ShieldAlert size={17}/><span>{catalog.error}</span><button onClick={catalog.reload}>重试</button></div>:<>
    <div className="catalog-summary"><Globe size={14}/>{available.length} 个可安装版本 · 已安装的发行版显示在下方</div>
    <div className="table-wrap"><table><thead><tr><th>发行版</th><th>包名</th><th className="right">操作</th></tr></thead><tbody>{available.map(d=><tr key={d.name}><td><strong>{d.friendlyName}</strong></td><td className="mono muted">{d.name}</td><td className="right"><button className="small-button" onClick={()=>void install(d)}><ArrowDownToLine size={14}/>下载并安装</button></td></tr>)}</tbody></table></div>
    {!available.length&&<p className="catalog-empty">{query?'没有匹配的发行版。':'目录中的发行版都已安装。'}</p>}
   </>}
  </section>

  <section className="version-catalog panel">
   <div className="section-heading"><div><h3>Debian 指定版本</h3><p className="muted">Debian 官方 Cloud 镜像（amd64，非 Store 包）；下载后校验 SHA-512，再导入为独立 WSL 2 发行版。</p></div></div>
   {debianReleases.loading?<div className="catalog-state"><RefreshCw size={16} className="spin"/>正在读取 Debian 版本…</div>:debianReleases.error?<div className="catalog-state error-text"><ShieldAlert size={17}/><span>{debianReleases.error}</span></div>:<div className="table-wrap"><table><thead><tr><th>发行版版本</th><th>代号</th><th className="right">操作</th></tr></thead><tbody>{(debianReleases.data||[]).filter(d=>`${d.name} ${d.codename}`.toLowerCase().includes(query.toLowerCase())).map(d=><tr key={d.id}><td><strong>{d.name}</strong></td><td className="mono muted">{d.codename}</td><td className="right"><button className="small-button" disabled={distros.some(x=>x.name===`Debian-${d.name.match(/\d+/)?.[0]}`)} onClick={()=>void installDebianRelease(d)}><ArrowDownToLine size={14}/>下载并安装</button></td></tr>)}</tbody></table></div>}
  </section>

  <section className="panel installed-versions">
   <div className="section-heading"><div><h3>已安装发行版</h3><p className="muted">WSL 版本可逐个转换；系统转换结束后列表会自动刷新。</p></div><span className="count">{distros.length}</span></div>
   {distros.length?<div className="table-wrap"><table><thead><tr><th>发行版</th><th>状态</th><th>运行模式</th><th className="right">版本操作</th></tr></thead><tbody>{distros.map(d=><tr key={d.name}><td><strong>{d.name}</strong>{d.default&&<span className="tag version-default-tag">默认</span>}</td><td><span className={d.running?'status running':'status'}><span className={d.running?'live-dot':'quiet-dot'}/>{d.running?'运行中':'已停止'}</span></td><td>WSL {d.version}</td><td className="right"><button className="small-button" disabled={d.version===1} onClick={()=>void convert(d)}>转换为 WSL 1</button><button className="small-button" disabled={d.version===2} onClick={()=>void convert(d)}>转换为 WSL 2</button></td></tr>)}</tbody></table></div>:<p className="catalog-empty">尚未安装发行版。可在上方在线目录中下载。</p>}
  </section>
  <p className="version-footnote"><HardDriveDownload size={14}/> 导入 / 导出备份仍可从工作台或发行版操作菜单使用。安装和引擎更新需要网络，耗时取决于下载源与网络速度。</p>
 </div>;
}
