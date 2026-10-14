package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type rpcRequest struct {
	Method string         `json:"method"`
	Params map[string]any `json:"params"`
}

func (s *session) rpc(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", 405)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 90*1024*1024)
	var req rpcRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", 400)
		return
	}
	if req.Params == nil {
		req.Params = map[string]any{}
	}
	result, err := s.dispatch(req.Method, req.Params)
	if err != nil {
		writeJSON(w, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, map[string]any{"result": result})
}

func (s *session) dispatch(method string, p map[string]any) (any, error) {
	switch method {
	case "system.info":
		return systemInfo(), nil
	case "metrics":
		return s.metrics(), nil
	case "process.list":
		return s.processList(), nil
	case "package.list":
		return packageList(p)
	case "package.action":
		return packageAction(p)
	case "service.list":
		return serviceList()
	case "service.action":
		return serviceAction(p)
	case "service.logs":
		name, err := serviceName(p)
		if err != nil {
			return nil, err
		}
		out, err := commandOutput(30*time.Second, false, "journalctl", "-u", name, "-n", "200", "--no-pager", "-o", "short-iso")
		return map[string]any{"output": out}, err
	case "network":
		return networkInfo()
	case "fs.list":
		return fsList(p)
	case "fs.read":
		return fsRead(p)
	case "fs.write":
		return fsWrite(p)
	case "fs.mkdir":
		return fsMkdir(p)
	case "fs.move":
		return fsMove(p)
	case "fs.copy":
		return fsCopy(p)
	case "fs.chmod":
		return fsChmod(p)
	case "fs.delete":
		return fsDelete(p)
	case "process.signal":
		return signalProcess(p)
	default:
		return nil, errors.New("unsupported Go Agent method: " + method)
	}
}

func systemInfo() map[string]any {
	u, _ := user.Current()
	name, home := "", os.Getenv("HOME")
	if u != nil {
		name = u.Username
		if home == "" {
			home = u.HomeDir
		}
	}
	host, _ := os.Hostname()
	kernel, _ := commandOutput(5*time.Second, false, "uname", "-r")
	return map[string]any{"os": osRelease(), "id": osID(), "hostname": host, "kernel": strings.TrimSpace(kernel), "arch": goArch(), "user": name, "home": home, "shell": os.Getenv("SHELL"), "systemd": isDir("/run/systemd/system"), "packageManager": packageManager(), "pid": os.Getpid()}
}

func osID() string {
	b, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return "linux"
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "ID=") {
			return strings.Trim(strings.TrimPrefix(line, "ID="), "\"'")
		}
	}
	return "linux"
}
func goArch() string {
	out, err := commandOutput(5*time.Second, false, "uname", "-m")
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(out)
}

