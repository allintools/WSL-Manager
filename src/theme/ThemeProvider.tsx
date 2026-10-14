import {createContext,useContext,useEffect,useLayoutEffect,useState,type ReactNode} from 'react';
import {defaults,normalizePreferences,presets,readPreferences,THEME_STORAGE_KEY,wallpaperUrl,type ThemePreferences} from './config';
import './theme.css';

type ThemeContextValue={preferences:ThemePreferences;update:(patch:Partial<ThemePreferences>)=>void;reset:()=>void;storageError:string;wallpaper:string;reducedTransparency:boolean};
const ThemeContext=createContext<ThemeContextValue|null>(null);
export function useTheme(){const context=useContext(ThemeContext);if(!context)throw new Error('useTheme requires ThemeProvider');return context}
export function ThemeProvider({children}:{children:ReactNode}){
 const [preferences,setPreferences]=useState(()=>{try{return readPreferences(localStorage)}catch{return {...defaults}}});
 const [storageError,setStorageError]=useState(''),[reducedTransparency,setReducedTransparency]=useState(false);
 useEffect(()=>{const media=matchMedia('(prefers-reduced-transparency: reduce)');setReducedTransparency(media.matches);const change=()=>setReducedTransparency(media.matches);media.addEventListener('change',change);return()=>media.removeEventListener('change',change)},[]);
 useLayoutEffect(()=>{
   const root=document.documentElement,p=preferences,preset=presets[p.preset],low=p.lowPerformance||reducedTransparency;
   root.dataset.theme=p.preset;root.dataset.style=p.style;root.dataset.performance=low?'low':'normal';
   root.style.colorScheme=preset.dark?'dark':'light';
   for(const [name,value] of Object.entries(preset.tokens))root.style.setProperty(`--theme-${name}`,value);
   const values:Record<string,string>={scale:String(p.scale/100),'wallpaper-opacity':String(p.wallpaperOpacity/100),'panel-opacity':String(p.panelOpacity/100),'wallpaper-blur':`${low?0:p.wallpaperBlur}px`,'glass-blur':`${low?0:p.glassBlur}px`,'overlay-opacity':String(p.overlay/100),'wallpaper-image':wallpaperUrl(p)?`url("${wallpaperUrl(p)}")`:'none'};
   for(const [name,value] of Object.entries(values))root.style.setProperty(`--theme-${name}`,value);
   root.dispatchEvent(new Event('theme-applied'));
   const density=()=>{const width=innerWidth/(p.scale/100);root.dataset.density=width<=800?'narrow':width<=1100?'compact':'wide'};
   density();window.addEventListener('resize',density);return()=>window.removeEventListener('resize',density);
 },[preferences,reducedTransparency]);
 useEffect(()=>{
   try {localStorage.setItem(THEME_STORAGE_KEY,JSON.stringify(preferences));setStorageError('')}catch{setStorageError('无法保存外观设置，当前更改仅在本次运行生效。请释放本地存储空间后重试。')}
 },[preferences]);
 useEffect(()=>{const sync=(event:StorageEvent)=>{if(event.key===THEME_STORAGE_KEY){try{setPreferences(normalizePreferences(event.newValue?JSON.parse(event.newValue):defaults))}catch{}}};window.addEventListener('storage',sync);return()=>window.removeEventListener('storage',sync)},[]);
 const update=(patch:Partial<ThemePreferences>)=>setPreferences(p=>normalizePreferences({...p,...patch}));
 return <ThemeContext.Provider value={{preferences,update,reset:()=>setPreferences({...defaults}),storageError,wallpaper:wallpaperUrl(preferences),reducedTransparency}}>{children}</ThemeContext.Provider>;
}
export function ThemeBackground(){return <div className="theme-background" aria-hidden="true"><div className="theme-wallpaper"/><div className="theme-overlay"/></div>}
