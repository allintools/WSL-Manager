#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use sha2::{Digest, Sha512};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::{collections::HashMap, fs, io::{BufRead, BufReader, Read, Write}, path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio}, sync::{mpsc, Arc, Mutex}, thread, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use tauri::{Emitter, Manager};
#[cfg(windows)]
use std::os::windows::process::CommandExt;

const AGENT: &str = include_str!("../../agent/agent.py");
type Result<T> = std::result::Result<T, String>;
mod smoke;
mod desktop;
mod browser;

fn command(program: &str) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)] c.creation_flags(0x08000000);
    c
}
fn decode(bytes: &[u8]) -> String {
    if bytes.iter().take(80).filter(|&&x| x == 0).count() > 5 || bytes.starts_with(&[255,254]) {
        String::from_utf16_lossy(&bytes.chunks_exact(2).map(|p|u16::from_le_bytes([p[0],p[1]])).collect::<Vec<_>>()).trim_start_matches('\u{feff}').to_string()
    } else { String::from_utf8_lossy(bytes).into_owned() }
}
fn execute(program: &str, args: &[String], timeout: u64) -> Result<String> {
    let mut child = command(program).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e|e.to_string())?;
    let mut out = child.stdout.take().unwrap(); let mut err = child.stderr.take().unwrap();
    let a = thread::spawn(move || {let mut b=Vec::new(); let _=out.read_to_end(&mut b); b});
    let b = thread::spawn(move || {let mut b=Vec::new(); let _=err.read_to_end(&mut b); b});
    let start = Instant::now();
    let status = loop {match child.try_wait().map_err(|e|e.to_string())? {
        Some(s)=>break s, None if start.elapsed().as_secs()>timeout=>{let _=child.kill(); let _=child.wait(); return Err("操作超时，请检查 WSL 状态后重试".into())}, None=>thread::sleep(Duration::from_millis(40))
    }};
    let output=decode(&a.join().unwrap_or_default()); let error=decode(&b.join().unwrap_or_default());
    if !status.success() {Err(format!("{}\n{}",output,error).trim().to_string())} else {Ok(output)}
}
fn wsl(args: &[&str], timeout:u64) -> Result<String> {execute("wsl.exe", &args.iter().map(|s|s.to_string()).collect::<Vec<_>>(),timeout)}
fn list() -> Result<Value> {
    let verbose=wsl(&["--list","--verbose"],30)?;
    let names=wsl(&["--list","--quiet"],30)?;
    let running=wsl(&["--list","--running","--quiet"],30)?;
    let active:Vec<_>=running.lines().map(str::trim).collect();
    let entries:Vec<Value>=names.lines().map(str::trim).filter(|n|!n.is_empty()).map(|name|{
        let line=verbose.lines().find(|l| {let s=l.trim().trim_start_matches('*').trim(); s.strip_prefix(name).is_some_and(|r|r.starts_with(char::is_whitespace))}).unwrap_or("");
        json!({"name":name,"running":active.contains(&name),"default":line.trim().starts_with('*'),"version":line.split_whitespace().last().and_then(|s|s.parse::<u8>().ok()).unwrap_or(2)})
    }).collect();
    Ok(json!(entries))
}
fn online_distros() -> Result<Value> {
    let output=wsl(&["--list","--online"],120)?;
    let entries:Vec<Value>=output.lines().filter_map(|line|{
        let line=line.trim();
        if line.is_empty()||line.to_ascii_uppercase().starts_with("NAME "){return None}
        let mut parts=line.splitn(2,char::is_whitespace);
        let name=parts.next()?.trim();
        let friendly=parts.next().unwrap_or(name).trim();
        if name.is_empty(){None}else{Some(json!({"name":name,"friendlyName":friendly}))}
    }).collect();
    if entries.is_empty(){return Err("没有读取到在线发行版列表，请更新 WSL 或检查网络连接".into())}
    Ok(json!(entries))
}
fn debian_releases() -> Value {
    json!([
        {"id":"debian-13","name":"Debian 13","codename":"Trixie","archive":"debian-13-azure-amd64-daily.tar.xz","base":"https://cloudfront.debian.net/cdimage/cloud/trixie/daily/latest/"},
        {"id":"debian-12","name":"Debian 12","codename":"Bookworm","archive":"debian-12-azure-amd64-daily.tar.xz","base":"https://cloudfront.debian.net/cdimage/cloud/bookworm/daily/latest/"}
    ])
}
fn download_https(url:&str,path:&std::path::Path,timeout:u64)->Result<()> {
    let _=fs::remove_file(path);
    let quote=|s:&str|format!("'{}'",s.replace(char::from(39),"''"));
    let script=format!("$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop'; Invoke-WebRequest -UseBasicParsing -Uri {} -OutFile {}",quote(url),quote(&path.to_string_lossy()));
    let encoded=base64::engine::general_purpose::STANDARD.encode(script.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>());
    execute("powershell.exe",&["-NoProfile".into(),"-NonInteractive".into(),"-ExecutionPolicy".into(),"Bypass".into(),"-EncodedCommand".into(),encoded],timeout).map(|_|())
}
fn checksum_from_manifest(manifest:&str,filename:&str)->Result<String>{
    manifest.lines().find_map(|line|{
        let mut parts=line.split_whitespace();let hash=parts.next()?;let file=parts.next()?.trim_start_matches('*');
        (file==filename&&hash.len()==128&&hash.bytes().all(|b|b.is_ascii_hexdigit())).then(||hash.to_ascii_lowercase())
    }).ok_or_else(||"Debian 官方校验清单中没有对应架构的压缩包".into())
}
fn install_debian_release(app:&tauri::AppHandle,p:&Value)->Result<Value>{
    let id=text(p,"release")?;
    let release=debian_releases().as_array().unwrap().iter().find(|r|r["id"]==id).ok_or("不支持的 Debian 版本")?.clone();
    let name=text(p,"name")?;
    if name.starts_with('-')||name.chars().any(|c|!(c.is_alphanumeric()||"_.-".contains(c))){return Err("发行版名称无效".into())}
    if list()?.as_array().unwrap().iter().any(|d|d["name"]==name){return Err("该发行版名称已存在".into())}
    let root=app.path().app_data_dir().map_err(|e|e.to_string())?.join("downloads");
    fs::create_dir_all(&root).map_err(|e|e.to_string())?;
    let archive=root.join(release["archive"].as_str().unwrap());
    let sums=root.join(format!("{}.sha512sums",id));
    let base=release["base"].as_str().unwrap();
    let result=(||->Result<Value>{
        download_https(&format!("{base}SHA512SUMS"),&sums,180)?;
        let sums_text=fs::read_to_string(&sums).map_err(|e|format!("读取 Debian 校验清单失败：{e}"))?;
        let expected=checksum_from_manifest(&sums_text,release["archive"].as_str().unwrap())?;
        download_https(&format!("{base}{}",release["archive"].as_str().unwrap()),&archive,3600)?;
        let mut file=fs::File::open(&archive).map_err(|e|e.to_string())?;let mut digest=Sha512::new();let mut buffer=[0u8;1024*1024];
        loop{let n=file.read(&mut buffer).map_err(|e|e.to_string())?;if n==0{break}digest.update(&buffer[..n]);}
        let actual=format!("{:x}",digest.finalize());if actual!=expected{return Err("Debian 下载文件的 SHA-512 校验失败，已取消安装".into())}
        let location=if let Some(path)=p["location"].as_str().filter(|s|!s.trim().is_empty()){absolute_windows(path.trim())?}else{app.path().app_data_dir().map_err(|e|e.to_string())?.join("distros").join(name)};
        if location.exists()&&(!location.is_dir()||location.read_dir().map_err(|e|e.to_string())?.next().is_some()){return Err("安装目录必须不存在或为空".into())}
        fs::create_dir_all(&location).map_err(|e|format!("无法创建安装目录：{e}"))?;
        let archive=archive.to_string_lossy().into_owned();let location=location.to_string_lossy().into_owned();
        let output=wsl(&["--import",name,&location,&archive,"--version","2"],3600)?;
        Ok(json!({"output":output,"name":name,"release":release["name"],"installLocation":location}))
    })();
    let _=fs::remove_file(&archive);let _=fs::remove_file(&sums);result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn debian_release_catalog_has_selectable_supported_versions(){
        let rows=debian_releases();
        assert_eq!(rows.as_array().unwrap().len(),2);
        assert_eq!(rows[0]["id"],"debian-13");
        assert_eq!(rows[0]["codename"],"Trixie");
    }
    #[test]
    fn checksum_manifest_requires_exact_file_and_sha512(){
        let digest="a".repeat(128);
        assert_eq!(checksum_from_manifest(&format!("{digest}  debian.tar.xz\n"),"debian.tar.xz").unwrap(),digest);
        assert!(checksum_from_manifest(&format!("{}  other.tar.xz\n", "a".repeat(128)),"debian.tar.xz").is_err());
        assert!(checksum_from_manifest("deadbeef  debian.tar.xz", "debian.tar.xz").is_err());
    }
}
fn validate_distro(distro:&str, running:bool) -> Result<()> {
    let rows=list()?;
    let d=rows.as_array().unwrap().iter().find(|d|d["name"]==distro).ok_or("发行版不存在，请刷新列表")?;
    if running && d["running"] != true {return Err("发行版已停止，请先启动".into())}
    Ok(())
}

