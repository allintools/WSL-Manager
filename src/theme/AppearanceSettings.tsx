import {useRef,useState} from 'react';
import {Leaf,RotateCcw,Wallpaper} from 'lucide-react';
import {useTheme} from './ThemeProvider';
import {presets,scales,safeWallpaper,type ThemeName,type ThemePreferences} from './config';
import {ThemeMiniature,ThemePreviewCard} from './ThemePreviewCard';
import './appearance.css';

async function importWallpaper(file:File){
 if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('请选择 PNG、JPEG 或 WebP 图片。');
 if(file.size>20*1024*1024)throw new Error('图片超过 20 MB，请选择较小的图片。');
 let bitmap:ImageBitmap;
 try{bitmap=await createImageBitmap(file)}catch{throw new Error('图片无法读取，请检查格式或更换图片。')}
 try {const ratio=Math.min(1,1920/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*ratio));canvas.height=Math.max(1,Math.round(bitmap.height*ratio));canvas.getContext('2d')!.drawImage(bitmap,0,0,canvas.width,canvas.height);const data=canvas.toDataURL('image/webp',.82);if(!safeWallpaper(data))throw new Error('压缩后图片仍然过大，请选择较小的图片。');return data;}finally{bitmap.close()}
}
export function AppearanceSettings(){
 const {preferences:p,update,reset,storageError,wallpaper,reducedTransparency}=useTheme(),file=useRef<HTMLInputElement>(null),[uploadError,setUploadError]=useState(''),[busy,setBusy]=useState(false);
 const selected=presets[p.preset];
 const upload=async(input:File|undefined)=>{if(!input)return;setBusy(true);setUploadError('');try{update({customWallpaper:await importWallpaper(input),customWallpaperName:input.name,wallpaper:'custom'})}catch(e){setUploadError(e instanceof Error?e.message:'无法读取图片，请重试。')}finally{setBusy(false);if(file.current)file.current.value=''}};
 const range=(key:'wallpaperOpacity'|'panelOpacity'|'wallpaperBlur'|'glassBlur'|'overlay',label:string,min:number,max:number,suffix:string,disabled=false)=><label className="appearance-range"><span>{label}<output>{p[key]}{suffix}</output></span><input aria-label={label} type="range" min={min} max={max} step="1" value={p[key]} disabled={disabled} onChange={e=>update({[key]:Number(e.target.value)})}/></label>;
 return <section className="appearance-settings" aria-labelledby="appearance-title">
   <div className="appearance-heading"><div><h2 id="appearance-title">外观</h2><p className="muted">主题、壁纸与显示比例，更改立即生效。</p></div><button onClick={()=>{reset();setUploadError('')}} disabled={busy} title="恢复全部外观默认设置"><RotateCcw size={15}/>恢复默认</button></div>
   {storageError&&<p className="notice error" role="alert">{storageError}</p>}{uploadError&&<p className="notice error" role="alert">{uploadError}</p>}
   <section className="appearance-surface"><h3>界面大小</h3><p className="muted">调整文字、图标与控件，不改变 Linux 中的显示设置。</p><div className="tw:flex tw:items-center tw:gap-2 appearance-scale"><div className="segmented" role="group" aria-label="界面缩放">{scales.map(n=><button key={n} aria-pressed={p.scale===n} className={p.scale===n?'selected':''} onClick={()=>update({scale:n})}>{n}%</button>)}</div><button onClick={()=>update({scale:100})}>重置比例</button></div></section>
   <div className="appearance-current"><ThemeMiniature preset={p.preset}/><div><h3>{selected.name}</h3><p className="muted">{selected.description}</p><div className="appearance-swatches" aria-hidden="true">{[selected.tokens.bg,selected.tokens.accent,selected.tokens.text].map(c=><i key={c} style={{background:c}}/>)}</div></div><Leaf size={22}/></div>
   <div className="appearance-line"><h3>界面风格</h3><div className="segmented" role="group" aria-label="界面风格">{(['flat','3d'] as const).map(style=><button key={style} aria-pressed={p.style===style} className={p.style===style?'selected':''} onClick={()=>update({style})}>{style==='flat'?'Flat':'3D'}</button>)}</div></div>
   <div className="appearance-line"><h3>选择主题预设</h3><span className="muted small">Alpine · Dark · Light</span></div>
   <div className="appearance-presets">{(Object.keys(presets) as ThemeName[]).map(name=><ThemePreviewCard key={name} preset={name} name={presets[name].name} selected={p.preset===name} onSelect={()=>update({preset:name})}/>)}</div>
   <div className="appearance-line"><div><h3>壁纸与透明效果</h3><p className="muted small">背景独立于正文，文字保持清晰。</p></div><Wallpaper size={20}/></div>
   <section className="appearance-surface">
     <div className="appearance-wallpaper-picker">{wallpaper?<img src={wallpaper} alt="当前背景壁纸"/>:<div className="appearance-no-wallpaper"><Wallpaper size={23}/></div>}<div className="grow"><strong>{p.wallpaper==='custom'?p.customWallpaperName:wallpaper?'Alpine Forest':'无壁纸'}</strong><p className="muted small">图片保存在本机，自动压缩以降低显存占用。</p></div><button onClick={()=>file.current?.click()} disabled={busy}>{busy?'处理图片…':'更换壁纸'}</button><input className="appearance-upload" ref={file} aria-label="选择壁纸文件" type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>void upload(e.target.files?.[0])}/></div>
     <div className="appearance-wallpaper-options"><label>壁纸来源<select aria-label="壁纸来源" value={p.wallpaper} onChange={e=>update({wallpaper:e.target.value as ThemePreferences['wallpaper']})}><option value="preset">跟随主题</option><option value="forest">内置森林</option>{p.customWallpaper&&<option value="custom">自定义图片</option>}<option value="none">无壁纸</option></select></label>{p.customWallpaper&&<button onClick={()=>update({customWallpaper:'',customWallpaperName:'',wallpaper:p.wallpaper==='custom'?'preset':p.wallpaper})} disabled={busy}>移除自定义图片</button>}</div>
     <div className="appearance-ranges">{range('wallpaperOpacity','壁纸不透明度',0,100,'%')}{range('panelOpacity','面板不透明度',64,100,'%')}{range('wallpaperBlur','背景模糊',0,24,' px',p.lowPerformance||reducedTransparency)}{range('glassBlur','磨砂强度',0,32,' px',p.lowPerformance||reducedTransparency)}{range('overlay','遮罩强度',0,70,'%')}</div>
     <p className="muted small">面板至少保留 64% 不透明度，深色壁纸带有基础保护色，保障文字对比度。</p>
     <label className="appearance-performance"><span><strong>低性能模式</strong><small className="muted">关闭模糊与磨砂，保留主题、壁纸和清晰文字。</small></span><input type="checkbox" role="switch" aria-label="低性能模式" checked={p.lowPerformance} onChange={e=>update({lowPerformance:e.target.checked})}/></label>
     {reducedTransparency&&<p className="muted small">系统已要求减少透明效果，当前自动关闭模糊与磨砂。</p>}
   </section>
   <p className="appearance-save-status" role="status">{storageError?'偏好尚未保存':'偏好已自动保存在本机，重新打开软件后恢复。'}</p>
 </section>;
}
