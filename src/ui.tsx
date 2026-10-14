import React,{createContext,useContext,useEffect,useRef,useState} from 'react';
import {AlertCircle,CheckCircle2,LoaderCircle,RefreshCw,X} from 'lucide-react';
import {rpc} from './api';

type Field={name:string;label:string;value?:string;placeholder?:string;type?:string};
type Prompt={title:string;description:string;danger?:boolean;root?:boolean;match?:string;fields?:Field[];submit?:string};
type Context={ask:(p:Prompt)=>Promise<Record<string,string>|null>;run:(title:string,action:()=>Promise<any>)=>Promise<any>};
const UI=createContext<Context>(null!);
export const useUI=()=>useContext(UI);
export function UIProvider({children}:{children:React.ReactNode}){
 const [prompt,setPrompt]=useState<Prompt|null>(null),[values,setValues]=useState<Record<string,string>>({}),[verify,setVerify]=useState('');
 const resolver=useRef<(v:Record<string,string>|null)=>void>(()=>{}),dialog=useRef<HTMLDialogElement>(null);
 const [tasks,setTasks]=useState<{id:number;title:string;state:string;output:string}[]>([]),[show,setShow]=useState(false);
 const ask=(p:Prompt)=>new Promise<Record<string,string>|null>(resolve=>{resolver.current=resolve;setValues(Object.fromEntries((p.fields||[]).map(f=>[f.name,f.value||''])));setVerify('');setPrompt(p);});
 const close=(value:Record<string,string>|null)=>{dialog.current?.close();setPrompt(null);resolver.current(value);};
 useEffect(()=>{if(prompt)dialog.current?.showModal()},[prompt]);
 const run=async(title:string,action:()=>Promise<any>)=>{const id=Date.now()+Math.random();setShow(true);setTasks(t=>[...t.slice(-19),{id,title,state:'running',output:''}]);
   try {const result=await action();setTasks(t=>t.map(x=>x.id===id?{...x,state:'done',output:result?.output||result?.message||'操作已完成'}:x));return result;}
   catch(e){setTasks(t=>t.map(x=>x.id===id?{...x,state:'error',output:String(e)}:x));return null;}
 };
 return <UI.Provider value={{ask,run}}>{children}
 <button className="activity-toggle" onClick={()=>setShow(!show)}><span className={tasks.some(t=>t.state==='running')?'live-dot':'quiet-dot'}/>{tasks.some(t=>t.state==='running')?'操作执行中':'操作记录'}{tasks.length>0&&<span>{tasks.length}</span>}</button>
 {show&&<section className="activity" aria-label="操作记录"><div className="panel-heading"><h3>操作记录</h3><button className="icon-button" title="收起操作记录" onClick={()=>setShow(false)}><X size={17}/></button></div>
 {!tasks.length?<p className="muted">执行的操作和结果会显示在这里。</p>:<div className="task-list">{[...tasks].reverse().map(t=><details key={t.id} open={t.state!=='done'}><summary>{t.state==='running'?<LoaderCircle size={16} className="spin"/>:t.state==='done'?<CheckCircle2 size={16}/>:<AlertCircle size={16}/>}<span>{t.title}</span><small>{t.state==='running'?'正在执行…':t.state==='done'?'已完成':'失败'}</small></summary>{t.output&&<pre>{t.output}</pre>}{t.state==='running'&&<p className="muted">正在等待系统返回，请保持窗口打开。</p>}</details>)}</div>}</section>}
 <dialog ref={dialog} onCancel={e=>{e.preventDefault();close(null)}} aria-labelledby="dialog-title">
 {prompt&&<form onSubmit={e=>{e.preventDefault();close({...values,confirmation:verify})}}><div className="dialog-icon"><AlertCircle size={24}/></div><h2 id="dialog-title">{prompt.title}</h2><p className="dialog-description">{prompt.description}</p>{prompt.root&&<div className="notice">本次操作将以 Linux Root 身份执行。</div>}
 {prompt.fields?.map(f=><label className="field" key={f.name}>{f.label}<input autoFocus={f===prompt.fields?.[0]} required type={f.type||'text'} value={values[f.name]||''} placeholder={f.placeholder} onChange={e=>setValues({...values,[f.name]:e.target.value})}/></label>)}
 {prompt.match&&<label className="field">输入「{prompt.match}」确认<input autoFocus value={verify} onChange={e=>setVerify(e.target.value)} autoComplete="off"/></label>}
 <div className="dialog-actions"><button type="button" onClick={()=>close(null)}>取消</button><button className={prompt.danger?'danger primary':'primary'} disabled={!!prompt.match&&verify!==prompt.match}>{prompt.submit||'确认执行'}</button></div></form>}
 </dialog></UI.Provider>;
}
export function useData<T=any>(method:string,distro?:string,params:Record<string,unknown>={},interval=0){
 const [data,setData]=useState<T|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[revision,setRevision]=useState(0);
 const paramKey=JSON.stringify(params);
 useEffect(()=>{let valid=true;let timer:ReturnType<typeof setTimeout>;setData(null);setLoading(true);setError('');
   const load=async()=>{try{const value=await rpc<T>(method,distro,JSON.parse(paramKey));if(valid){setData(value);setError('');}}
     catch(e){if(valid)setError(String(e))}finally{if(valid){setLoading(false);if(interval)timer=setTimeout(load,interval);}}};
   void load();return()=>{valid=false;clearTimeout(timer)};
 },[method,distro,paramKey,interval,revision]);
 return {data,error,loading,reload:()=>setRevision(v=>v+1)};
}
export function DataState({loading,error,reload,children}:{loading:boolean;error:string;reload:()=>void;children:React.ReactNode}){
 if(loading)return <div className="loading-state"><div className="skeleton"/><div className="skeleton"/><p><LoaderCircle className="spin" size={16}/>正在读取 Linux 数据…</p></div>;
 if(error)return <div className="error-state" role="alert"><AlertCircle size={28}/><h3>暂时无法读取</h3><p>{error}</p><button onClick={reload}><RefreshCw size={16}/>重试</button></div>;
 return <>{children}</>;
}
export function Empty({title,children}:{title:string;children?:React.ReactNode}){return <div className="empty"><h3>{title}</h3>{children&&<p>{children}</p>}</div>}
export function Meter({value,color}:{value:number;color?:string}){return <div className="meter"><div style={{width:`${Math.min(100,Math.max(0,value||0))}%`,background:color}}/></div>}
export function Chart({values,label,color='var(--accent)'}:{values:(number|null)[];label:string;color?:string}){
 const width=680,height=150;const points=values.map((v,i)=>`${i*width/Math.max(1,values.length-1)},${height-(v||0)*height/100}`).join(' ');
 return <div className="chart"><div className="chart-labels"><span>100%</span><span>50%</span><span>0%</span></div><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} preserveAspectRatio="none"><path d={`M0 1H${width}M0 75H${width}M0 149H${width}`} className="grid-lines"/>{values.length>1&&<polyline points={points} fill="none" stroke={color} strokeWidth="2.5" vectorEffect="non-scaling-stroke"/>}</svg></div>;
}
