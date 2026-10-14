import {useEffect,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {ArrowLeft,ArrowRight,Globe2,Plus,RefreshCw,X} from 'lucide-react';
import './browser.css';
import {useTheme} from './theme/ThemeProvider';

type Tab={id:number;url:string};
type Snapshot={active:number;tabs:Tab[]};
const distro=new URLSearchParams(location.search).get('distro')||'';
const call=(method:string,id?:number,url?:string)=>invoke<Snapshot>('browser_rpc',{method,distro,id,url});

export default function BrowserChrome(){
 const {preferences}=useTheme();
 const [state,setState]=useState<Snapshot>({active:0,tabs:[]}),[address,setAddress]=useState(''),[error,setError]=useState('');
 const refresh=async()=>{try{const value=await call('state');setState(value);setError('');const active=value.tabs.find(t=>t.id===value.active);if(document.activeElement?.tagName!=='INPUT')setAddress(active?.url||'')}catch(e){setError(String(e))}};
 useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),1200);return()=>clearInterval(timer)},[]);
 useEffect(()=>{void call('layout',undefined,String(83*preferences.scale/100)).catch(e=>setError(String(e)))},[preferences.scale]);
 const action=async(method:string,id?:number,url?:string)=>{try{setState(await call(method,id,url));setError('');setTimeout(()=>void refresh(),250)}catch(e){setError(String(e))}};
 return <div className="browser-chrome"><div className="browser-tabs"><span className="browser-instance"><Globe2 size={14}/>{distro}</span>{state.tabs.map(t=><div key={t.id} className={state.active===t.id?'browser-tab active':'browser-tab'}><button title={t.url} onClick={()=>void action('switch',t.id)}>{(()=>{try{return new URL(t.url).hostname||'新标签'}catch{return '新标签'}})()}</button>{state.tabs.length>1&&<button className="browser-close" title="关闭标签" onClick={()=>void action('close',t.id)}><X size={12}/></button>}</div>)}<button className="browser-new" title="新建标签" onClick={()=>void action('new')}><Plus size={15}/></button></div>
   <div className="browser-toolbar"><button title="后退" onClick={()=>void action('back')}><ArrowLeft size={16}/></button><button title="前进" onClick={()=>void action('forward')}><ArrowRight size={16}/></button><button title="刷新" onClick={()=>void action('reload')}><RefreshCw size={15}/></button><form onSubmit={e=>{e.preventDefault();void action('navigate',undefined,address)}}><Globe2 size={14}/><input aria-label="网址" value={address} onChange={e=>setAddress(e.target.value)} spellCheck={false}/></form><span className="browser-route">经 {distro} 网络</span></div>
   {error&&<div className="browser-error" role="alert">{error}</div>}
 </div>;
}