struct Agent {child:Child,input:ChildStdin,output:mpsc::Receiver<String>,sequence:u64}
impl Agent {
    fn new(distro:&str,root:bool)->Result<Self>{
        let mut c=command("wsl.exe"); c.args(["-d",distro]); if root {c.args(["-u","root"]);}
        c.args(["--exec","python3","-u","-c",AGENT]);
        let mut child=c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e|e.to_string())?;
        let input=child.stdin.take().unwrap(); let output=child.stdout.take().unwrap(); let error=child.stderr.take().unwrap();
        let (tx,rx)=mpsc::channel();
        thread::spawn(move ||{for line in BufReader::new(output).lines(){match line{Ok(l)=>if tx.send(l).is_err(){break},Err(_)=>break}}});
        thread::spawn(move || {let _=std::io::copy(&mut BufReader::new(error),&mut std::io::sink());});
        Ok(Self{child,input,output:rx,sequence:0})
    }
    fn ask(&mut self,method:&str,params:Value,timeout:u64)->Result<Value>{
        if self.child.try_wait().map_err(|e|e.to_string())?.is_some(){return Err("Linux 助手已退出，请确认已安装 Python 3，返回概览重试".into())}
        self.sequence+=1;
        writeln!(self.input,"{}",json!({"id":self.sequence,"method":method,"params":params})).map_err(|e|e.to_string())?;
        self.input.flush().map_err(|e|e.to_string())?;
        let deadline=Instant::now()+Duration::from_secs(timeout);
        loop {
            let line=self.output.recv_timeout(deadline.saturating_duration_since(Instant::now())).map_err(|_|{let _=self.child.kill(); "Linux 助手超时或退出；请检查 Python 3 和 WSL 状态".to_string()})?;
            let v:Value=serde_json::from_str(&line).map_err(|e|format!("助手协议错误: {e}"))?;
            if v["id"]!=self.sequence {continue;}
            if let Some(e)=v["error"].as_str(){return Err(e.to_string())}
            return Ok(v["result"].clone())
        }
    }
}
impl Drop for Agent {fn drop(&mut self){let _=self.child.kill(); let _=self.child.wait();}}
struct TerminalSession {master:Box<dyn MasterPty+Send>,writer:Box<dyn Write+Send>,child:Box<dyn portable_pty::Child+Send+Sync>,distro:String}
impl Drop for TerminalSession {fn drop(&mut self){let _=self.child.kill();}}
#[derive(Default)]
struct State {agents:Mutex<HashMap<String,Arc<Mutex<Agent>>>>,terminals:Mutex<HashMap<String,TerminalSession>>}
fn close_distro(state:&State,distro:&str){
    state.agents.lock().unwrap().remove(distro);
    state.terminals.lock().unwrap().retain(|_,t|t.distro!=distro);
}
fn agent_rpc(state:&State,distro:&str,method:&str,params:Value)->Result<Value>{
    let agent={
        let mut map=state.agents.lock().unwrap();
        if !map.contains_key(distro){validate_distro(distro,true)?; map.insert(distro.to_string(),Arc::new(Mutex::new(Agent::new(distro,false)?)));}
        map[distro].clone()
    };
    let result=agent.lock().unwrap().ask(method,params,120);
    if result.is_err(){let dead=agent.lock().unwrap().child.try_wait().ok().flatten().is_some();if dead {state.agents.lock().unwrap().remove(distro);}}
    result
}
fn managed_rpc(app:&tauri::AppHandle,state:&State,distro:&str,method:&str,params:Value)->Result<Value>{
    if let Some(value)=app.state::<desktop::DesktopState>().try_rpc(distro,method,&params)?{Ok(value)}else{agent_rpc(state,distro,method,params)}
}
fn text<'a>(v:&'a Value,key:&str)->Result<&'a str>{v[key].as_str().filter(|s|!s.contains('\0')).ok_or_else(||format!("缺少参数 {key}"))}
fn confirmed(p:&Value)->Result<()> {if p["confirmed"]!=true{Err("请先确认此操作".into())}else{Ok(())}}
fn absolute_windows(p:&str)->Result<PathBuf>{let path=PathBuf::from(p);if !path.is_absolute(){Err("请输入完整 Windows 路径".into())}else{Ok(path)}}
fn timestamp()->u128{SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()}
fn config_path()->Result<PathBuf>{Ok(PathBuf::from(std::env::var("USERPROFILE").map_err(|e|e.to_string())?).join(".wslconfig"))}

