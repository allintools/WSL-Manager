use crate::{desktop::DesktopState, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs, path::PathBuf, sync::{mpsc,Mutex},time::Duration};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Webview, WebviewUrl, Window, WindowEvent};
use tauri::{webview::{NewWindowResponse, WebviewBuilder}, window::WindowBuilder};

const BAR_HEIGHT:f64=83.0;
struct BrowserTab { id:u32, webview:Webview }
struct BrowserSession { window:Window, tabs:Vec<BrowserTab>, active:u32, next_id:u32, proxy_port:u16, data_dir:PathBuf, user:String, bar_height:f64 }
#[derive(Default)]
pub struct BrowserState { sessions:Mutex<HashMap<String,BrowserSession>> }
impl BrowserState {
    pub fn close_distro(&self,distro:&str){if let Some(session)=self.sessions.lock().unwrap().remove(distro){let _=session.window.close();}}
    pub fn close_all(&self){let sessions=std::mem::take(&mut *self.sessions.lock().unwrap());for (_,s) in sessions{let _=s.window.close();}}
}

fn label(distro:&str)->String{format!("browser-{}",&format!("{:x}",Sha256::digest(distro.as_bytes()))[..16])}
fn page_url(input:&str)->Result<tauri::Url>{
    let input=input.trim();
    let candidate=if input.contains("://") {input.to_string()} else {format!("https://{input}")};
    let url=tauri::Url::parse(&candidate).map_err(|_|"请输入有效网址".to_string())?;
    if !["http","https"].contains(&url.scheme()) || url.host_str().is_none(){return Err("只允许打开 HTTP 或 HTTPS 网页".into())}
    Ok(url)
}
fn add_tab(session:&mut BrowserSession, distro:&str, url:tauri::Url)->Result<u32>{
    let id=session.next_id;session.next_id+=1;
    let page_label=format!("browser-page-{}-{id}",&label(distro)[8..]);
    let proxy=tauri::Url::parse(&format!("http://127.0.0.1:{}",session.proxy_port)).map_err(|e|e.to_string())?;
    let size=session.window.inner_size().map_err(|e|e.to_string())?;
    let scale=session.window.scale_factor().map_err(|e|e.to_string())?;
    let logical=size.to_logical::<f64>(scale);
    let webview=session.window.add_child(
        WebviewBuilder::new(page_label,WebviewUrl::External(url))
            .data_directory(session.data_dir.clone())
            .proxy_url(proxy)
            .on_navigation(|url|["http","https","about"].contains(&url.scheme()))
            .on_new_window(|_,_|NewWindowResponse::Deny),
        LogicalPosition::new(0.0,session.bar_height),LogicalSize::new(logical.width,(logical.height-session.bar_height).max(1.0))
    ).map_err(|e|format!("浏览器页面创建失败：{e}"))?;
    for tab in &session.tabs{let _=tab.webview.hide();}
    session.active=id;
    session.tabs.push(BrowserTab{id,webview});
    Ok(id)
}
fn snapshot(session:&BrowserSession)->Value{
    json!({"active":session.active,"tabs":session.tabs.iter().map(|t|json!({"id":t.id,"url":t.webview.url().map(|u|u.to_string()).unwrap_or_default()})).collect::<Vec<_>>()})
}

