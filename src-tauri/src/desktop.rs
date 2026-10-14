use crate::{command, decode, execute, validate_distro, wsl, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, io::{BufRead, BufReader, Read, Write}, net::{SocketAddr, TcpStream}, process::{Child, ChildStdin, Stdio}, sync::{mpsc, Mutex}, thread, time::Duration};
use tauri::{AppHandle, Manager};

const AGENT_AMD64: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/linuxdesk-agent-amd64"));
const AGENT_ARM64: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/linuxdesk-agent-arm64"));
const AGENT_VERSION:&str="0.2.0";
const AGENT_PATH: &str = "$HOME/.local/bin/linuxdesk-agent";

struct GoAgent {
    child: Child,
    _input: ChildStdin,
    port: u16,
    proxy_port: u16,
    token: String,
    user: String,
    home:String,
}
impl Drop for GoAgent { fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); } }

#[derive(Default)]
pub struct DesktopState { agents: Mutex<HashMap<String, GoAgent>> }
impl DesktopState {
    pub fn close(&self, distro: &str) { self.agents.lock().unwrap().remove(distro); }
    pub fn close_all(&self) { self.agents.lock().unwrap().clear(); }
    pub fn proxy_port(&self, distro:&str, user:&str)->Result<u16>{
        let mut agents=self.agents.lock().unwrap();
        let agent=agents.get_mut(distro).ok_or("请先连接该发行版的桌面 Agent")?;
        if agent.user!=user || agent.child.try_wait().map_err(|e|e.to_string())?.is_some(){return Err("Agent 会话已断开，请重新连接桌面".into())}
        probe(agent.port,&agent.token)?;
        Ok(agent.proxy_port)
    }
    pub fn try_rpc(&self,distro:&str,method:&str,params:&Value)->Result<Option<Value>>{
        let agents=self.agents.lock().unwrap();
        let agent=match agents.get(distro){Some(a)=>a,None=>return Ok(None)};
        let body=serde_json::to_vec(&json!({"method":method,"params":params})).map_err(|e|e.to_string())?;
        let address=SocketAddr::from(([127,0,0,1],agent.port));
        let mut stream=TcpStream::connect_timeout(&address,Duration::from_secs(3)).map_err(|e|format!("Go Agent 连接失败：{e}"))?;
        stream.set_read_timeout(Some(Duration::from_secs(120))).map_err(|e|e.to_string())?;
        write!(stream,"POST /v1/rpc HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",agent.port,agent.token,body.len()).map_err(|e|e.to_string())?;
        stream.write_all(&body).map_err(|e|e.to_string())?;
        let mut response=Vec::new();stream.read_to_end(&mut response).map_err(|e|e.to_string())?;
        let text=String::from_utf8(response).map_err(|e|e.to_string())?;
        let (headers,body)=text.split_once("\r\n\r\n").ok_or("Go Agent HTTP 响应无效")?;
        if !headers.starts_with("HTTP/1.1 200"){return Err(format!("Go Agent 拒绝请求：{}",headers.lines().next().unwrap_or("HTTP 错误")))}
        let answer:Value=serde_json::from_str(body).map_err(|e|format!("Go Agent 协议错误：{e}"))?;
        if let Some(error)=answer["error"].as_str(){return Err(error.into())}
        Ok(Some(answer["result"].clone()))
    }
    pub fn root_rpc(&self,distro:&str,method:&str,params:&Value)->Result<Option<Value>>{
        if !["package.action","service.action"].contains(&method){return Err("禁止未授权的 root 操作".into())}
        let home={let agents=self.agents.lock().unwrap();match agents.get(distro){Some(a)=>a.home.clone(),None=>return Ok(None)}};
        if !home.starts_with('/')||home.contains('\0'){return Err("Agent home 路径无效".into())}
        let path=format!("{home}/.local/bin/linuxdesk-agent");
        let body=serde_json::to_vec(&json!({"method":method,"params":params})).map_err(|e|e.to_string())?;
        let mut child=command("wsl.exe").args(["-d",distro,"-u","root","--exec",&path,"--once"])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e|e.to_string())?;
        let mut input=child.stdin.take().ok_or("无法写入 root 操作")?;input.write_all(&body).map_err(|e|e.to_string())?;drop(input);
        let mut out=child.stdout.take().ok_or("root 操作无标准输出")?;let mut err=child.stderr.take().ok_or("root 操作无错误输出")?;
        let reader=thread::spawn(move ||{let mut bytes=Vec::new();let _=out.read_to_end(&mut bytes);bytes});
        let errors=thread::spawn(move ||{let mut bytes=Vec::new();let _=err.read_to_end(&mut bytes);bytes});
        let started=std::time::Instant::now();
        let status=loop{match child.try_wait().map_err(|e|e.to_string())?{
            Some(s)=>break s,None if started.elapsed()>Duration::from_secs(1250)=>{let _=child.kill();let _=child.wait();return Err("root 操作超时".into())},None=>thread::sleep(Duration::from_millis(100))
        }};
        let output=decode(&reader.join().unwrap_or_default());let error=decode(&errors.join().unwrap_or_default());
        if !status.success(){return Err(error.trim().to_string())}
        let answer:Value=serde_json::from_str(&output).map_err(|e|format!("root Agent 协议错误：{e}"))?;
        Ok(Some(answer["result"].clone()))
    }
}

