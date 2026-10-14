"""WSL Manager's unprivileged, stdio-only Linux helper. Python 3 stdlib only."""
import base64
import hashlib
import json
import os
import platform
import pwd
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

previous = {}
previous_processes = {}


def read(path):
    return Path(path).read_text(errors="replace")


def run(args, timeout=30, check=True):
    p = subprocess.run(args, capture_output=True, text=True, errors="replace", timeout=timeout,
                       env={**os.environ, "LC_ALL": "C", "SYSTEMD_COLORS": "0", "SYSTEMD_PAGER": "cat"})
    output = (p.stdout + p.stderr)[-2_000_000:]
    if check and p.returncode:
        raise RuntimeError(output.strip() or "Command exited with code " + str(p.returncode))
    return output


def system_info():
    release = {}
    for line in read("/etc/os-release").splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            release[k] = v.strip('"')
    return dict(os=release.get("PRETTY_NAME", "Linux"), id=release.get("ID", "linux"),
                hostname=platform.node(), kernel=platform.release(), arch=platform.machine(),
                user=pwd.getpwuid(os.getuid()).pw_name, home=str(Path.home()),
                shell=os.environ.get("SHELL", "/bin/sh"), systemd=Path("/run/systemd/system").exists(),
                packageManager=provider(), pid=os.getpid())


