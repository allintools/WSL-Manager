import {Check} from 'lucide-react';
import {presets} from './config';
import type {CSSProperties} from 'react';

export type PreviewPreset = 'alpine' | 'dark' | 'light';

/** Preset miniature never inherits the selected application's palette. */
export function ThemeMiniature({preset}:{preset:PreviewPreset}) {
  const t=presets[preset].tokens;
  return <div className="theme-miniature" data-preset={preset} aria-hidden="true" style={{'--mini-bg':t.bg,'--mini-panel':`rgb(${t.surface} / 87%)`,'--mini-text':t.text,'--mini-accent':t.accent,'--mini-overlay':t.overlay} as CSSProperties}>
    <div className="miniature-rail"><i/><i/><i/></div>
    <div className="miniature-tab"><i/><i/></div>
    <div className="miniature-window">
      <div className="miniature-sidebar"><i/><i/><i/></div>
      <div className="miniature-content"><i/><i/><i/><div className="miniature-composer"><i/><b/></div></div>
    </div>
  </div>;
}

export function ThemePreviewCard({preset,name,selected=false,onSelect}:{preset:PreviewPreset;name:string;selected?:boolean;onSelect?:()=>void}) {
  if(onSelect)return <button type="button" className="theme-preset" aria-label={`${name} 主题`} aria-pressed={selected} onClick={onSelect}><ThemeMiniature preset={preset}/><span className="theme-preset-caption"><strong>{name}</strong>{selected&&<span><Check size={14}/>当前</span>}</span></button>;
  return <figure className={`theme-preview-card ${selected?'is-selected':''}`}>
    <ThemeMiniature preset={preset}/>
    <figcaption><span>{name}</span>{selected&&<span className="preset-current"><Check size={14}/>当前</span>}</figcaption>
  </figure>;
}