fn handle(app:&tauri::AppHandle,method:&str,distro:&str,p:Value)->Result<Value>{
    let state=app.state::<State>();
    match method {
        "distro.list"=>list(),
        "host.info"=>{let version=wsl(&["--version"],30).unwrap_or_else(|e|e);let status=wsl(&["--status"],30).unwrap_or_else(|e|e);
            let default_version=status.lines().find(|line|line.to_ascii_lowercase().contains("default version")).and_then(|line|line.split(':').last()).and_then(|v|v.trim().parse::<u8>().ok()).filter(|v|[1,2].contains(v));
            Ok(json!({"version":version,"status":status,"defaultVersion":default_version}))},
        "host.online"=>online_distros(),
        "host.debian-releases"=>Ok(debian_releases()),
        "host.update"=>{confirmed(&p)?;let mut args=vec!["--update"];if p["webDownload"]==true{args.push("--web-download")}if p["preRelease"]==true{args.push("--pre-release")}
            Ok(json!({"output":wsl(&args,3600)?}))},
        "host.set-default-version"=>{confirmed(&p)?;let version=p["version"].as_u64().filter(|v|[1,2].contains(v)).ok_or("默认 WSL 版本只能是 1 或 2")?.to_string();
            Ok(json!({"output":wsl(&["--set-default-version",&version],1800)?}))},
        "distro.install"=>{confirmed(&p)?;let name=text(&p,"name")?;
            if name.starts_with('-')||name.chars().any(|c|!(c.is_alphanumeric()||"_.-".contains(c))){return Err("发行版名称无效".into())}
            if list()?.as_array().unwrap().iter().any(|d|d["name"]==name){return Err("该发行版已经安装".into())}
            if !online_distros()?.as_array().unwrap().iter().any(|d|d["name"]==name){return Err("该发行版不在 WSL 在线目录中，请刷新列表".into())}
            let mut args=vec!["--install","--distribution",name,"--no-launch"];
            if p["webDownload"]==true{args.push("--web-download")}
            let location=p["location"].as_str().filter(|s|!s.trim().is_empty()).map(|s|absolute_windows(s.trim())).transpose()?;
            if let Some(path)=&location{
                if path.exists()&&(!path.is_dir()||path.read_dir().map_err(|e|e.to_string())?.next().is_some()){return Err("安装目录必须不存在或为空".into())}
                fs::create_dir_all(path).map_err(|e|format!("无法创建安装目录：{e}"))?;
                args.extend(["--location",path.to_str().ok_or("安装路径无效")?]);
            }
            Ok(json!({"output":wsl(&args,3600)?}))},
        "distro.install-debian-release"=>{confirmed(&p)?;install_debian_release(app,&p)},
        "distro.set-version"=>{confirmed(&p)?;validate_distro(distro,false)?;let version=p["version"].as_u64().filter(|v|[1,2].contains(v)).ok_or("WSL 发行版版本只能是 1 或 2")?.to_string();
            Ok(json!({"output":wsl(&["--set-version",distro,&version],3600)?}))},
        "distro.start"=>{validate_distro(distro,false)?; wsl(&["-d",distro,"--exec","true"],120)?; let result=agent_rpc(&state,distro,"system.info",json!({})); Ok(json!({"started":true,"helper":result.ok()}))},
        "distro.stop"|"distro.restart"=>{confirmed(&p)?; validate_distro(distro,false)?;close_distro(&state,distro);app.state::<browser::BrowserState>().close_distro(distro);app.state::<desktop::DesktopState>().close(distro);wsl(&["--terminate",distro],90)?;
            if method=="distro.restart"{wsl(&["-d",distro,"--exec","true"],120)?;let _=agent_rpc(&state,distro,"system.info",json!({}));} Ok(json!({"ok":true}))},
        "distro.default"=>{validate_distro(distro,false)?;wsl(&["--set-default",distro],30)?;Ok(json!({"ok":true}))},
        "distro.delete"=>{confirmed(&p)?;if text(&p,"name")?!=distro{return Err("输入的发行版名称不匹配".into())}validate_distro(distro,false)?;close_distro(&state,distro);app.state::<browser::BrowserState>().close_distro(distro);app.state::<desktop::DesktopState>().close(distro);wsl(&["--unregister",distro],120)?;Ok(json!({"ok":true}))},
        "distro.export"=>{validate_distro(distro,false)?;let target=absolute_windows(text(&p,"path")?)?;if target.exists(){return Err("导出目标已存在，请换一个文件名".into())}let path=target.to_string_lossy();let mut args=vec!["--export",distro,&path];if path.to_lowercase().ends_with(".vhdx"){args.push("--vhd")};Ok(json!({"output":wsl(&args,3600)?}))},
        "distro.import"=>{let name=text(&p,"name")?;if name.is_empty()||name.starts_with('-')||name.chars().any(|c|!(c.is_alphanumeric()||"_.-".contains(c))){return Err("名称只能包含字母、数字、点、横线和下划线".into())}
            let file=absolute_windows(text(&p,"path")?)?;if !file.is_file(){return Err("导入文件不存在".into())}let location=absolute_windows(text(&p,"location")?)?;
            if location.exists()&&location.read_dir().map_err(|e|e.to_string())?.next().is_some(){return Err("安装目录必须为空".into())}
            let file=file.to_string_lossy();let location=location.to_string_lossy();let mut args=vec!["--import",name,&location,&file,"--version","2"];if file.to_lowercase().ends_with(".vhdx"){args.push("--vhd")};Ok(json!({"output":wsl(&args,3600)?}))},
        "host.shutdown"=>{confirmed(&p)?;state.agents.lock().unwrap().clear();state.terminals.lock().unwrap().clear();app.state::<browser::BrowserState>().close_all();app.state::<desktop::DesktopState>().close_all();wsl(&["--shutdown"],90)?;Ok(json!({"ok":true}))},
        "config.read"=>{let path=config_path()?;let value=if path.exists(){fs::read_to_string(&path).map_err(|e|e.to_string())?}else{String::new()};Ok(json!({"content":value,"path":path}))},
        "config.write"=>{confirmed(&p)?;let path=config_path()?;let current=if path.exists(){fs::read_to_string(&path).map_err(|e|e.to_string())?}else{String::new()};if current!=text(&p,"original")?{return Err(".wslconfig 已被其他程序修改，请重新载入".into())}
            let content=text(&p,"content")?;if content.len()>65536{return Err("配置过大".into())}let backup=path.with_extension(format!("wslconfig-backup-{}-{}",std::process::id(),timestamp()));if path.exists(){
                let mut saved=fs::OpenOptions::new().write(true).create_new(true).open(&backup).map_err(|e|e.to_string())?;
                let mut source=fs::File::open(&path).map_err(|e|e.to_string())?;std::io::copy(&mut source,&mut saved).map_err(|e|e.to_string())?;saved.sync_all().map_err(|e|e.to_string())?;
            }
            let tmp=path.with_extension("wsl-manager.tmp");let mut f=fs::File::create(&tmp).map_err(|e|e.to_string())?;f.write_all(content.as_bytes()).map_err(|e|e.to_string())?;f.sync_all().map_err(|e|e.to_string())?;drop(f);fs::rename(tmp,&path).map_err(|e|e.to_string())?;
            Ok(json!({"backup":backup,"message":"已保存；完全关闭 WSL 后重新启动才会生效"}))},
        "explorer"=>{validate_distro(distro,true)?;let path=text(&p,"path")?;if !path.starts_with('/')||path.contains('\\')||path.split('/').any(|s|s==".."){return Err("无效 Linux 路径".into())}
            command("explorer.exe").arg(format!("\\\\wsl.localhost\\{}{}",distro,path.replace('/',"\\"))).spawn().map_err(|e|e.to_string())?;Ok(json!({"ok":true}))},
        "network.open"=>{let port=p["port"].as_u64().filter(|p|*p>0&&*p<=65535).ok_or("端口无效")?;
            command("rundll32.exe").args(["url.dll,FileProtocolHandler",&format!("http://localhost:{port}")]).spawn().map_err(|e|e.to_string())?;Ok(json!({"ok":true}))},
        "fs.download"=>{let result=managed_rpc(app,&state,distro,"fs.read",json!({"path":text(&p,"path")?,"binary":true}))?;let dest=absolute_windows(text(&p,"destination")?)?;
            let bytes=base64::engine::general_purpose::STANDARD.decode(text(&result,"data")?).map_err(|e|e.to_string())?;
            let name=dest.file_name().ok_or("请选择完整文件名")?.to_string_lossy();let temp=dest.with_file_name(format!(".{name}.wsl-manager-{}-{}.tmp",std::process::id(),timestamp()));
            let result=(||->Result<()>{let mut f=fs::OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|e|e.to_string())?;
                f.write_all(&bytes).map_err(|e|e.to_string())?;f.sync_all().map_err(|e|e.to_string())?;drop(f);fs::rename(&temp,&dest).map_err(|e|e.to_string())?;Ok(())})();
            if result.is_err(){let _=fs::remove_file(&temp);}result?;Ok(json!({"ok":true}))},
        "fs.upload"=>{let src=absolute_windows(text(&p,"source")?)?;if fs::metadata(&src).map_err(|e|e.to_string())?.len()>64*1024*1024{return Err("文件超过 64 MB，请使用资源管理器".into())}
            let data=base64::engine::general_purpose::STANDARD.encode(fs::read(src).map_err(|e|e.to_string())?);managed_rpc(app,&state,distro,"fs.write",json!({"path":text(&p,"path")?,"data":data}))},
        "package.action"|"service.action"=>{confirmed(&p)?;validate_distro(distro,true)?;if let Some(value)=app.state::<desktop::DesktopState>().root_rpc(distro,method,&p)?{Ok(value)}else{Agent::new(distro,true)?.ask(method,p,1250)}},
        "process.signal"|"fs.delete"=>{confirmed(&p)?;managed_rpc(app,&state,distro,method,p)},
        "system.info"|"metrics"|"process.list"|"package.list"|"service.list"|"service.logs"|"network"|"fs.list"|"fs.read"|"fs.write"|"fs.mkdir"|"fs.move"|"fs.copy"|"fs.chmod"=>managed_rpc(app,&state,distro,method,p),
        _=>Err(format!("未知操作: {method}"))
    }
}