#[tauri::command]
pub async fn browser_open(app:AppHandle,distro:String,user:String,url:Option<String>)->Result<Value>{
    let proxy_port=app.state::<DesktopState>().proxy_port(&distro,&user)?;
    let target=page_url(url.as_deref().unwrap_or("https://example.com"))?;
    let browser_state=app.state::<BrowserState>();
    let mut sessions=browser_state.sessions.lock().unwrap();
    if let Some(session)=sessions.get_mut(&distro){
        if session.user!=user||session.proxy_port!=proxy_port{return Err("浏览器使用的 Agent 会话已变化，请关闭浏览器后重试".into())}
        session.window.show().map_err(|e|e.to_string())?;session.window.set_focus().map_err(|e|e.to_string())?;
        return Ok(snapshot(session))
    }
    let window_label=label(&distro);
    let data_dir=app.path().app_data_dir().map_err(|e|e.to_string())?.join("browser").join(&window_label);
    fs::create_dir_all(&data_dir).map_err(|e|e.to_string())?;
    let window=WindowBuilder::new(&app,&window_label).title(format!("Linux 浏览器 · {distro}"))
        .inner_size(1100.0,760.0).min_inner_size(680.0,460.0).build().map_err(|e|e.to_string())?;
    let chrome_label=format!("browser-chrome-{}",&window_label[8..]);
    let mut chrome_url=tauri::Url::parse("http://localhost/index.html").map_err(|e|e.to_string())?;
    chrome_url.query_pairs_mut().append_pair("browser","1").append_pair("distro",&distro);
    window.add_child(WebviewBuilder::new(chrome_label,WebviewUrl::App(format!("index.html?{}",chrome_url.query().unwrap_or("")).into())),
        LogicalPosition::new(0.0,0.0),LogicalSize::new(1100.0,BAR_HEIGHT)).map_err(|e|e.to_string())?;
    let mut session=BrowserSession{window:window.clone(),tabs:Vec::new(),active:0,next_id:1,proxy_port,data_dir,user,bar_height:BAR_HEIGHT};
    if let Err(e)=add_tab(&mut session,&distro,target){let _=window.close();return Err(e)}
    let app_for_event=app.clone();let distro_for_event=distro.clone();let window_for_resize=window.clone();
    window.on_window_event(move |event|match event{
        WindowEvent::Resized(size)=>{
            if let Ok(scale)=window_for_resize.scale_factor(){
                let bar_height=app_for_event.state::<BrowserState>().sessions.lock().unwrap().get(&distro_for_event).map(|s|s.bar_height).unwrap_or(BAR_HEIGHT);
                let bar=(bar_height*scale).round() as u32;
                if let Some(chrome)=app_for_event.get_webview(&format!("browser-chrome-{}",&label(&distro_for_event)[8..])){
                    let _=chrome.set_position(PhysicalPosition::new(0,0));let _=chrome.set_size(PhysicalSize::new(size.width,bar));
                }
                if let Some(session)=app_for_event.state::<BrowserState>().sessions.lock().unwrap().get(&distro_for_event){
                    for tab in &session.tabs{let _=tab.webview.set_position(PhysicalPosition::new(0,bar as i32));let _=tab.webview.set_size(PhysicalSize::new(size.width,size.height.saturating_sub(bar)));}
                }
            }
        },
        WindowEvent::Destroyed=>{app_for_event.state::<BrowserState>().sessions.lock().unwrap().remove(&distro_for_event);},
        _=>()
    });
    let response=snapshot(&session);sessions.insert(distro,session);Ok(response)
}

#[tauri::command]
pub async fn browser_rpc(app:AppHandle,source:Webview,method:String,distro:String,id:Option<u32>,url:Option<String>)->Result<Value>{
    if source.label()!=format!("browser-chrome-{}",&label(&distro)[8..]) {return Err("只有浏览器工具栏可以控制页面".into())}
    let state=app.state::<BrowserState>();let mut sessions=state.sessions.lock().unwrap();
    let session=sessions.get_mut(&distro).ok_or("浏览器已关闭")?;
    match method.as_str(){
        "state"=>(),
        "layout"=>{
            let height=url.as_deref().and_then(|s|s.parse::<f64>().ok()).filter(|h|h.is_finite()&&*h>=BAR_HEIGHT*0.9&&*h<=BAR_HEIGHT*1.5).ok_or("无效的工具栏高度")?;
            session.bar_height=height;
            let size=session.window.inner_size().map_err(|e|e.to_string())?.to_logical::<f64>(session.window.scale_factor().map_err(|e|e.to_string())?);
            source.set_size(LogicalSize::new(size.width,height)).map_err(|e|e.to_string())?;
            for tab in &session.tabs{tab.webview.set_position(LogicalPosition::new(0.0,height)).map_err(|e|e.to_string())?;tab.webview.set_size(LogicalSize::new(size.width,(size.height-height).max(1.0))).map_err(|e|e.to_string())?;}
        },
        "navigate"=>{let target=page_url(url.as_deref().ok_or("请输入网址")?)?;let tab=session.tabs.iter().find(|t|t.id==session.active).ok_or("标签不存在")?;tab.webview.navigate(target).map_err(|e|e.to_string())?},
        "back"|"forward"=>{let tab=session.tabs.iter().find(|t|t.id==session.active).ok_or("标签不存在")?;tab.webview.eval(if method=="back"{"history.back()"}else{"history.forward()"}).map_err(|e|e.to_string())?},
        "reload"=>{let tab=session.tabs.iter().find(|t|t.id==session.active).ok_or("标签不存在")?;tab.webview.reload().map_err(|e|e.to_string())?},
        "new"=>{add_tab(session,&distro,page_url(url.as_deref().unwrap_or("https://example.com"))?)?;},
        "switch"=>{let target=id.ok_or("缺少标签 ID")?;if !session.tabs.iter().any(|t|t.id==target){return Err("标签不存在".into())}for tab in &session.tabs{if tab.id==target{tab.webview.show().map_err(|e|e.to_string())?}else{let _=tab.webview.hide();}}session.active=target;},
        "close"=>{let target=id.ok_or("缺少标签 ID")?;if session.tabs.len()==1{return Err("至少保留一个标签".into())}let index=session.tabs.iter().position(|t|t.id==target).ok_or("标签不存在")?;let tab=session.tabs.remove(index);let _=tab.webview.close();if session.active==target{let next=session.tabs.last().unwrap();session.active=next.id;next.webview.show().map_err(|e|e.to_string())?}},
        _=>return Err("未知浏览器操作".into())
    }
    Ok(snapshot(session))
}