def processes():
    global previous_processes
    result, current = [], {}
    now = time.monotonic()
    hz = os.sysconf("SC_CLK_TCK")
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            raw = read(entry / "stat")
            fields = raw[raw.rfind(")") + 2:].split()
            pid = int(entry.name)
            ticks = int(fields[11]) + int(fields[12])
            start = fields[19]
            old = previous_processes.get((pid, start))
            cpu = max(0, (ticks - old[0]) / hz / (now - old[1]) * 100) if old else None
            current[(pid, start)] = (ticks, now)
            status = dict(line.split(":", 1) for line in read(entry / "status").splitlines() if ":" in line)
            uid = int(status["Uid"].split()[0])
            try:
                user = pwd.getpwuid(uid).pw_name
            except KeyError:
                user = str(uid)
            cmd = (entry / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace").strip()
            result.append(dict(pid=pid, ppid=int(fields[1]), name=status.get("Name", "").strip(),
                               user=user, cpu=round(cpu, 1) if cpu is not None else None,
                               rss=int(status.get("VmRSS", "0 kB").split()[0]) * 1024,
                               threads=int(status.get("Threads", "1")), state=fields[0],
                               command=cmd, start=start))
        except (OSError, ValueError, IndexError, KeyError, ProcessLookupError):
            continue
    previous_processes = current
    return sorted(result, key=lambda p: (-(p["cpu"] or 0), -p["rss"]))


def metrics():
    global previous
    now = time.monotonic()
    cpus = {}
    for line in read("/proc/stat").splitlines():
        f = line.split()
        if f[0].startswith("cpu"):
            values = list(map(int, f[1:9]))
            cpus[f[0]] = (sum(values), values[3] + values[4])
    usage = {}
    for name, value in cpus.items():
        old = previous.get("cpus", {}).get(name)
        usage[name] = round(max(0, min(100, 100 * (1 - (value[1] - old[1]) / max(1, value[0] - old[0])))), 1) if old else None
    mem = {line.split(":")[0]: int(line.split()[1]) * 1024 for line in read("/proc/meminfo").splitlines()}
    interfaces = []
    for line in read("/proc/net/dev").splitlines()[2:]:
        name, values = line.split(":", 1)
        fields = values.split()
        if name.strip() != "lo":
            interfaces.append((int(fields[0]), int(fields[8])))
    rx, tx = sum(i[0] for i in interfaces), sum(i[1] for i in interfaces)
    disk = shutil.disk_usage("/")
    io = [0, 0]
    dev = os.stat("/").st_dev
    for line in read("/proc/diskstats").splitlines():
        f = line.split()
        if int(f[0]) == os.major(dev) and int(f[1]) == os.minor(dev):
            io = [int(f[5]) * 512, int(f[9]) * 512]
    elapsed = now - previous.get("time", now)
    def rate(key, value):
        return max(0, (value - previous[key]) / elapsed) if key in previous and elapsed > 0 else None
    procs = processes()
    data = dict(time=time.time(), cpu=usage.get("cpu"), cores=[v for k, v in usage.items() if k != "cpu"],
                memory=dict(total=mem["MemTotal"], used=mem["MemTotal"]-mem["MemAvailable"],
                            available=mem["MemAvailable"], cached=mem.get("Cached", 0),
                            swapTotal=mem.get("SwapTotal", 0), swapUsed=mem.get("SwapTotal", 0)-mem.get("SwapFree", 0)),
                disk=dict(total=disk.total, used=disk.used, free=disk.free),
                load=list(os.getloadavg()), uptime=float(read("/proc/uptime").split()[0]),
                rx=rate("rx", rx), tx=rate("tx", tx), diskRead=rate("diskRead", io[0]), diskWrite=rate("diskWrite", io[1]),
                processCount=len(procs), processRss=sum(p["rss"] for p in procs), top=procs[:8])
    previous = dict(time=now, cpus=cpus, rx=rx, tx=tx, diskRead=io[0], diskWrite=io[1])
    return data


def path_arg(p, key="path"):
    value = p.get(key, "")
    if not isinstance(value, str) or not value.startswith("/") or "\0" in value:
        raise ValueError("请输入绝对 Linux 路径")
    return Path(value)


def regular(path):
    info = path.stat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("此操作仅支持普通文件")
    return info


def version(path):
    regular(path)
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fs_list(p):
    path = path_arg(p).resolve(strict=True)
    rows = []
    with os.scandir(path) as entries:
        for entry in entries:
            try:
                s = entry.stat(follow_symlinks=False)
                rows.append(dict(name=entry.name, path=str(path / entry.name), isDir=entry.is_dir(),
                                 isLink=entry.is_symlink(), size=s.st_size, modified=s.st_mtime,
                                 mode=stat.filemode(s.st_mode), uid=s.st_uid, gid=s.st_gid))
            except OSError:
                continue
            if len(rows) > 10000:
                raise ValueError("目录超过 10000 项，请使用终端查看")
    return dict(path=str(path), entries=sorted(rows, key=lambda x: (not x["isDir"], x["name"].lower())))


def fs_read(p):
    path = path_arg(p).resolve(strict=True)
    info = regular(path)
    limit = 64 * 1024 * 1024 if p.get("binary") else 2 * 1024 * 1024
    if info.st_size > limit:
        raise ValueError("文件超过大小限制（编辑 2 MB，传输 64 MB），请使用终端或资源管理器")
    content = path.read_bytes()
    if p.get("binary"):
        return dict(path=str(path), data=base64.b64encode(content).decode())
    if b"\0" in content:
        raise ValueError("二进制文件不能在文本编辑器中打开")
    return dict(path=str(path), content=content.decode("utf-8"), version=hashlib.sha256(content).hexdigest())


def fs_write(p):
    target = path_arg(p)
    # Edits bind to the canonical file read earlier; link changes cannot redirect them.
    if target.is_symlink():
        raise ValueError("路径现在是符号链接，请重新打开文件")
    exists = target.exists()
    original = regular(target) if exists else None
    if exists and (not p.get("version") or version(target) != p["version"]):
        raise ValueError("文件已在外部修改或同名文件已存在，请重新读取后再保存")
    data = base64.b64decode(p["data"], validate=True) if "data" in p else p.get("content", "").encode("utf-8")
    if len(data) > 64 * 1024 * 1024:
        raise ValueError("文件超过 64 MB")
    fd, tmp = tempfile.mkstemp(prefix=".wsl-manager-", dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            if original:
                os.fchmod(f.fileno(), stat.S_IMODE(original.st_mode))
                os.fchown(f.fileno(), original.st_uid, original.st_gid)
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        if exists:
            for attr in os.listxattr(target):
                os.setxattr(tmp, attr, os.getxattr(target, attr))
            if target.is_symlink() or version(target) != p["version"]:
                raise ValueError("保存期间文件发生变化，请重新读取")
            os.replace(tmp, target)
        else:
            # Atomic no-clobber create, unlike a check followed by rename.
            os.link(tmp, target)
            os.unlink(tmp)
        directory = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return dict(path=str(target), version=hashlib.sha256(data).hexdigest())


def provider():
    for name in ("apt-get", "dnf", "pacman", "apk", "zypper"):
        if shutil.which(name):
            return name
    return None


def packages(p):
    manager = provider()
    query = str(p.get("query", "")).strip()
    mode = p.get("mode", "installed")
    rows = []
    if manager == "apt-get":
        installed = run(["dpkg-query", "-W", "-f=${Package}\t${Version}\t${db:Status-Status}\n"])
        have = {}
        for line in installed.splitlines():
            parts = line.split("\t")
            if len(parts) == 3 and parts[2] == "installed":
                have[parts[0]] = parts[1]
        if mode == "search":
            if not query or query.startswith("-") or len(query) > 100:
                raise ValueError("请输入软件名称（1–100 个字符）")
            for line in run(["apt-cache", "search", "--names-only", re.escape(query)]).splitlines():
                name, _, description = line.partition(" - ")
                rows.append(dict(name=name, version=have.get(name, ""), description=description, installed=name in have))
        elif mode == "updates":
            for line in run(["apt", "list", "--upgradable"], check=False).splitlines():
                if "/" in line and "upgradable from" in line:
                    f = line.split()
                    name = f[0].split("/")[0]
                    rows.append(dict(name=name, version=have.get(name, ""), description="可升级至 " + f[1], installed=True))
        else:
            rows = [dict(name=k, version=v, description="", installed=True) for k, v in have.items()]
    elif manager == "dnf":
        if mode == "search":
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9+_.-]{0,99}", query):
                raise ValueError("请输入软件名称")
            text = run(["dnf", "-q", "list", "--available", "*" + query + "*"], timeout=90, check=False)
            for line in text.splitlines():
                f = line.split()
                if len(f) == 3 and "." in f[0]:
                    rows.append(dict(name=f[0], version=f[1], description=f[2], installed=False))
        elif mode == "updates":
            text = run(["dnf", "-q", "check-update"], timeout=90, check=False)
            for line in text.splitlines():
                f = line.split()
                if len(f) == 3 and "." in f[0]:
                    rows.append(dict(name=f[0], version=f[1], description=f[2], installed=True))
        else:
            for line in run(["rpm", "-qa", "--qf", "%{NAME}\t%{VERSION}-%{RELEASE}\n"]).splitlines():
                name, _, v = line.partition("\t")
                rows.append(dict(name=name, version=v, description="", installed=True))
    else:
        raise ValueError("首版软件界面支持 apt / dnf；此发行版请使用终端管理软件")
    if query and mode != "search":
        rows = [r for r in rows if query.lower() in r["name"].lower()]
    return dict(manager=manager, total=len(rows), entries=rows[:500])


def package_action(p):
    if os.getuid() != 0:
        raise PermissionError("此操作需要 Root 权限")
    action = p.get("action")
    name = p.get("name", "")
    if action in ("install", "remove", "upgrade") and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9+_.:-]{0,199}", name):
        raise ValueError("软件名称无效")
    manager = provider()
    if manager == "apt-get":
        commands = {"install": ["install", "-y", "--", name], "remove": ["remove", "-y", "--", name],
                    "upgrade": ["install", "--only-upgrade", "-y", "--", name], "refresh": ["update"]}
    elif manager == "dnf":
        commands = {"install": ["install", "-y", "--", name], "remove": ["remove", "-y", "--", name],
                    "upgrade": ["upgrade", "-y", "--", name], "refresh": ["makecache"]}
    else:
        raise ValueError("暂不支持此软件管理器，请使用终端")
    if action not in commands:
        raise ValueError("无效操作")
    os.environ["DEBIAN_FRONTEND"] = "noninteractive"
    args = [manager]
    if manager == "apt-get":
        args += ["-o", "Dpkg::Options::=--force-confold", "-o", "Dpkg::Options::=--force-confdef"]
    return dict(output=run(args + commands[action], timeout=1200))


