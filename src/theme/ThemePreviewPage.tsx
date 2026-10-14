import {ArrowDownToLine,ArrowRight,Check,ChevronDown,ChevronRight,Folder,Home,Layers,Leaf,Monitor,PanelLeftClose,Play,Plus,Search,Settings2,ShieldCheck,SlidersHorizontal,TerminalSquare,Wallpaper} from 'lucide-react';
import {ThemeMiniature,ThemePreviewCard} from './ThemePreviewCard';
import './preview.css';

type Page = 'workspace' | 'appearance';
const wallpaper = '/wallpapers/alpine.webp';
const samples = [
  {name:'Ubuntu-24.04',initial:'U',version:'Ubuntu 24.04 LTS',running:true,default:true},
  {name:'Debian-13',initial:'D',version:'Debian 13 · Trixie',running:true,default:false},
  {name:'Ubuntu-Dev',initial:'U',version:'Ubuntu 24.04 LTS',running:false,default:false},
];

function PreviewBackground(){return <div className="theme-preview-background" aria-hidden="true"><div className="preview-wallpaper"/><div className="preview-wallpaper-mask"/></div>}

function PreviewRail({page}:{page:Page}){
  return <nav className="preview-rail" aria-label="预览页面">
    <span className="preview-rail-brand" aria-label="WSL Manager"><TerminalSquare size={21}/></span>
    <a href="?theme-preview=workspace" className={page==='workspace'?'is-active':''} title="工作台预览" aria-current={page==='workspace'?'page':undefined}><Home size={19}/></a>
    <span className="rail-static" title="发行版管理（静态预览）"><Layers size={19}/></span>
    <a href="?theme-preview=appearance" className={page==='appearance'?'is-active':''} title="外观设置预览" aria-current={page==='appearance'?'page':undefined}><Settings2 size={19}/></a>
    <div className="preview-rail-bottom"><span className="rail-static" title="本地运行"><ShieldCheck size={18}/></span><span className="preview-user" aria-label="本地用户">W</span></div>
  </nav>;
}

function PreviewSidebar({page}:{page:Page}){
  const appearance=page==='appearance';
  return <aside className="preview-sidebar">
    <div className="preview-sidebar-heading"><h2>{appearance?'设置':'WSL Manager'}</h2>{!appearance&&<Search size={17}/>}</div>
    {appearance?<><div className="preview-search"><Search size={15}/><span>搜索设置</span><kbd>⌘ K</kbd></div><p className="preview-nav-label">偏好设置</p><span className="preview-sidebar-item">通用</span><a className="preview-sidebar-item is-active" href="?theme-preview=appearance" aria-current="page">外观</a><span className="preview-sidebar-item">键盘快捷键</span><p className="preview-nav-label">WSL 环境</p><span className="preview-sidebar-item">全局配置</span><span className="preview-sidebar-item">关于</span></>:<><a className="preview-sidebar-item is-active" href="?theme-preview=workspace" aria-current="page"><Home size={16}/>工作台</a><span className="preview-sidebar-item"><ArrowDownToLine size={16}/>版本管理</span><div className="preview-nav-label tw:flex tw:items-center tw:justify-between"><span>Linux 环境</span><Plus size={14}/></div><div className="preview-environment-group"><ChevronDown size={13}/><Folder size={15}/><span>本地发行版</span><span className="preview-count">3</span></div><div className="preview-environments">{samples.map(d=><span className="preview-sidebar-item" key={d.name}><i className={`preview-status-dot ${d.running?'':'is-stopped'}`}/><span>{d.name}</span>{d.default&&<span className="preview-default-mark">默认</span>}</span>)}</div></>}
    <div className="preview-sidebar-footer"><span className="tw:flex tw:items-center tw:gap-2"><Monitor size={15}/>Windows · WSL 2</span><div className="preview-session-note"><Leaf size={17}/><div><strong>Alpine 工作空间</strong><span>静态视觉预览 · 示例数据</span></div></div><a className="preview-return" href="/">返回现有管理器<ArrowRight size={14}/></a></div>
  </aside>;
}

