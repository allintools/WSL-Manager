import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {Terminal as XTerminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {useTheme} from './theme/ThemeProvider';
import {presets} from './theme/config';
export type Session={id:string;distro:string;cwd?:string;user?:string};
export function Terminal({session,visible}:{session:Session;visible:boolean}){
 const host=useRef<HTMLDivElement>(null),fitRef=useRef<()=>void>(()=>{}),terminalRef=useRef<XTerminal|null>(null),[error,setError]=useState('');
 const {preferences}=useTheme();
 const colors=presets[preferences.preset].tokens;
 const terminalTheme={background:colors.terminal,foreground:colors.terminalText,cursor:colors.accent,cursorAccent:colors.onAccent,selectionBackground:colors.selection,black:colors.terminal,red:colors.danger,green:colors.accent,yellow:colors.amber,blue:colors.blue,magenta:colors.magenta,cyan:colors.cyan,white:colors.text,brightBlack:colors.muted,brightRed:colors.danger,brightGreen:colors.accent,brightYellow:colors.amber,brightBlue:colors.blue,brightMagenta:colors.magenta,brightCyan:colors.cyan,brightWhite:colors.text};
 useEffect(()=>{let disposed=false,created=false;const cleanup:(()=>void)[]=[];
   const terminal=new XTerminal({fontFamily:'Cascadia Code, Consolas, monospace',fontSize:14,cursorBlink:true,scrollback:5000,theme:terminalTheme,allowProposedApi:false});terminalRef.current=terminal;
   const fit=new FitAddon();terminal.loadAddon(fit);terminal.open(host.current!);
   const resize=()=>{if(host.current?.clientWidth&&host.current.clientHeight){fit.fit();if(created)void invoke('terminal_resize',{id:session.id,cols:terminal.cols,rows:terminal.rows}).catch(()=>{});}};
   fitRef.current=resize;const ro=new ResizeObserver(resize);ro.observe(host.current!);
   (async()=>{
     cleanup.push(await listen<{id:string;data:string}>('terminal-output',e=>{if(e.payload.id===session.id){const raw=atob(e.payload.data);terminal.write(Uint8Array.from(raw,c=>c.charCodeAt(0)));}}));
     cleanup.push(await listen<{id:string}>('terminal-exit',e=>{if(e.payload.id===session.id){created=false;terminal.write('\r\n\x1b[90m[终端已退出]\x1b[0m\r\n');}}));
     if(disposed){cleanup.forEach(f=>f());return;}
     resize();await invoke('terminal_create',{distro:session.distro,id:session.id,cols:terminal.cols,rows:terminal.rows,cwd:session.cwd,user:session.user});created=true;
     if(disposed){void invoke('terminal_close',{id:session.id});return;}
     resize();terminal.focus();
     const input=terminal.onData(data=>{void invoke('terminal_input',{id:session.id,data}).catch(e=>setError(String(e)))});cleanup.push(()=>input.dispose());
   })().catch(e=>{if(!disposed)setError(String(e))});
   return()=>{disposed=true;ro.disconnect();cleanup.forEach(f=>f());if(created)void invoke('terminal_close',{id:session.id});terminalRef.current=null;terminal.dispose();};
 },[session.id]);
 useEffect(()=>{if(visible)requestAnimationFrame(()=>fitRef.current())},[visible]);
 useEffect(()=>{if(terminalRef.current)terminalRef.current.options.theme=terminalTheme;requestAnimationFrame(()=>fitRef.current())},[preferences.preset,preferences.scale]);
 return <div className="terminal-session" style={{display:visible?'flex':'none'}}>{error&&<div className="notice error">{error}</div>}<div ref={host} className="terminal-host"/></div>;
}
