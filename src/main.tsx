import {createRoot} from 'react-dom/client';
import {Component,lazy,Suspense,type ReactNode} from 'react';
import App from './App';
import BrowserChrome from './BrowserChrome';
import {UIProvider} from './ui';
import './style.css';
import {ThemeProvider,ThemeBackground} from './theme/ThemeProvider';
import {NativeThemeSync} from './theme/NativeThemeSync';
import './theme/integration.css';
class ErrorBoundary extends Component<{children:ReactNode},{error:string}>{state={error:''};static getDerivedStateFromError(e:Error){return {error:e.message}};render(){return this.state.error?<div className="error-state"><h2>界面遇到问题</h2><p>{this.state.error}</p><button onClick={()=>location.reload()}>重新载入</button></div>:this.props.children}}
const route=new URLSearchParams(location.search);
const ThemePreviewPage=lazy(()=>import('./theme/ThemePreviewPage'));
createRoot(document.getElementById('root')!).render(<ErrorBoundary>{route.has('theme-preview')?<Suspense fallback={<div role="status">正在载入视觉预览…</div>}><ThemePreviewPage/></Suspense>:<ThemeProvider><NativeThemeSync/><ThemeBackground/>{route.has('browser')?<BrowserChrome/>:<UIProvider><App/></UIProvider>}</ThemeProvider>}</ErrorBoundary>);