function WorkspacePreview(){
  return <div className="preview-workspace-content">
    <div className="preview-workspace-heading"><div><h1>所有 Linux 环境，<br/><span>一个工作空间。</span></h1><p>查看发行版、打开终端，让日常工作井然有序。</p><div className="tw:flex tw:items-center tw:gap-3"><button className="preview-primary" disabled><Plus size={15}/>安装发行版</button><button className="preview-quiet-button" disabled><ArrowDownToLine size={15}/>导入备份</button></div></div><div className="preview-summary"><Layers size={30} strokeWidth={1.3}/><strong>2<span> / 3</span></strong><span>运行中的 Linux 环境</span><small>示例状态</small></div></div>
    <div className="preview-list-heading"><h2>我的发行版<span>3</span></h2><span>所有环境均在本地运行</span></div>
    <section className="preview-distribution-list" aria-label="发行版示例列表">{samples.map(d=><article className="preview-distribution-row" key={d.name}><div className={`preview-distro-avatar ${d.initial==='D'?'debian':''}`}>{d.initial}</div><div className="preview-distro-name"><h3>{d.name}{d.default&&<span>默认</span>}</h3><p>{d.version} <span>·</span> WSL 2</p></div><span className={`preview-distro-state ${d.running?'':'is-stopped'}`}><i className={`preview-status-dot ${d.running?'':'is-stopped'}`}/>{d.running?'运行中':'已停止'}</span><button className={d.running?'preview-open-desktop':'preview-start-distro'} disabled>{d.running?<Monitor size={15}/>:<Play size={14}/>} {d.running?'打开桌面':'启动环境'}<ChevronRight size={14}/></button></article>)}</section>
    <div className="preview-workspace-bottom"><div><TerminalSquare size={19}/><span><strong>从终端开始工作</strong><small>文件、资源、进程和服务，都在同一个桌面。</small></span></div><span className="preview-local-label"><ShieldCheck size={14}/>LOCAL ONLY</span></div>
  </div>;
}

function StaticRange({name,value,min=0,max=100,suffix='%'}:{name:string;value:number;min?:number;max?:number;suffix?:string}){
  return <label className="preview-effect-row"><span>{name}<output>{value}{suffix}</output></span><input type="range" min={min} max={max} value={value} disabled aria-label={`${name}（静态预览）`}/></label>;
}

function AppearancePreview(){
  return <div className="preview-appearance-content">
    <div className="preview-page-heading"><h1>外观</h1><span>第一阶段 · 静态预览</span></div>
    <section className="preview-setting-surface"><h2>界面大小</h2><p>调整文字、图标和控件的显示比例。</p><div className="tw:flex tw:items-center tw:gap-2"><div className="preview-segmented" aria-label="界面缩放预览">{[90,100,110,125,150].map(n=><span key={n} className={n===100?'is-current':''}>{n}%</span>)}</div><button className="preview-reset" disabled>重置</button></div></section>
    <section className="preview-current-theme"><ThemeMiniature preset="alpine"/><div><span className="preview-current-label">当前主题</span><h2>Alpine</h2><p>山雾与森林，安静的绿色工作空间。</p><div className="preview-color-swatches" aria-label="深绿、浅绿和雾白配色"><i/><i/><i/></div></div><Leaf size={23} className="preview-theme-leaf"/></section>
    <div className="preview-setting-line"><h2>界面风格</h2><div className="preview-segmented" aria-label="界面风格预览"><span className="is-current">Flat</span><span>3D</span></div></div>
    <div className="preview-preset-heading"><h2>选择主题预设</h2><span>3 个精心搭配的主题</span></div>
    <div className="preview-preset-grid"><ThemePreviewCard name="Alpine" preset="alpine" selected/><ThemePreviewCard name="Dark" preset="dark"/><ThemePreviewCard name="Light" preset="light"/></div>
    <div className="preview-wallpaper-heading"><div><h2>壁纸与透明效果</h2><p>背景独立于正文，保持文字与控件清晰。</p></div><Wallpaper size={19}/></div>
    <section className="preview-wallpaper-settings">
      <div className="preview-wallpaper-picker"><img src={wallpaper} alt="山雾笼罩的阿尔卑斯针叶林"/><div><h3>Alpine Forest</h3><p>内置壁纸 · 适应窗口</p></div><button className="preview-secondary" disabled><Plus size={14}/>更换壁纸</button></div>
      <div className="preview-effects-grid"><StaticRange name="壁纸透明度" value={100}/><StaticRange name="面板不透明度" value={64}/><StaticRange name="背景模糊" value={4} max={24} suffix=" px"/><StaticRange name="磨砂强度" value={18} max={32} suffix=" px"/><StaticRange name="遮罩强度" value={24}/></div>
      <div className="preview-performance-note"><SlidersHorizontal size={16}/><span>低性能模式将减少磨砂效果，保留壁纸与清晰文字。</span><span className="preview-switch" aria-label="低性能模式关闭（静态预览）"/></div>
    </section>
    <p className="preview-phase-note"><Check size={14}/>此页用于审查视觉。主题切换、配置保存与效果调整将在后续阶段接入。</p>
  </div>;
}

export default function ThemePreviewPage(){
  const page:Page=new URLSearchParams(location.search).get('theme-preview')==='workspace'?'workspace':'appearance';
  return <div className="theme-preview" data-theme="alpine" data-style="flat"><PreviewBackground/><header className="preview-top-chrome"><span className="preview-top-tools"><PanelLeftClose size={16}/><Layers size={16}/></span><span className="preview-window-tab">{page==='workspace'?'工作台':'外观设置'}<span>×</span></span><div className="preview-top-label">WSL Manager · 视觉预览</div></header><PreviewRail page={page}/><div className="preview-shell"><PreviewSidebar page={page}/><main className="preview-main" aria-label={page==='workspace'?'工作台静态预览':'外观设置静态预览'}>{page==='workspace'?<WorkspacePreview/>:<AppearancePreview/>}</main></div></div>;
}
