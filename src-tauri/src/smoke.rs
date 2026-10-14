use super::*;

pub fn run_checks(distro:&str)->Result<Value>{
    let mut passed=Vec::new();
    let inventory=list()?;
    if !inventory.as_array().unwrap().iter().any(|d|d["name"]==distro){return Err("Test distribution missing".into())}
    passed.push("Windows WSL enumeration / UTF-16 decoding");
    let online=online_distros()?;
    if online.as_array().unwrap().is_empty(){return Err("Online distribution catalog is empty".into())}
    passed.push("Live WSL status / online distribution catalog");
    validate_distro(distro,true)?;
    let mut agent=Agent::new(distro,false)?;
    let info=agent.ask("system.info",json!({}),30)?;
    if info["user"]=="root"{return Err("Default user unexpectedly root".into())}
    passed.push("Persistent helper stdio / default Linux user");
    agent.ask("metrics",json!({}),30)?;thread::sleep(Duration::from_millis(250));
    let m=agent.ask("metrics",json!({}),30)?;
    if m["cpu"].as_f64().is_none()||m["memory"]["total"].as_u64().unwrap_or(0)==0{return Err("Metrics unavailable".into())}
    passed.push("Live /proc metrics over Windows IPC transport");
    let path=format!("/tmp/wsl-manager-host-check-{}-中文.txt",timestamp());
    let file=agent.ask("fs.write",json!({"path":path,"content":"hello 中文\n"}),30)?;
    let read=agent.ask("fs.read",json!({"path":path}),30)?;
    if read["content"]!="hello 中文\n"{return Err("UTF-8 roundtrip failed".into())}
    if agent.ask("fs.write",json!({"path":path,"content":"clobber","version":"stale"}),30).is_ok(){return Err("Conflict check failed".into())}
    agent.ask("fs.write",json!({"path":path,"content":"saved","version":file["version"]}),30)?;
    agent.ask("fs.delete",json!({"path":path}),30)?;
    passed.push("Windows to Linux UTF-8 files / conflict protection / cleanup");
    for method in ["process.list","package.list","service.list","network"]{agent.ask(method,json!({}),90)?;}
    passed.push("Processes, installed packages, services, network through persistent helper");
    let mut root=Agent::new(distro,true)?;
    let root_info=root.ask("system.info",json!({}),30)?;
    if root_info["user"]!="root"{return Err("Root helper is not root".into())}
    if root.ask("package.action",json!({"action":"install","name":"bash;touch /tmp/INJECTION"}),30).is_ok(){return Err("Package validation failed".into())}
    passed.push("Isolated Root helper / package command injection rejected");
    let pair=native_pty_system().openpty(PtySize{rows:30,cols:100,pixel_width:0,pixel_height:0}).map_err(|e|e.to_string())?;
    let mut command=CommandBuilder::new("wsl.exe");command.args(["-d",distro,"--exec","sh","-c","stty size; printf 'PTY_READY 中文\\n'; read answer; printf 'ECHO:%s\\n' \"$answer\""]);
    let mut child=pair.slave.spawn_command(command).map_err(|e|e.to_string())?;drop(pair.slave);
    let mut reader=pair.master.try_clone_reader().map_err(|e|e.to_string())?;let mut writer=pair.master.take_writer().map_err(|e|e.to_string())?;
    let (tx,rx)=mpsc::channel();thread::spawn(move ||{let mut bytes=[0u8;4096];loop{match reader.read(&mut bytes){Ok(0)|Err(_)=>break,Ok(n)=>{if tx.send(bytes[..n].to_vec()).is_err(){break}}}}});
    let deadline=Instant::now()+Duration::from_secs(25);let mut output=Vec::new();let mut sent=false;
    loop{if Instant::now()>deadline{let _=child.kill();return Err(format!("ConPTY timeout: {}",String::from_utf8_lossy(&output)))}
        let chunk=rx.recv_timeout(Duration::from_secs(2));if let Ok(bytes)=chunk{output.extend(bytes);}
        let text=String::from_utf8_lossy(&output);
        // ConPTY may ask for the initial cursor position.
        if text.contains("\u{1b}[6n"){let _=writer.write_all(b"\x1b[1;1R");}
        if text.contains("PTY_READY")&&!sent{pair.master.resize(PtySize{rows:35,cols:110,pixel_width:0,pixel_height:0}).map_err(|e|e.to_string())?;writer.write_all(b"roundtrip\r").map_err(|e|e.to_string())?;writer.flush().map_err(|e|e.to_string())?;sent=true;}
        if text.contains("ECHO:roundtrip"){break;}
    }
    let _=child.kill();
    passed.push("Real Windows ConPTY / interactive input / UTF-8 output / resize");
    Ok(json!({"passed":passed.len(),"checks":passed,"distro":distro,"system":info,"terminalOutput":String::from_utf8_lossy(&output)}))
}
