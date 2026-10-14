//go:build linux

package main

import (
	"errors"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

func owner(info os.FileInfo) (uint32, uint32) {
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		return stat.Uid, stat.Gid
	}
	return 0, 0
}

func preserveOwnerAndAttrs(source, target string, info os.FileInfo) error {
	uid, gid := owner(info)
	targetInfo, err := os.Lstat(target)
	if err != nil {
		return err
	}
	tu, tg := owner(targetInfo)
	if uid != tu || gid != tg {
		if err = os.Chown(target, int(uid), int(gid)); err != nil {
			return err
		}
	}
	size, err := syscall.Listxattr(source, nil)
	if err == syscall.ENOTSUP {
		return nil
	}
	if err != nil {
		return err
	}
	if size == 0 {
		return nil
	}
	names := make([]byte, size)
	size, err = syscall.Listxattr(source, names)
	if err != nil {
		return err
	}
	for _, name := range strings.Split(string(names[:size]), "\x00") {
		if name == "" {
			continue
		}
		n, err := syscall.Getxattr(source, name, nil)
		if err != nil {
			return err
		}
		value := make([]byte, n)
		_, err = syscall.Getxattr(source, name, value)
		if err != nil {
			return err
		}
		if err = syscall.Setxattr(target, name, value, 0); err != nil {
			return err
		}
	}
	return nil
}

func renameNoReplace(source, dest string) error {
	// Linux renameat2 syscall numbers on the two architectures packaged by this app.
	var number uintptr
	switch runtime.GOARCH {
	case "amd64":
		number = 316
	case "arm64":
		number = 276
	default:
		return errors.New("unsupported architecture for safe rename")
	}
	from, err := syscall.BytePtrFromString(source)
	if err != nil {
		return err
	}
	to, err := syscall.BytePtrFromString(dest)
	if err != nil {
		return err
	}
	_, _, errno := syscall.Syscall6(number, uintptr(^uint(99)), uintptr(unsafe.Pointer(from)), uintptr(^uint(99)), uintptr(unsafe.Pointer(to)), 1, 0)
	if errno != 0 {
		return errno
	}
	return nil
}

func signalProcess(p map[string]any) (any, error) {
	pidFloat, ok := p["pid"].(float64)
	if !ok || pidFloat != float64(int(pidFloat)) {
		return nil, errors.New("无效进程 PID")
	}
	pid := int(pidFloat)
	if pid <= 1 || pid == os.Getpid() {
		return nil, errors.New("不能结束系统初始化进程或管理助手")
	}
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return nil, err
	}
	end := strings.LastIndex(string(data), ")")
	if end < 0 {
		return nil, errors.New("进程信息无效")
	}
	fields := strings.Fields(string(data)[end+1:])
	if len(fields) < 20 {
		return nil, errors.New("进程信息无效")
	}
	start, _ := p["start"].(string)
	if fields[19] != start {
		return nil, errors.New("进程已改变，请刷新列表")
	}
	signal, _ := p["signal"].(string)
	var sig syscall.Signal
	switch signal {
	case "TERM":
		sig = syscall.SIGTERM
	case "KILL":
		sig = syscall.SIGKILL
	default:
		return nil, errors.New("无效信号")
	}
	if err = syscall.Kill(pid, sig); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}