fn wsl_run(distro: &str, user: Option<&str>, program: &str, args: &[&str], timeout: u64) -> Result<String> {
    let mut values = vec!["-d".to_string(), distro.to_string()];
    if let Some(user) = user { values.extend(["-u".into(), user.into()]); }
    values.extend(["--exec".into(), program.into()]);
    values.extend(args.iter().map(|s| s.to_string()));
    execute("wsl.exe", &values, timeout)
}

fn users(distro: &str) -> Result<Value> {
    validate_distro(distro, false)?;
    let default = wsl_run(distro, None, "id", &["-un"], 30)?.trim().to_string();
    let arch = wsl_run(distro, None, "uname", &["-m"], 30)?.trim().to_string();
    let passwd = wsl_run(distro, None, "cat", &["/etc/passwd"], 30)?;
    let mut rows = Vec::new();
    for line in passwd.lines() {
        let f: Vec<&str> = line.split(':').collect();
        if f.len() < 7 { continue; }
        let uid = f[2].parse::<u32>().unwrap_or(0);
        if (uid >= 1000 || f[0] == default) && !f[6].contains("nologin") && !f[6].ends_with("/false") {
            rows.push(json!({"name":f[0],"uid":uid,"home":f[5],"default":f[0]==default,"root":uid==0}));
        }
    }
    Ok(json!({"default":default,"arch":arch,"users":rows}))
}

fn validate_user(distro: &str, user: &str) -> Result<()> {
    let found = users(distro)?["users"].as_array().unwrap().iter().any(|u|u["name"]==user && u["root"]==false);
    if found { Ok(()) } else { Err("请选择现有的普通 Linux 用户；如只有 root，请先创建用户".into()) }
}

fn binary(distro: &str) -> Result<&'static [u8]> {
    let arch = wsl_run(distro, None, "uname", &["-m"], 30)?;
    match arch.trim() { "x86_64" => Ok(AGENT_AMD64), "aarch64" => Ok(AGENT_ARM64), other => Err(format!("暂不支持 Linux 架构 {other}")) }
}

fn installed(distro: &str, user: &str) -> Result<String> {
    validate_user(distro, user)?;
    let version=wsl_run(distro, Some(user), "sh", &["-c", &format!("test -x {AGENT_PATH} && {AGENT_PATH} --version")], 30)
        .map(|s|s.trim().to_string()).map_err(|_|"此用户尚未安装 Linux 桌面 Agent".to_string())?;
    if version!=AGENT_VERSION{return Err(format!("Agent 版本不匹配：当前 {version}，需要 {AGENT_VERSION}；请更新 Agent"))}
    Ok(version)
}