def services():
    if not Path("/run/systemd/system").exists():
        return dict(available=False, entries=[])
    text = run(["systemctl", "list-units", "--type=service", "--all", "--no-legend", "--plain", "--no-pager"])
    units = {}
    for line in text.splitlines():
        f = line.split(None, 4)
        if len(f) >= 4:
            units[f[0]] = dict(name=f[0], load=f[1], active=f[2], sub=f[3], description=f[4] if len(f) > 4 else "", enabled="—")
    for line in run(["systemctl", "list-unit-files", "--type=service", "--no-legend", "--no-pager"], check=False).splitlines():
        f = line.split()
        if len(f) >= 2:
            if f[0] in units:
                units[f[0]]["enabled"] = f[1]
            elif "@" not in f[0]:
                units[f[0]] = dict(name=f[0], load="loaded", active="inactive", sub="dead", description="", enabled=f[1])
    return dict(available=True, entries=list(units.values()))


def unit_name(p):
    name = p.get("name", "")
    if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.@:\\-]{0,240}\.service", name):
        raise ValueError("无效的 service 名称")
    return name


def network():
    interfaces = json.loads(run(["ip", "-j", "address"])) if shutil.which("ip") else []
    text = run(["ss", "-H", "-lntup"], check=False) if shutil.which("ss") else ""
    ports = []
    for line in text.splitlines():
        f = line.split(None, 6)
        if len(f) >= 6:
            port = f[4].rsplit(":", 1)[-1]
            ports.append(dict(protocol=f[0], state=f[1], address=f[4], port=int(port) if port.isdigit() else None,
                              process=f[6] if len(f) > 6 else "当前用户无权查看进程"))
    return dict(interfaces=interfaces, ports=ports, dns=read("/etc/resolv.conf"))


