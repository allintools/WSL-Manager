export const THEME_STORAGE_KEY='wsl-manager.appearance.v1';
export const scales=[90,100,110,125,150] as const;
export type ThemeName='alpine'|'dark'|'light';
export type ThemePreferences={version:1;preset:ThemeName;style:'flat'|'3d';scale:typeof scales[number];wallpaper:'preset'|'forest'|'custom'|'none';customWallpaper:string;customWallpaperName:string;wallpaperOpacity:number;panelOpacity:number;wallpaperBlur:number;glassBlur:number;overlay:number;lowPerformance:boolean};
export const presets:Record<ThemeName,{name:string;description:string;dark:boolean;wallpaper:string;tokens:Record<string,string>}>= {
 alpine:{name:'Alpine',description:'山雾与森林，安静的绿色工作空间。',dark:true,wallpaper:'/wallpapers/alpine.webp',tokens:{bg:'#14231f',sidebar:'35 53 50',surface:'27 43 42',canvas:'26 43 39',input:'#233b32',text:'#e4eee7',muted:'#d5e1d9',border:'#52685c',hover:'#354e41',selected:'#30483e',track:'#52695d',accent:'#a5d6ad',onAccent:'#173420',blue:'#a5ccec',amber:'#ebc78e',danger:'#ffb4ae',terminal:'#182820',terminalText:'#e4eee7',selection:'#496a54',overlay:'#091811',shadow:'#0007'}},
 dark:{name:'Dark',description:'低干扰的深色界面，专注内容。',dark:true,wallpaper:'',tokens:{bg:'#171c19',sidebar:'29 36 31',surface:'32 40 34',canvas:'25 32 27',input:'#1c261f',text:'#eef3ef',muted:'#cdd9d0',border:'#4d6153',hover:'#34483a',selected:'#324939',track:'#506356',accent:'#b2d6b5',onAccent:'#1b3420',blue:'#a4ccec',amber:'#ebc78e',danger:'#ffb4ae',terminal:'#151e18',terminalText:'#eef3ef',selection:'#47604e',overlay:'#0c180f',shadow:'#0009'}},
 light:{name:'Light',description:'明亮的雾白与松绿，适合日间工作。',dark:false,wallpaper:'',tokens:{bg:'#edf1ed',sidebar:'233 239 233',surface:'247 250 246',canvas:'243 247 241',input:'#f7faf5',text:'#203526',muted:'#253e2e',border:'#84998a',hover:'#dce8dc',selected:'#d3e4d4',track:'#869e8e',accent:'#3d7049',onAccent:'#ffffff',blue:'#235d86',amber:'#765019',danger:'#a42727',terminal:'#f4f8ef',terminalText:'#203526',selection:'#b3d3b9',overlay:'#102519',shadow:'#25452b24'}},
};
export const defaults:ThemePreferences={version:1,preset:'alpine',style:'flat',scale:100,wallpaper:'preset',customWallpaper:'',customWallpaperName:'',wallpaperOpacity:100,panelOpacity:64,wallpaperBlur:4,glassBlur:18,overlay:24,lowPerformance:false};
for(const preset of Object.values(presets)){
 preset.tokens.magenta=preset.dark?'#d4b2da':'#784276';
 preset.tokens.cyan=preset.dark?'#9fd4ce':'#216367';
 preset.tokens.dialogBackdrop=preset.dark?'#07140dcc':'#20352680';
 preset.tokens.wallpaperGuard=preset.dark?'.32':'.24';
 if(!preset.dark)preset.tokens.overlay=preset.tokens.bg;
 preset.tokens.accentInk=preset.dark?'#d6e9d9':preset.tokens.muted;
}
export function safeWallpaper(value:unknown):value is string {return typeof value==='string'&&value.length<=2_500_000&&/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)}
export function normalizePreferences(input:unknown):ThemePreferences {
 const v=(input&&typeof input==='object'?input:{}) as Record<string,unknown>;
 const num=(k:keyof ThemePreferences,min:number,max:number)=>typeof v[k]==='number'&&Number.isFinite(v[k])?Math.min(max,Math.max(min,v[k] as number)):defaults[k] as number;
 const wallpaper=['preset','forest','custom','none'].includes(v.wallpaper as string)?v.wallpaper as ThemePreferences['wallpaper']:defaults.wallpaper;
 const customWallpaper=safeWallpaper(v.customWallpaper)?v.customWallpaper:'';
 return {...defaults,preset:Object.hasOwn(presets,String(v.preset))?v.preset as ThemeName:defaults.preset,style:v.style==='3d'?'3d':'flat',scale:scales.includes(v.scale as any)?v.scale as ThemePreferences['scale']:100,wallpaper:wallpaper==='custom'&&!customWallpaper?'preset':wallpaper,customWallpaper,customWallpaperName:typeof v.customWallpaperName==='string'?v.customWallpaperName.slice(0,120):'',wallpaperOpacity:num('wallpaperOpacity',0,100),panelOpacity:num('panelOpacity',64,100),wallpaperBlur:num('wallpaperBlur',0,24),glassBlur:num('glassBlur',0,32),overlay:num('overlay',0,70),lowPerformance:v.lowPerformance===true};
}
export function readPreferences(storage:Pick<Storage,'getItem'>):ThemePreferences {
 try {const raw=storage.getItem(THEME_STORAGE_KEY);if(raw)return normalizePreferences(JSON.parse(raw));const legacy=storage.getItem('theme');if(legacy==='light'||legacy==='dark')return {...defaults,preset:legacy};if(legacy==='system')return {...defaults,preset:typeof matchMedia!=='undefined'&&matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'};}catch{}
 return {...defaults};
}
export function wallpaperUrl(prefs:ThemePreferences){return prefs.wallpaper==='none'?'':prefs.wallpaper==='custom'?prefs.customWallpaper:prefs.wallpaper==='forest'?presets.alpine.wallpaper:presets[prefs.preset].wallpaper}
