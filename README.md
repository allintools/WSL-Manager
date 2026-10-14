# WSL Manager 1.2.1

Windows 本机 WSL 管理桌面程序，界面为简体中文。应用仅在本机运行，不连接在线服务。

主题系统已接入正式软件。打开“设置 → 外观”可切换 Alpine / Dark / Light、Flat / 3D、五档缩放，替换壁纸、调整透明度/模糊/遮罩并启用低性能模式。偏好在本机自动保存，重新打开恢复；终端、编辑器和浏览器工具栏同步适配。

## 开始使用

本仓库提供源码，按下方「从源码启动」步骤构建后，在 Windows 上双击 `src-tauri/target/release/wsl-manager-desktop.exe`。发布版已经内置前端和 Go Agent，不需要启动开发服务器。在工作台启动一个发行版，点击发行版名称，默认进入“桌面”。首次进入时选择普通 Linux 用户，点击“安装并连接”；程序将对应架构的 Go Agent 安装到该用户的 `~/.local/bin/linuxdesk-agent`。如果发行版只有 root 用户，先在桌面引导中创建普通用户。这个操作不会改变发行版的默认用户。之后再次进入会自动连接；顶部可更新或卸载 Agent。

桌面把文件、终端、资源、进程、软件、服务、网络放在可移动、缩放、最小化的窗口中。桌面终端使用所选的普通 Linux 用户。切换发行版时，各自的桌面窗口和未保存的编辑会留在应用会话里；关闭程序前会提示未保存内容。旧的功能标签仍保留，未安装 Agent 的发行版也可继续使用原有管理页面。

点击桌面“浏览器”，同一程序会打开独立的 WebView2 浏览器窗口。地址栏支持 HTTP/HTTPS，窗口内可新建和切换标签；每个发行版有独立的 Cookie/缓存目录，网页经当前 Linux 的网络代理访问。如果该发行版没有网络连接，网页会显示连接错误，不会自动改走 Windows 网络。网页下载默认保存到 Windows；要放入 Linux，可在桌面“文件”窗口点击“上传”。

Agent 默认随本次客户端会话结束，不要求 systemd，也不常驻 root。普通管理请求走带临时令牌的 localhost API；软件安装和服务启停在确认后以一次性 root 进程执行。更新前保留上一版 Agent 供失败时回滚。卸载只删除 Agent 二进制和上一版备份，用户文件和浏览器数据保留。

WSL 列表默认每 8 秒刷新。工作台可以启动、停止和重启发行版、设默认发行版、导入 tar/VHDX 备份、导出 tar/VHDX 备份。删除发行版前需准确输入发行版名称；该操作会永久删除它的数据。停止和重启会结束该发行版中的进程。

“版本管理”页可查看 WSL 引擎、内核和默认 WSL 版本，选择 Microsoft Store 或 web-download 更新稳定版/预览版；在线发行版列表直接来自 `wsl --list --online`，可搜索并下载安装，选择默认或自定义安装目录。Debian 官方目录只列出 Debian 名称时，使用下方“Debian 指定版本”可单独安装 Debian 13/Trixie 或 Debian 12/Bookworm：程序从 Debian 官方 Cloud 镜像下载 amd64 rootfs、验证官方 SHA-512 后导入为 WSL 2，名称分别为 `Debian-13` 和 `Debian-12`。这两项使用 Debian Cloud 镜像而非 Store 包，导入发行版首次启动默认是 root。新安装默认不自动启动。页面也可设置新发行版默认使用 WSL 1 或 2，并将已安装发行版转换到另一版本。转换、引擎更新和安装均显示在操作记录中；版本转换可能耗时较长。

打开正在运行的发行版后，也可直接使用概览、进程、资源、文件、终端、软件、服务和网络标签。文件查看和编辑使用 Linux 用户权限；文本编辑限制为 2 MB，并检测外部改动后再保存。文件窗口支持复制普通文件、移动、重命名、修改权限、显示隐藏文件和排序。删除目录只支持空目录，避免误删目录树。编辑器支持 UTF-8。

终端使用 Windows ConPTY 和内置 xterm.js，支持中文、彩色程序、多个会话和窗口缩放。常规 Linux 用户命令直接运行。软件安装/卸载/升级、服务启停等明确显示发行版和操作，并要求在应用中确认后，以临时 `wsl.exe -u root` 会话运行；程序不保存 Linux 密码。

资源页将所有 WSL2 发行版共享的虚拟机 CPU/内存与当前发行版的进程 RSS 分开显示。监控数据由 Linux `/proc` 读取。软件列表和本地软件仓库搜索当前支持 apt 与 dnf；其他发行版仍可使用文件、终端、进程和资源功能。

在“设置”修改 `.wslconfig` 后，应用会在同一目录保留时间戳备份。该文件配置作用于所有 WSL2 发行版；需先确认保存，然后在工作台选择“关闭全部 WSL”，再重新启动，设置才生效。

## 从源码启动

安装 Node.js、Go 1.22+、Rust MSVC 工具链、Microsoft C++ Build Tools、Windows SDK 和 WebView2，然后在项目目录运行：

```powershell
npm install
npm run tauri:dev
```

在 `src-tauri` 目录执行 `cargo check` 或 `cargo build --release`。构建脚本会交叉编译 Linux amd64/arm64 Go Agent 并打包进 Windows 程序；运行时无需安装 Go。旧功能标签仍可使用发行版自带的 Python 3 助手，不需 pip 包。

构建包含前端资源的完整 Windows 发布程序：

```powershell
npm ci
npm run tauri -- build --no-bundle
```

生成文件为 `src-tauri/target/release/wsl-manager-desktop.exe`。

## 1.2.1 更新

- 左侧菜单右边缘中间增加圆形折叠/展开按钮；切换发行版及桌面 Tab 保留当前展开状态。
- 所有页面固定顶部面包屑和左侧菜单，仅滚动下方内容。
- Linux 桌面 Agent 保持独立版本 0.2.0。

## 源码包附带的历史验证记录

- Ubuntu 24.04 和 Ubuntu 26.04：真实 WSL 数据、UTF-8 文件往返、原子保存和并发修改保护。
- WSL 在线发行版目录解析、引擎状态、进程和 CPU/内存采样、apt 软件查询、systemd 服务、网络接口与监听端口。
- Windows ConPTY 交互输入、UTF-8 输出、终端调整大小。
- 普通用户与 Root 助手分离、危险包名参数校验。
- Go Agent 在 Ubuntu 26.04 和 Ubuntu 24.04 的独立安装、版本检测、HTTP 鉴权、资源/进程/软件/服务/网络接口、文件读写/冲突保护/无覆盖移动/复制/权限修改、root 操作校验及浏览器代理转发。
- 同一 Tauri 程序内的独立浏览器窗口、工具栏命令和文件桌面窗口；外部网页的管理命令被权限边界拒绝。
- 前端 TypeScript 生产构建；`.wslconfig` 保留未知键、保留键名大小写、清空与重复键处理。

本版本作为早期版本交付，现阶段只提供 WSL 连接器；普通 Linux 服务器的 SSH 连接和任意 X11/Wayland 图形程序显示尚未实现。网络端口的“打开”使用 WSL 的 localhost 转发，具体取决于 Windows / WSL 网络设置。

## 素材来源

`public/wallpapers/alpine.webp` 由内置 imagegen 生成，随后压缩为 WebP；未使用 Freebuff 品牌图像或文案。