func commandOutput(timeout time.Duration, check bool, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = append(os.Environ(), "LC_ALL=C", "SYSTEMD_COLORS=0", "SYSTEMD_PAGER=cat", "DEBIAN_FRONTEND=noninteractive")
	out, err := cmd.CombinedOutput()
	if len(out) > 2_000_000 {
		out = out[len(out)-2_000_000:]
	}
	if ctx.Err() != nil {
		return "", fmt.Errorf("command timed out: %s", name)
	}
	if check && err != nil {
		return "", fmt.Errorf("%s: %s", name, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

func packageList(p map[string]any) (any, error) {
	manager := packageManager()
	mode, _ := p["mode"].(string)
	query, _ := p["query"].(string)
	query = strings.TrimSpace(query)
	if mode == "" {
		mode = "installed"
	}
	if mode != "installed" && mode != "search" && mode != "updates" {
		return nil, errors.New("invalid package mode")
	}
	if mode == "search" && (len(query) == 0 || len(query) > 100 || strings.HasPrefix(query, "-")) {
		return nil, errors.New("请输入软件名称（1–100 个字符）")
	}
	type row struct {
		Name        string `json:"name"`
		Version     string `json:"version"`
		Description string `json:"description"`
		Installed   bool   `json:"installed"`
	}
	rows := make([]row, 0)
	if manager == "apt-get" {
		out, err := commandOutput(30*time.Second, true, "dpkg-query", "-W", "-f=${Package}\t${Version}\t${db:Status-Status}\n")
		if err != nil {
			return nil, err
		}
		have := map[string]string{}
		for _, line := range strings.Split(out, "\n") {
			f := strings.Split(line, "\t")
			if len(f) == 3 && f[2] == "installed" {
				have[f[0]] = f[1]
			}
		}
		switch mode {
		case "search":
			out, err = commandOutput(60*time.Second, true, "apt-cache", "search", "--names-only", regexp.QuoteMeta(query))
			if err != nil {
				return nil, err
			}
			for _, line := range strings.Split(out, "\n") {
				name, desc, ok := strings.Cut(line, " - ")
				if ok {
					v, installed := have[name]
					rows = append(rows, row{name, v, desc, installed})
				}
			}
		case "updates":
			out, _ = commandOutput(60*time.Second, false, "apt", "list", "--upgradable")
			for _, line := range strings.Split(out, "\n") {
				f := strings.Fields(line)
				if len(f) > 1 && strings.Contains(line, "upgradable from") {
					name := strings.SplitN(f[0], "/", 2)[0]
					rows = append(rows, row{name, have[name], "可升级至 " + f[1], true})
				}
			}
		default:
			for name, v := range have {
				rows = append(rows, row{name, v, "", true})
			}
		}
	} else if manager == "dnf" {
		var out string
		var err error
		switch mode {
		case "search":
			out, err = commandOutput(90*time.Second, false, "dnf", "-q", "list", "--available", "*"+query+"*")
		case "updates":
			out, err = commandOutput(90*time.Second, false, "dnf", "-q", "check-update")
		default:
			out, err = commandOutput(60*time.Second, true, "rpm", "-qa", "--qf", "%{NAME}\t%{VERSION}-%{RELEASE}\n")
		}
		if err != nil {
			return nil, err
		}
		for _, line := range strings.Split(out, "\n") {
			if mode == "installed" {
				name, v, ok := strings.Cut(line, "\t")
				if ok {
					rows = append(rows, row{name, v, "", true})
				}
			}
			if mode != "installed" {
				f := strings.Fields(line)
				if len(f) == 3 && strings.Contains(f[0], ".") {
					rows = append(rows, row{f[0], f[1], f[2], mode == "updates"})
				}
			}
		}
	} else {
		return nil, errors.New("软件界面支持 apt / dnf；此发行版请使用终端")
	}
	if query != "" && mode != "search" {
		filtered := rows[:0]
		for _, r := range rows {
			if strings.Contains(strings.ToLower(r.Name), strings.ToLower(query)) {
				filtered = append(filtered, r)
			}
		}
		rows = filtered
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Name < rows[j].Name })
	total := len(rows)
	if total > 500 {
		rows = rows[:500]
	}
	return map[string]any{"manager": manager, "total": total, "entries": rows}, nil
}

var packageName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9+_.:-]{0,199}$`)

func packageAction(p map[string]any) (any, error) {
	if os.Geteuid() != 0 {
		return nil, errors.New("此操作需要 Root 权限")
	}
	manager := packageManager()
	action, _ := p["action"].(string)
	name, _ := p["name"].(string)
	if action != "refresh" && !packageName.MatchString(name) {
		return nil, errors.New("软件名称无效")
	}
	var args []string
	switch action {
	case "install":
		args = []string{"install", "-y", "--", name}
	case "remove":
		args = []string{"remove", "-y", "--", name}
	case "upgrade":
		if manager == "apt-get" {
			args = []string{"install", "--only-upgrade", "-y", "--", name}
		} else {
			args = []string{"upgrade", "-y", "--", name}
		}
	case "refresh":
		if manager == "apt-get" {
			args = []string{"update"}
		} else {
			args = []string{"makecache"}
		}
	default:
		return nil, errors.New("无效软件操作")
	}
	if manager != "apt-get" && manager != "dnf" {
		return nil, errors.New("暂不支持此软件管理器")
	}
	if manager == "apt-get" {
		args = append([]string{"-o", "Dpkg::Options::=--force-confold", "-o", "Dpkg::Options::=--force-confdef"}, args...)
	}
	out, err := commandOutput(1200*time.Second, true, manager, args...)
	if err != nil {
		return nil, err
	}
	return map[string]any{"output": out}, nil
}

func serviceName(p map[string]any) (string, error) {
	name, _ := p["name"].(string)
	if len(name) < 9 || len(name) > 249 || !strings.HasSuffix(name, ".service") {
		return "", errors.New("无效 service 名称")
	}
	for _, c := range name {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || strings.ContainsRune("_.@:-", c)) {
			return "", errors.New("无效 service 名称")
		}
	}
	return name, nil
}

func serviceList() (any, error) {
	if !isDir("/run/systemd/system") {
		return map[string]any{"available": false, "entries": []any{}}, nil
	}
	type row struct {
		Name        string `json:"name"`
		Load        string `json:"load"`
		Active      string `json:"active"`
		Sub         string `json:"sub"`
		Description string `json:"description"`
		Enabled     string `json:"enabled"`
	}
	out, err := commandOutput(30*time.Second, true, "systemctl", "list-units", "--type=service", "--all", "--no-legend", "--plain", "--no-pager")
	if err != nil {
		return nil, err
	}
	units := map[string]row{}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) > 0 && f[0] == "●" {
			f = f[1:]
		}
		if len(f) >= 4 {
			name := strings.TrimPrefix(f[0], "●")
			description := ""
			if len(f) > 4 {
				description = strings.Join(f[4:], " ")
			}
			units[name] = row{name, f[1], f[2], f[3], description, "—"}
		}
	}
	out, _ = commandOutput(30*time.Second, false, "systemctl", "list-unit-files", "--type=service", "--no-legend", "--no-pager")
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 {
			if r, ok := units[f[0]]; ok {
				r.Enabled = f[1]
				units[f[0]] = r
			} else if !strings.Contains(f[0], "@") {
				units[f[0]] = row{f[0], "loaded", "inactive", "dead", "", f[1]}
			}
		}
	}
	rows := make([]row, 0, len(units))
	for _, r := range units {
		rows = append(rows, r)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Name < rows[j].Name })
	return map[string]any{"available": true, "entries": rows}, nil
}
func serviceAction(p map[string]any) (any, error) {
	if os.Geteuid() != 0 {
		return nil, errors.New("此操作需要 Root 权限")
	}
	name, err := serviceName(p)
	if err != nil {
		return nil, err
	}
	action, _ := p["action"].(string)
	switch action {
	case "start", "stop", "restart", "reload", "enable", "disable":
	default:
		return nil, errors.New("无效服务操作")
	}
	out, err := commandOutput(90*time.Second, true, "systemctl", action, name)
	if err != nil {
		return nil, err
	}
	return map[string]any{"output": out}, nil
}

func networkInfo() (any, error) {
	var interfaces any = []any{}
	if _, err := exec.LookPath("ip"); err == nil {
		out, err := commandOutput(30*time.Second, true, "ip", "-j", "address")
		if err == nil {
			_ = json.Unmarshal([]byte(out), &interfaces)
		}
	}
	ports := make([]map[string]any, 0)
	if _, err := exec.LookPath("ss"); err == nil {
		out, _ := commandOutput(30*time.Second, false, "ss", "-H", "-lntup")
		for _, line := range strings.Split(out, "\n") {
			f := strings.Fields(line)
			if len(f) >= 6 {
				address := f[4]
				portText := address[strings.LastIndex(address, ":")+1:]
				port, err := strconv.Atoi(portText)
				var number any
				if err == nil {
					number = port
				}
				process := "当前用户无权查看进程"
				if len(f) > 6 {
					process = strings.Join(f[6:], " ")
				}
				ports = append(ports, map[string]any{"protocol": f[0], "state": f[1], "address": address, "port": number, "process": process})
			}
		}
	}
	dns, _ := os.ReadFile("/etc/resolv.conf")
	return map[string]any{"interfaces": interfaces, "ports": ports, "dns": string(dns)}, nil
}
