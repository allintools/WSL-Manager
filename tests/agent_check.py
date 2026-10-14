"""Run inside Linux: python3 tests/agent_check.py. All mutations use owned temp data."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

spec = importlib.util.spec_from_file_location("agent", Path(__file__).parents[1] / "agent" / "agent.py")
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)
checks = []


def check(name, fn):
    fn()
    checks.append(name)
    print("PASS", name, flush=True)


def expect_error(fn):
    try:
        fn()
    except (ValueError, OSError):
        return
    raise AssertionError("Expected safe rejection")


def files():
    with tempfile.TemporaryDirectory(prefix="wsl-manager-check-") as root:
        p = str(Path(root) / "中文 ' $文件.txt")
        first = agent.fs_write(dict(path=p, content="第一行\nhello\n"))
        result = agent.fs_read(dict(path=p))
        assert result["content"] == "第一行\nhello\n"
        os.chmod(p, 0o640)
        agent.fs_write(dict(path=p, content="saved", version=first["version"]))
        assert os.stat(p).st_mode & 0o777 == 0o640
        assert Path(p).read_text() == "saved"
        expect_error(lambda: agent.fs_write(dict(path=p, content="clobber")))
        expect_error(lambda: agent.fs_write(dict(path=p, content="clobber", version=first["version"])))
        assert Path(p).read_text() == "saved"
        symlink = str(Path(root) / "link")
        os.symlink(p, symlink)
        expect_error(lambda: agent.fs_write(dict(path=symlink, content="bad", version=agent.version(Path(p)))))
        assert agent.fs_list(dict(path=root))["entries"][0]["name"]
        dest = str(Path(root) / "moved.txt")
        agent.dispatch("fs.move", dict(path=p, destination=dest))
        agent.fs_write(dict(path=p, content="other"))
        expect_error(lambda: agent.dispatch("fs.move", dict(path=p, destination=dest)))
        assert Path(dest).read_text() == "saved"
        agent.dispatch("fs.delete", dict(path=dest))
        assert not Path(dest).exists()
        directory = str(Path(root) / "folder")
        agent.dispatch("fs.mkdir", dict(path=directory))
        agent.dispatch("fs.delete", dict(path=directory))
        expect_error(lambda: agent.dispatch("fs.delete", dict(path="/")))
        expect_error(lambda: agent.fs_read(dict(path="/proc")))


def process():
    sleeper = subprocess.Popen(["sleep", "60"])
    try:
        p = next(p for p in agent.processes() if p["pid"] == sleeper.pid)
        expect_error(lambda: agent.dispatch("process.signal", dict(pid=p["pid"], start="wrong", signal="TERM")))
        agent.dispatch("process.signal", dict(pid=p["pid"], start=p["start"], signal="TERM"))
        assert sleeper.wait(timeout=5) != 0
    finally:
        if sleeper.poll() is None:
            sleeper.kill()
            sleeper.wait()


def metrics():
    first = agent.metrics()
    time.sleep(.2)
    m = agent.metrics()
    assert 0 <= m["cpu"] <= 100
    assert m["memory"]["total"] > m["memory"]["used"] >= 0
    assert m["disk"]["total"] > 0 and m["processCount"] > 0
    assert m["rx"] >= 0 and len(m["cores"]) > 0


check("system info", lambda: agent.system_info()["os"])
check("metrics and process sampling", metrics)
check("atomic UTF-8 file IO, mode preservation, conflicts, symlinks, no-clobber move", files)
check("process identity guard and TERM", process)
check("installed packages", lambda: agent.packages({})["entries"][0])
check("package search", lambda: agent.packages(dict(mode="search", query="bash"))["entries"][0])
check("service enumeration", lambda: agent.services())
check("network enumeration", lambda: agent.network())
print(json.dumps({"passed": len(checks), "checks": checks}, ensure_ascii=False))