def dispatch(method, p):
    if method == "system.info": return system_info()
    if method == "metrics": return metrics()
    if method == "process.list": return processes()
    if method == "process.signal":
        pid = int(p["pid"])
        if pid <= 1 or pid == os.getpid(): raise ValueError("不能结束系统初始化进程或管理助手")
        raw = read("/proc/%d/stat" % pid)
        if raw[raw.rfind(")")+2:].split()[19] != str(p.get("start")):
            raise ValueError("进程已改变，请刷新列表")
        sig = {"TERM": signal.SIGTERM, "KILL": signal.SIGKILL}.get(p.get("signal"))
        if sig is None: raise ValueError("无效信号")
        os.kill(pid, sig)
        return {"ok": True}
    if method == "fs.list": return fs_list(p)
    if method == "fs.read": return fs_read(p)
    if method == "fs.write": return fs_write(p)
    if method == "fs.mkdir":
        path_arg(p).mkdir()
        return {"ok": True}
    if method == "fs.move":
        source, dest = path_arg(p), path_arg(p, "destination")
        if dest.exists() or dest.is_symlink(): raise ValueError("目标已存在")
        if source == Path("/"): raise ValueError("不能移动根目录")
        # renameat2 RENAME_NOREPLACE closes the overwrite race on Linux.
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.renameat2(-100, os.fsencode(source), -100, os.fsencode(dest), 1) != 0:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))
        return {"ok": True}
    if method == "fs.copy":
        source, dest = path_arg(p), path_arg(p, "destination")
        if source.is_symlink() or not source.is_file(): raise ValueError("目前只支持复制普通文件")
        fd, tmp = tempfile.mkstemp(prefix=".linuxdesk-copy-", dir=dest.parent)
        os.close(fd)
        try:
            shutil.copy2(source, tmp)
            os.link(tmp, dest)  # Refuse to overwrite an existing destination.
        finally:
            os.unlink(tmp)
        return {"ok": True}
    if method == "fs.chmod":
        path = path_arg(p)
        mode = p.get("mode", "")
        if not isinstance(mode, str) or not re.fullmatch(r"[0-7]{3,4}", mode): raise ValueError("请输入三位或四位八进制权限")
        if path.is_symlink(): raise ValueError("不修改符号链接权限")
        os.chmod(path, int(mode, 8))
        return {"ok": True}
    if method == "fs.delete":
        path = path_arg(p)
        if str(path.resolve()) in ("/", "/home", "/etc", "/usr", "/var", str(Path.home())):
            raise ValueError("不能删除系统目录或主目录")
        if path.is_dir() and not path.is_symlink():
            path.rmdir()  # Intentionally refuse recursive deletion; terminal is explicit.
        else:
            path.unlink()
        return {"ok": True}
    if method == "package.list": return packages(p)
    if method == "package.action": return package_action(p)
    if method == "service.list": return services()
    if method == "service.logs":
        return {"output": run(["journalctl", "-u", unit_name(p), "-n", "200", "--no-pager", "-o", "short-iso"], check=False)}
    if method == "service.action":
        if p.get("action") not in ("start", "stop", "restart", "reload", "enable", "disable"):
            raise ValueError("无效服务操作")
        return {"output": run(["systemctl", p["action"], unit_name(p)], timeout=90)}
    if method == "network": return network()
    raise ValueError("未知方法: " + method)


def main():
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            result = dispatch(request["method"], request.get("params", {}))
            reply = {"id": request.get("id"), "result": result}
        except Exception as error:
            reply = {"id": request.get("id"), "error": str(error)}
        print(json.dumps(reply, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
