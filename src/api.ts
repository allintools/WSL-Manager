import { invoke } from '@tauri-apps/api/core';
export const rpc = <T=any>(method:string,distro?:string,params:Record<string,unknown>={}) => invoke<T>('rpc',{method,distro,params});
export const bytes = (n:number|null|undefined) => {
  if(n==null || !Number.isFinite(n)) return '—';
  const units=['B','KB','MB','GB','TB']; let i=0; while(n>=1024 && i<4){n/=1024;i++;}
  return `${n.toFixed(i===0?0:n>=100?0:1)} ${units[i]}`;
};
export const uptime = (n:number) => {const h=Math.floor(n/3600),d=Math.floor(h/24);return d?`${d} 天 ${h%24} 小时`:`${h} 小时 ${Math.floor(n%3600/60)} 分钟`;};
export type Distro = {name:string;running:boolean;default:boolean;version:number};
export type Process = {pid:number;ppid:number;name:string;command:string;cpu:number|null;rss:number;user:string;state:string;start:string;threads:number};