fn install(distro: &str, user: &str) -> Result<Value> {
    validate_user(distro, user)?;
    let data = binary(distro)?;
    let digest = format!("{:x}", Sha256::digest(data));
    let script = "set -eu; umask 077; test -n \"$HOME\"; mkdir -p \"$HOME/.local/bin\"; tmp=\"$HOME/.local/bin/.linuxdesk-agent.$$\"; dest=\"$HOME/.local/bin/linuxdesk-agent\"; previous=\"$dest.previous\"; trap 'rm -f \"$tmp\"' EXIT; cat > \"$tmp\"; echo \"$1  $tmp\" | sha256sum -c - >/dev/null; chmod 700 \"$tmp\"; if test -e \"$dest\"; then cp -p \"$dest\" \"$previous\"; fi; mv -f \"$tmp\" \"$dest\"; if ! \"$dest\" --version; then if test -e \"$previous\"; then mv -f \"$previous\" \"$dest\"; else rm -f \"$dest\"; fi; exit 1; fi";
    let mut child = command("wsl.exe").args(["-d",distro,"-u",user,"--exec","sh","-c",script,"sh",&digest])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e|e.to_string())?;
    let mut input = child.stdin.take().ok_or("无法向 WSL 写入 Agent")?;
    input.write_all(data).map_err(|e|e.to_string())?;
    drop(input);
    let output = child.wait_with_output().map_err(|e|e.to_string())?;
    if !output.status.success() { return Err(format!("安装失败：{}",decode(&output.stderr).trim())) }
    Ok(json!({"version":decode(&output.stdout).trim(),"user":user,"bytes":data.len()}))
}

fn create_user(distro: &str, name: &str) -> Result<Value> {
    validate_distro(distro,false)?;
    if name.len()<2 || name.len()>32 || !name.bytes().next().unwrap().is_ascii_lowercase()
        || !name.bytes().all(|b|b.is_ascii_lowercase()||b.is_ascii_digit()||b==b'_'||b==b'-') {
        return Err("用户名须以小写字母开头，只能包含小写字母、数字、_、-，长度 2–32".into())
    }
    wsl_run(distro,Some("root"),"useradd", &["-m","-s","/bin/sh",name],60)?;
    Ok(json!({"name":name}))
}

