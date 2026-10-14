import {useEffect,useRef} from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution';
import 'monaco-editor/esm/vs/basic-languages/ini/ini.contribution';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
import 'monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution';
import {useTheme} from './theme/ThemeProvider';
import {presets} from './theme/config';
(globalThis as any).MonacoEnvironment={getWorker:()=>new EditorWorker()};
export default function Editor({path,content,onChange,onSave}:{path:string;content:string;onChange:(v:string)=>void;onSave:()=>void}){
 const host=useRef<HTMLDivElement>(null),callbacks=useRef({onChange,onSave});callbacks.current={onChange,onSave};
 const {preferences}=useTheme();
 useEffect(()=>{const p=presets[preferences.preset],t=p.tokens;monaco.editor.defineTheme('wsl-manager',{base:p.dark?'vs-dark':'vs',inherit:true,rules:[],colors:{'editor.background':t.terminal,'editor.foreground':t.terminalText,'editorCursor.foreground':t.accent,'editor.selectionBackground':t.selection,'editor.lineHighlightBackground':t.input,'editorLineNumber.foreground':t.muted}});monaco.editor.setTheme('wsl-manager')},[preferences.preset]);
 useEffect(()=>{
  const ext=path.split('.').pop()||'';const language=({py:'python',sh:'shell',js:'javascript',ts:'typescript',yaml:'yaml',yml:'yaml',ini:'ini',conf:'ini',md:'markdown',Dockerfile:'dockerfile',json:'json'} as Record<string,string>)[ext]||'plaintext';
  const editor=monaco.editor.create(host.current!,{value:content,language,theme:'wsl-manager',fontSize:14,fontFamily:'Consolas, monospace',automaticLayout:true,minimap:{enabled:false},scrollBeyondLastLine:false,tabSize:2,wordWrap:'on'});
  const sub=editor.onDidChangeModelContent(()=>callbacks.current.onChange(editor.getValue()));
  editor.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyS,()=>callbacks.current.onSave());
  return()=>{sub.dispose();editor.getModel()?.dispose();editor.dispose();};
 },[path]);
 return <div className="monaco-host" ref={host}/>;
}
