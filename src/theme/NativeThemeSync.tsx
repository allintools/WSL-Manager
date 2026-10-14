import {useEffect} from 'react';
import {isTauri} from '@tauri-apps/api/core';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {useTheme} from './ThemeProvider';
import {presets} from './config';

/** Desktop adapter; the reusable provider has no dependency on native IPC. */
export function NativeThemeSync(){
 const {preferences}=useTheme();
 useEffect(()=>{if(isTauri())void getCurrentWindow().setTheme(presets[preferences.preset].dark?'dark':'light').catch(()=>{})},[preferences.preset]);
 return null;
}