#[tauri::command]
async fn rpc(app:tauri::AppHandle,method:String,distro:Option<String>,params:Option<Value>)->Result<Value>{
    tauri::async_runtime::spawn_blocking(move ||{
        let d=distro.unwrap_or_default();let p=params.unwrap_or(json!({}));let result=handle(&app,&method,&d,p);
        if [".start",".stop",".restart",".delete",".write",".move",".mkdir",".action",".import",".export",".signal",".shutdown",".upload",".download",".default",".install",".set-version",".update",".set-default-version"].iter().any(|s|method.ends_with(s)) {
            if let Ok(dir)=app.path().app_data_dir(){let _=fs::create_dir_all(&dir);if let Ok(mut f)=fs::OpenOptions::new().create(true).append(true).open(dir.join("operations.jsonl")){let _=writeln!(f,"{}",json!({"time":timestamp(),"distro":d,"method":method,"success":result.is_ok(),"error":result.as_ref().err()}));}}
        }
        result
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
async fn terminal_create(app:tauri::AppHandle,distro:String,id:String,cols:u16,rows:u16,cwd:Option<String>,user:Option<String>)->Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_distro(&distro,true)?;
        if let Some(ref user)=user{app.state::<desktop::DesktopState>().proxy_port(&distro,user)?;}
        let pair=native_pty_system().openpty(PtySize{rows:rows.clamp(2,200),cols:cols.clamp(10,400),pixel_width:0,pixel_height:0}).map_err(|e|e.to_string())?;
        let mut cmd=CommandBuilder::new("wsl.exe");cmd.args(["-d",&distro]);if let Some(ref user)=user{cmd.args(["-u",user]);}cmd.arg("--cd");cmd.arg(cwd.as_deref().filter(|p|p.starts_with('/')).unwrap_or("~"));
        let child=pair.slave.spawn_command(cmd).map_err(|e|e.to_string())?;drop(pair.slave);
        let mut reader=pair.master.try_clone_reader().map_err(|e|e.to_string())?;let writer=pair.master.take_writer().map_err(|e|e.to_string())?;
        let state=app.state::<State>();let mut map=state.terminals.lock().unwrap();if map.len()>=12{return Err("最多同时打开 12 个终端".into())}if map.contains_key(&id){return Err("终端 ID 已存在".into())}
        map.insert(id.clone(),TerminalSession{master:pair.master,writer,child,distro});drop(map);
        thread::spawn(move ||{let mut buffer=[0u8;8192];loop {match reader.read(&mut buffer){Ok(0)|Err(_)=>break,Ok(n)=>{let data=base64::engine::general_purpose::STANDARD.encode(&buffer[..n]);let _=app.emit("terminal-output",json!({"id":id,"data":data}));}}}let _=app.emit("terminal-exit",json!({"id":id}));app.state::<State>().terminals.lock().unwrap().remove(&id);});
        Ok(())
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
fn terminal_input(state:tauri::State<State>,id:String,data:String)->Result<()> {let mut map=state.terminals.lock().unwrap();let t=map.get_mut(&id).ok_or("终端已关闭")?;t.writer.write_all(data.as_bytes()).map_err(|e|e.to_string())?;t.writer.flush().map_err(|e|e.to_string())}
#[tauri::command]
fn terminal_resize(state:tauri::State<State>,id:String,cols:u16,rows:u16)->Result<()> {let map=state.terminals.lock().unwrap();let t=map.get(&id).ok_or("终端已关闭")?;t.master.resize(PtySize{rows:rows.clamp(2,200),cols:cols.clamp(10,400),pixel_width:0,pixel_height:0}).map_err(|e|e.to_string())}
#[tauri::command]
fn terminal_close(state:tauri::State<State>,id:String){state.terminals.lock().unwrap().remove(&id);}

fn main(){
    let args:Vec<String>=std::env::args().collect();
    let browser_test=args.iter().position(|a|a=="--browser-smoke").map(|pos|(args.get(pos+1).cloned().unwrap_or_default(),args.get(pos+2).cloned().unwrap_or("Ubuntu".into())));
    if let Some(pos)=args.iter().position(|a|a=="--desktop-smoke"){
        let result=desktop::smoke(args.get(pos+2).map(String::as_str).unwrap_or("Ubuntu"));
        let report=match &result{Ok(v)=>v.clone(),Err(e)=>json!({"error":e})};
        if let Some(path)=args.get(pos+1){let _=fs::write(path,serde_json::to_vec_pretty(&report).unwrap());}
        std::process::exit(if result.is_ok(){0}else{1});
    }
    if let Some(pos)=args.iter().position(|a|a=="--smoke-test"){
        let result=smoke::run_checks(args.get(pos+2).map(String::as_str).unwrap_or("Ubuntu-24.04"));
        let report=match &result{Ok(v)=>v.clone(),Err(e)=>json!({"error":e})};
        if let Some(path)=args.get(pos+1){let _=fs::write(path,serde_json::to_vec_pretty(&report).unwrap());}
        std::process::exit(if result.is_ok(){0}else{1});
    }
    if std::env::args().any(|a|a=="--self-check"){assert_eq!(decode(&[65,0,66,0,67,0,68,0,69,0,70,0]),"ABCDEF");assert!(absolute_windows("relative").is_err());println!("host self-check passed");return;}
    tauri::Builder::default().plugin(tauri_plugin_dialog::init()).manage(State::default()).manage(desktop::DesktopState::default()).manage(browser::BrowserState::default())
        .invoke_handler(tauri::generate_handler![rpc,desktop::desktop_rpc,browser::browser_open,browser::browser_rpc,terminal_create,terminal_input,terminal_resize,terminal_close])
        .setup(move |app|{if let Some((path,distro))=browser_test.clone(){let handle=app.handle().clone();tauri::async_runtime::spawn(async move{let result=browser::smoke(handle.clone(),distro).await;let report=match &result{Ok(v)=>v.clone(),Err(e)=>json!({"error":e})};let _=fs::write(path,serde_json::to_vec_pretty(&report).unwrap());handle.exit(if result.is_ok(){0}else{1});});}Ok(())})
        .on_window_event(|window,event|{if window.label()=="main" && matches!(event,tauri::WindowEvent::Destroyed){let state=window.state::<State>();state.terminals.lock().unwrap().clear();state.agents.lock().unwrap().clear();window.state::<browser::BrowserState>().close_all();window.state::<desktop::DesktopState>().close_all();}})
        .run(tauri::generate_context!()).expect("Unable to launch WSL Manager");
}