pub async fn smoke(app:AppHandle,distro:String)->Result<Value>{
    let user=tauri::async_runtime::spawn_blocking({let distro=distro.clone();let app=app.clone();move ||crate::desktop::connect_for_smoke(&distro,&app.state::<DesktopState>())})
        .await.map_err(|e|e.to_string())??;
    let tabs=browser_open(app.clone(),distro.clone(),user,Some("https://example.com".into())).await?;
    let session_label=label(&distro);
    let window=app.get_window(&session_label).ok_or("浏览器窗口未创建")?;
    let chrome=app.get_webview(&format!("browser-chrome-{}",&session_label[8..])).ok_or("浏览器工具栏未创建")?;
    let page=app.get_webview(&format!("browser-page-{}-1",&session_label[8..])).ok_or("浏览器页面未创建")?;
    let main=app.get_webview("main").ok_or("主界面未创建")?;
    let encoded=serde_json::to_string(&distro).map_err(|e|e.to_string())?;
    for _ in 0..20{if eval_text(&main,"document.body?.innerText || ''")?.contains("工作台"){break}std::thread::sleep(Duration::from_millis(500));}
    main.eval(format!("Array.from(document.querySelectorAll('button.distro-nav')).find(b=>b.title==={encoded})?.click()")).map_err(|e|e.to_string())?;
    let mut desktop_text=String::new();
    for _ in 0..30{desktop_text=eval_text(&main,"document.querySelector('.desktop-stage')?.innerText || ''")?;if desktop_text.contains("文件")&&desktop_text.contains("浏览器"){break}std::thread::sleep(Duration::from_millis(500));}
    if !desktop_text.contains("浏览器"){return Err(format!("主界面桌面未进入就绪状态：{}",desktop_text.chars().take(200).collect::<String>()))}
    main.eval("document.querySelector('.desktop-launchers button[title=\"打开文件\"]')?.click()").map_err(|e|e.to_string())?;
    let mut file_ready=false;
    for _ in 0..20{file_ready=eval_text(&main,"!!document.querySelector('.desktop-window-body .file-table')")?.contains("true");if file_ready{break}std::thread::sleep(Duration::from_millis(500));}
    if !file_ready{return Err("桌面文件管理器未能读取 Linux 目录".into())}
    let main_window=app.get_window("main").ok_or("主窗口未创建")?;
    main_window.set_size(LogicalSize::new(920.0,650.0)).map_err(|e|e.to_string())?;
    std::thread::sleep(Duration::from_millis(400));
    if !eval_text(&main,"document.documentElement.scrollWidth <= window.innerWidth + 2 && !!document.querySelector('.desktop-stage')")?.contains("true") {return Err("最小窗口尺寸下桌面发生横向溢出".into())}
    let mut loaded_url=String::new();
    for _ in 0..30{loaded_url=page.url().map_err(|e|e.to_string())?.to_string();if loaded_url.starts_with("https://example.com"){break}std::thread::sleep(std::time::Duration::from_millis(500));}
    let chrome_url=chrome.url().map_err(|e|e.to_string())?.to_string();
    if !chrome_url.contains("browser=1") || !loaded_url.starts_with("https://example.com") {return Err(format!("浏览器页面未正确加载：工具栏 {chrome_url}；网页 {loaded_url}"))}
    let (tx,rx)=mpsc::channel();chrome.eval_with_callback("document.body?.innerText || ''",move |text|{let _=tx.send(text);}).map_err(|e|e.to_string())?;
    let chrome_text=rx.recv_timeout(Duration::from_secs(5)).map_err(|_|"浏览器工具栏没有响应")?;
    if !chrome_text.contains(&distro){return Err(format!("浏览器工具栏未渲染：{chrome_text}"))}
    chrome.eval(format!("window.__TAURI_INTERNALS__.invoke('browser_rpc',{{method:'state',distro:{encoded}}}).then(()=>document.body.dataset.rpcCheck='ok').catch(e=>document.body.dataset.rpcCheck='error:'+String(e))")).map_err(|e|e.to_string())?;
    std::thread::sleep(Duration::from_millis(800));
    let (tx,rx)=mpsc::channel();chrome.eval_with_callback("document.body.dataset.rpcCheck || 'pending'",move |value|{let _=tx.send(value);}).map_err(|e|e.to_string())?;
    let rpc_check=rx.recv_timeout(Duration::from_secs(5)).map_err(|_|"浏览器工具栏 RPC 没有响应")?;
    if !rpc_check.contains("ok"){return Err(format!("浏览器工具栏 RPC 失败：{rpc_check}"))}
    page.eval(format!("window.__TAURI_INTERNALS__.invoke('browser_rpc',{{method:'state',distro:{encoded}}}).then(()=>document.body.dataset.ipcCheck='allowed').catch(()=>document.body.dataset.ipcCheck='denied')")).map_err(|e|e.to_string())?;
    std::thread::sleep(Duration::from_millis(800));
    let (tx,rx)=mpsc::channel();page.eval_with_callback("document.body.dataset.ipcCheck || 'pending'",move |value|{let _=tx.send(value);}).map_err(|e|e.to_string())?;
    let page_check=rx.recv_timeout(Duration::from_secs(5)).map_err(|_|"网页安全检查没有响应")?;
    if !page_check.contains("denied"){return Err(format!("外部网页意外获得管理权限：{page_check}"))}
    let opened=browser_rpc(app.clone(),chrome.clone(),"new".into(),distro.clone(),None,Some("https://example.org".into())).await?;
    let new_id=opened["active"].as_u64().ok_or("新标签无效")? as u32;
    if opened["tabs"].as_array().map(|t|t.len())!=Some(2){return Err("浏览器新建标签失败".into())}
    browser_rpc(app.clone(),chrome.clone(),"switch".into(),distro.clone(),Some(1),None).await?;
    let closed=browser_rpc(app.clone(),chrome.clone(),"close".into(),distro.clone(),Some(new_id),None).await?;
    if closed["tabs"].as_array().map(|t|t.len())!=Some(1){return Err("浏览器关闭标签失败".into())}
    let result=json!({"window":window.label(),"chrome":chrome.label(),"page":page.label(),"tabs":tabs,"loadedUrl":loaded_url,"chromeUrl":chrome_url,"chromeRendered":true,"rpcVerified":true,"pageBridgeDenied":true,"desktopRendered":true,"filesRendered":true,"tabsVerified":true,"minSizeVerified":true,"size":window.inner_size().map_err(|e|e.to_string())?.width});
    app.state::<BrowserState>().close_all();
    app.state::<DesktopState>().close_all();
    Ok(result)
}

fn eval_text(webview:&Webview,script:&str)->Result<String>{
    let (tx,rx)=mpsc::channel();webview.eval_with_callback(script,move |value|{let _=tx.send(value);}).map_err(|e|e.to_string())?;
    rx.recv_timeout(Duration::from_secs(5)).map_err(|_|"界面脚本没有响应".to_string())
}