fn probe(port:u16,token:&str)->Result<Value>{
    let address=SocketAddr::from(([127,0,0,1],port));
    let mut stream=TcpStream::connect_timeout(&address,Duration::from_secs(3)).map_err(|e|format!("Windows 无法连接 WSL Agent 的 localhost 端口 {port}：{e}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(4))).map_err(|e|e.to_string())?;
    write!(stream,"GET /v1/meta HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n").map_err(|e|e.to_string())?;
    let mut data=Vec::new();stream.read_to_end(&mut data).map_err(|e|e.to_string())?;
    let text=String::from_utf8(data).map_err(|e|e.to_string())?;
    let (headers,body)=text.split_once("\r\n\r\n").ok_or("Agent HTTP 响应无效")?;
    if !headers.starts_with("HTTP/1.1 200") { return Err(format!("Agent 拒绝连接：{}",headers.lines().next().unwrap_or("HTTP 错误"))) }
    serde_json::from_str(body).map_err(|e|format!("Agent 协议错误：{e}"))
}

fn probe_proxy(proxy_port:u16,control_port:u16,token:&str)->Result<()> {
    let address=SocketAddr::from(([127,0,0,1],proxy_port));
    let mut stream=TcpStream::connect_timeout(&address,Duration::from_secs(3)).map_err(|e|format!("Windows 无法连接 Linux 浏览器代理：{e}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(4))).map_err(|e|e.to_string())?;
    write!(stream,"GET http://127.0.0.1:{control_port}/v1/meta HTTP/1.1\r\nHost: 127.0.0.1:{control_port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n").map_err(|e|e.to_string())?;
    let mut response=String::new();stream.read_to_string(&mut response).map_err(|e|e.to_string())?;
    if !response.starts_with("HTTP/1.1 200") {return Err(format!("Linux 代理转发失败：{}",response.lines().next().unwrap_or("无响应")))}
    Ok(())
}

fn connect(distro:&str,user:&str,state:&DesktopState)->Result<Value>{
    validate_user(distro,user)?;
    let mut agents=state.agents.lock().unwrap();
    if let Some(agent)=agents.get_mut(distro){
        if agent.user==user && agent.child.try_wait().map_err(|e|e.to_string())?.is_none(){
            if let Ok(meta)=probe(agent.port,&agent.token){return Ok(json!({"meta":meta,"proxyPort":agent.proxy_port,"user":user}))}
        }
        agents.remove(distro);
    }
    installed(distro,user)?;
    let script="exec \"$HOME/.local/bin/linuxdesk-agent\" --serve";
    let mut child=command("wsl.exe").args(["-d",distro,"-u",user,"--exec","sh","-c",script])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e|e.to_string())?;
    let input=child.stdin.take().ok_or("无法保持 Agent 会话")?;
    let output=child.stdout.take().ok_or("Agent 没有标准输出")?;
    let error=child.stderr.take().ok_or("Agent 没有错误输出")?;
    let (tx,rx)=mpsc::channel();
    thread::spawn(move ||{let mut line=String::new();let result=BufReader::new(output).read_line(&mut line).map(|_|line);let _=tx.send(result);});
    thread::spawn(move ||{let _=std::io::copy(&mut BufReader::new(error),&mut std::io::sink());});
    let line=rx.recv_timeout(Duration::from_secs(20)).map_err(|_|"Agent 启动超时".to_string())?.map_err(|e|e.to_string())?;
    let hello:Value=serde_json::from_str(&line).map_err(|e|format!("Agent 握手失败：{e}"))?;
    if hello["protocol"]!=1 {return Err("Agent 协议版本不兼容，请更新 Agent".into())}
    let port=hello["port"].as_u64().filter(|p|*p>0&&*p<=65535).ok_or("Agent 端口无效")? as u16;
    let proxy_port=hello["proxyPort"].as_u64().filter(|p|*p>0&&*p<=65535).ok_or("Agent 代理端口无效")? as u16;
    let token=hello["token"].as_str().filter(|s|s.len()==64).ok_or("Agent 令牌无效")?.to_string();
    let meta=probe(port,&token)?;
    let home=meta["home"].as_str().filter(|s|s.starts_with('/')&&!s.contains('\0')).ok_or("Agent home 路径无效")?.to_string();
    agents.insert(distro.to_string(),GoAgent{child,_input:input,port,proxy_port,token,user:user.to_string(),home});
    Ok(json!({"meta":meta,"proxyPort":proxy_port,"user":user}))
}

#[tauri::command]
pub async fn desktop_rpc(app:AppHandle,method:String,distro:String,user:Option<String>,name:Option<String>,confirmed:Option<bool>)->Result<Value>{
    tauri::async_runtime::spawn_blocking(move ||{
        match method.as_str(){
            "users"=>users(&distro),
            "installed"=>Ok(json!({"version":installed(&distro,user.as_deref().ok_or("请选择 Linux 用户")?)?})),
            "install"=>{let result=install(&distro,user.as_deref().ok_or("请选择 Linux 用户")?)?;app.state::<crate::browser::BrowserState>().close_distro(&distro);app.state::<DesktopState>().close(&distro);Ok(result)},
            "create-user"=>create_user(&distro,name.as_deref().ok_or("请输入用户名")?),
            "connect"=>connect(&distro,user.as_deref().ok_or("请选择 Linux 用户")?,&app.state::<DesktopState>()),
            "health"=>Ok(json!({"proxyPort":app.state::<DesktopState>().proxy_port(&distro,user.as_deref().ok_or("请选择 Linux 用户")?)?})),
            "disconnect"=>{app.state::<crate::browser::BrowserState>().close_distro(&distro);app.state::<DesktopState>().close(&distro);Ok(json!({"ok":true}))},
            "uninstall"=>{if confirmed!=Some(true){return Err("请先确认卸载 Agent".into())}let user=user.as_deref().ok_or("请选择 Linux 用户")?;validate_user(&distro,user)?;
                app.state::<crate::browser::BrowserState>().close_distro(&distro);app.state::<DesktopState>().close(&distro);
                wsl_run(&distro,Some(user),"sh", &["-c","rm -f \"$HOME/.local/bin/linuxdesk-agent\" \"$HOME/.local/bin/linuxdesk-agent.previous\""],30)?;
                Ok(json!({"ok":true,"message":"Agent 已卸载；用户配置和浏览器数据已保留"}))},
            _=>Err("未知桌面操作".into())
        }
    }).await.map_err(|e|e.to_string())?
}

pub fn smoke(distro:&str)->Result<Value>{
    wsl(&["-d",distro,"--exec","true"],90)?;
    let listing=users(distro)?;
    let user=listing["users"].as_array().and_then(|rows|rows.iter().find(|u|u["root"]==false)).and_then(|u|u["name"].as_str()).ok_or("没有可测试的普通 Linux 用户")?;
    let installed=install(distro,user)?;
    let state=DesktopState::default();
    let connected=connect(distro,user,&state)?;
    let port=state.proxy_port(distro,user)?;
    let mut checked=Vec::new();
    for method in ["system.info","metrics","process.list","package.list","service.list","network"]{
        let value=state.try_rpc(distro,method,&json!({}))?.ok_or("Go Agent RPC 未连接")?;
        if value.is_null(){return Err(format!("Go Agent {method} 返回空数据"))}
        checked.push(method);
    }
    let dir=format!("/tmp/linuxdesk-smoke-{}-{}",std::process::id(),crate::timestamp());
    let first=format!("{dir}/中文-file.txt");let moved=format!("{dir}/moved.txt");let copied=format!("{dir}/copied.txt");
    let file_result=(||->Result<()> {
        state.try_rpc(distro,"fs.mkdir",&json!({"path":dir}))?;
        let created=state.try_rpc(distro,"fs.write",&json!({"path":first,"content":"hello 世界\n"}))?.ok_or("文件写入无结果")?;
        let read=state.try_rpc(distro,"fs.read",&json!({"path":first}))?.ok_or("文件读取无结果")?;
        if read["content"]!="hello 世界\n"||read["version"]!=created["version"]{return Err("Go Agent 文件往返不一致".into())}
        if state.try_rpc(distro,"fs.write",&json!({"path":first,"content":"clobber","version":"wrong"})).is_ok(){return Err("Go Agent 未阻止并发覆盖".into())}
        let updated=state.try_rpc(distro,"fs.write",&json!({"path":first,"content":"updated 世界\n","version":read["version"]}))?.ok_or("文件更新无结果")?;
        if updated["version"]==read["version"]{return Err("文件更新后版本未改变".into())}
        state.try_rpc(distro,"fs.copy",&json!({"path":first,"destination":copied}))?;
        state.try_rpc(distro,"fs.chmod",&json!({"path":copied,"mode":"0600"}))?;
        let listing=state.try_rpc(distro,"fs.list",&json!({"path":dir}))?.ok_or("目录读取无结果")?;
        if !listing["entries"].as_array().unwrap().iter().any(|e|e["name"]=="copied.txt"&&e["mode"]=="-rw-------"){return Err("Go Agent 复制或权限修改失败".into())}
        state.try_rpc(distro,"fs.move",&json!({"path":first,"destination":moved}))?;
        if state.try_rpc(distro,"fs.move",&json!({"path":moved,"destination":dir})).is_ok(){return Err("Go Agent 未阻止覆盖已有目录".into())}
        state.try_rpc(distro,"fs.delete",&json!({"path":moved}))?;
        state.try_rpc(distro,"fs.delete",&json!({"path":copied}))?;
        state.try_rpc(distro,"fs.delete",&json!({"path":dir}))?;
        Ok(())
    })();
    if file_result.is_err(){let _=state.try_rpc(distro,"fs.delete",&json!({"path":first}));let _=state.try_rpc(distro,"fs.delete",&json!({"path":moved}));let _=state.try_rpc(distro,"fs.delete",&json!({"path":copied}));let _=state.try_rpc(distro,"fs.delete",&json!({"path":dir}));}
    file_result?;checked.push("files round-trip/conflict/move/delete");
    if state.try_rpc(distro,"process.signal",&json!({"pid":1,"start":"wrong","signal":"KILL"})).is_ok(){return Err("Go Agent 未阻止结束 init 进程".into())}
    checked.push("process signal guard");
    let root_error=state.root_rpc(distro,"service.action",&json!({"action":"invalid","name":"example.service"})).err().unwrap_or_default();
    if !root_error.contains("无效服务操作"){return Err(format!("root Agent 测试失败：{root_error}"))}
    checked.push("root action validation");
    {
        let agents=state.agents.lock().unwrap();let agent=agents.get(distro).ok_or("Agent 已退出")?;
        probe_proxy(agent.proxy_port,agent.port,&agent.token)?;
    }
    let result=json!({"distro":distro,"user":user,"installed":installed,"meta":connected["meta"],"proxyPort":port,"proxyVerified":true,"rpcChecked":checked});
    state.close_all();
    Ok(result)
}

pub fn connect_for_smoke(distro:&str,state:&DesktopState)->Result<String>{
    wsl(&["-d",distro,"--exec","true"],90)?;
    let listing=users(distro)?;
    let user=listing["users"].as_array().and_then(|rows|rows.iter().find(|u|u["root"]==false)).and_then(|u|u["name"].as_str()).ok_or("没有可测试的普通 Linux 用户")?.to_string();
    installed(distro,&user)?;
    connect(distro,&user,state)?;
    Ok(user)
}
