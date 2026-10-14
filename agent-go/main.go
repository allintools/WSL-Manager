// linuxdesk-agent exposes Linux capabilities to one local manager session.
// It needs no daemon, systemd unit, or third-party packages.
package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const version = "0.2.0"

type session struct {
	token         string
	started       time.Time
	mu            sync.Mutex
	lastCPU       [2]uint64
	lastAt        time.Time
	lastCores     map[string][2]uint64
	lastNet       [2]uint64
	lastMetricsAt time.Time
	lastProcs     map[string]processSample
}

type handshake struct {
	Protocol  int    `json:"protocol"`
	Version   string `json:"version"`
	Port      int    `json:"port"`
	ProxyPort int    `json:"proxyPort"`
	Token     string `json:"token"`
	PID       int    `json:"pid"`
}

func main() {
	serve := flag.Bool("serve", false, "serve one local manager session")
	showVersion := flag.Bool("version", false, "print version")
	once := flag.Bool("once", false, "run one RPC request from stdin")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}
	if *once {
		var req rpcRequest
		if err := json.NewDecoder(io.LimitReader(os.Stdin, 90*1024*1024)).Decode(&req); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if req.Params == nil {
			req.Params = map[string]any{}
		}
		result, err := (&session{}).dispatch(req.Method, req.Params)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if err = json.NewEncoder(os.Stdout).Encode(map[string]any{"result": result}); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if !*serve {
		fmt.Fprintln(os.Stderr, "use --serve or --version")
		os.Exit(2)
	}
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return err
	}
	s := &session{token: hex.EncodeToString(secret), started: time.Now()}
	control, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer control.Close()
	proxy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer proxy.Close()
	controlServer := &http.Server{Handler: s.handler(), ReadHeaderTimeout: 5 * time.Second}
	proxyServer := &http.Server{Handler: http.HandlerFunc(proxyHandler), ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = controlServer.Serve(control) }()
	go func() { _ = proxyServer.Serve(proxy) }()
	info := handshake{Protocol: 1, Version: version, Port: control.Addr().(*net.TCPAddr).Port,
		ProxyPort: proxy.Addr().(*net.TCPAddr).Port, Token: s.token, PID: os.Getpid()}
	if err := json.NewEncoder(os.Stdout).Encode(info); err != nil {
		return err
	}
	// The parent keeps stdin open for the lifetime of the session.
	_, _ = io.Copy(io.Discard, os.Stdin)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = controlServer.Shutdown(ctx)
	_ = proxyServer.Shutdown(ctx)
	return nil
}

func (s *session) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/meta", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", 405)
			return
		}
		u, _ := user.Current()
		name, home := "", os.Getenv("HOME")
		if u != nil {
			name = u.Username
			if home == "" {
				home = u.HomeDir
			}
		}
		writeJSON(w, map[string]any{"protocol": 1, "version": version, "os": osRelease(), "arch": runtime.GOARCH,
			"user": name, "home": home, "root": os.Geteuid() == 0, "systemd": isDir("/run/systemd/system"),
			"packageManager": packageManager(), "uptimeSeconds": int(time.Since(s.started).Seconds())})
	})
	mux.HandleFunc("/v1/system", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", 405)
			return
		}
		writeJSON(w, s.system())
	})
	mux.HandleFunc("/v1/processes", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", 405)
			return
		}
		writeJSON(w, s.processList())
	})
	mux.HandleFunc("/v1/rpc", s.rpc)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, hostErr := net.SplitHostPort(r.Host)
		if !isLoopback(r.RemoteAddr) || hostErr != nil || host != "127.0.0.1" {
			// net/http validates Host syntax; deny DNS rebinding and remote peers.
			http.Error(w, "forbidden", 403)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			http.Error(w, "origin forbidden", 403)
			return
		}
		provided := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if subtle.ConstantTimeCompare([]byte(provided), []byte(s.token)) != 1 {
			http.Error(w, "unauthorized", 401)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		mux.ServeHTTP(w, r)
	})
}

func isLoopback(remote string) bool {
	host, _, err := net.SplitHostPort(remote)
	return err == nil && net.ParseIP(host).IsLoopback()
}

func writeJSON(w http.ResponseWriter, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		http.Error(w, "serialization failed", 500)
		return
	}
	data = append(data, '\n')
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	_, _ = w.Write(data)
}

func osRelease() string {
	b, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return "Linux"
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "PRETTY_NAME=") {
			return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), "\"'")
		}
	}
	return "Linux"
}

func isDir(path string) bool { info, err := os.Stat(path); return err == nil && info.IsDir() }

func packageManager() string {
	for _, name := range []string{"apt-get", "dnf", "pacman", "apk", "zypper"} {
		if _, err := exec.LookPath(name); err == nil {
			return name
		}
	}
	return ""
}

func (s *session) system() map[string]any {
	mem := map[string]uint64{}
	if b, err := os.ReadFile("/proc/meminfo"); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			f := strings.Fields(line)
			if len(f) >= 2 {
				n, _ := strconv.ParseUint(f[1], 10, 64)
				mem[strings.TrimSuffix(f[0], ":")] = n * 1024
			}
		}
	}
	uptime := 0.0
	if b, err := os.ReadFile("/proc/uptime"); err == nil {
		if fields := strings.Fields(string(b)); len(fields) > 0 {
			uptime, _ = strconv.ParseFloat(fields[0], 64)
		}
	}
	cpu := s.cpu()
	return map[string]any{"cpu": cpu, "memory": map[string]uint64{"total": mem["MemTotal"], "available": mem["MemAvailable"], "used": mem["MemTotal"] - mem["MemAvailable"], "swapTotal": mem["SwapTotal"], "swapUsed": mem["SwapTotal"] - mem["SwapFree"]},
		"uptime": uptime, "processCount": len(processes()), "time": time.Now().UnixMilli()}
}

func (s *session) cpu() *float64 {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return nil
	}
	f := strings.Fields(strings.SplitN(string(b), "\n", 2)[0])
	if len(f) < 5 {
		return nil
	}
	total, idle := uint64(0), uint64(0)
	for i := 1; i < len(f); i++ {
		n, _ := strconv.ParseUint(f[i], 10, 64)
		total += n
		if i == 4 || i == 5 {
			idle += n
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	old := s.lastCPU
	s.lastCPU = [2]uint64{total, idle}
	s.lastAt = time.Now()
	if old[0] == 0 || total <= old[0] {
		return nil
	}
	v := 100 * float64((total-old[0])-(idle-old[1])) / float64(total-old[0])
	return &v
}

type processInfo struct {
	PID     int      `json:"pid"`
	PPID    int      `json:"ppid"`
	Name    string   `json:"name"`
	Command string   `json:"command"`
	RSS     uint64   `json:"rss"`
	User    string   `json:"user"`
	CPU     *float64 `json:"cpu"`
	State   string   `json:"state"`
	Start   string   `json:"start"`
	Threads int      `json:"threads"`
	Ticks   uint64   `json:"-"`
}

func processes() []processInfo {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return []processInfo{}
	}
	result := make([]processInfo, 0, 100)
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		status, err := os.ReadFile("/proc/" + e.Name() + "/status")
		if err != nil {
			continue
		}
		p := processInfo{PID: pid}
		if stat, err := os.ReadFile("/proc/" + e.Name() + "/stat"); err == nil {
			if end := strings.LastIndex(string(stat), ")"); end >= 0 {
				fields := strings.Fields(string(stat)[end+1:])
				if len(fields) > 19 {
					p.State = fields[0]
					p.PPID, _ = strconv.Atoi(fields[1])
					p.Start = fields[19]
					ut, _ := strconv.ParseUint(fields[11], 10, 64)
					st, _ := strconv.ParseUint(fields[12], 10, 64)
					p.Ticks = ut + st
				}
			}
		}
		for _, line := range strings.Split(string(status), "\n") {
			f := strings.Fields(line)
			if len(f) < 2 {
				continue
			}
			switch f[0] {
			case "Name:":
				p.Name = f[1]
			case "VmRSS:":
				n, _ := strconv.ParseUint(f[1], 10, 64)
				p.RSS = n * 1024
			case "Uid:":
				u, err := user.LookupId(f[1])
				if err == nil {
					p.User = u.Username
				} else {
					p.User = f[1]
				}
			case "Threads:":
				p.Threads, _ = strconv.Atoi(f[1])
			}
		}
		cmd, _ := os.ReadFile("/proc/" + e.Name() + "/cmdline")
		p.Command = strings.TrimSpace(strings.ReplaceAll(string(cmd), "\x00", " "))
		result = append(result, p)
	}
	return result
}

// proxyHandler only accepts loopback clients. The random proxy port belongs to
// this manager session; no listener is exposed on a network interface.
func proxyHandler(w http.ResponseWriter, r *http.Request) {
	if !isLoopback(r.RemoteAddr) {
		http.Error(w, "forbidden", 403)
		return
	}
	if r.Method == http.MethodConnect {
		connectTunnel(w, r)
		return
	}
	if r.URL.Scheme != "http" || r.URL.Host == "" {
		http.Error(w, "invalid proxy request", 400)
		return
	}
	copyReq := r.Clone(r.Context())
	copyReq.RequestURI = ""
	copyReq.Header.Del("Proxy-Connection")
	transport := http.Transport{Proxy: nil, DisableKeepAlives: true, ResponseHeaderTimeout: 30 * time.Second}
	defer transport.CloseIdleConnections()
	response, err := transport.RoundTrip(copyReq)
	if err != nil {
		http.Error(w, err.Error(), 502)
		return
	}
	defer response.Body.Close()
	for k, values := range response.Header {
		for _, value := range values {
			w.Header().Add(k, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, response.Body)
}

func connectTunnel(w http.ResponseWriter, r *http.Request) {
	address := r.Host
	if !strings.Contains(address, ":") {
		address = net.JoinHostPort(address, "443")
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil || host == "" || port == "" {
		http.Error(w, "invalid address", 400)
		return
	}
	upstream, err := net.DialTimeout("tcp", address, 15*time.Second)
	if err != nil {
		http.Error(w, err.Error(), 502)
		return
	}
	defer upstream.Close()
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "tunnel unsupported", 500)
		return
	}
	client, buffer, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer client.Close()
	_, _ = buffer.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
	if err = buffer.Flush(); err != nil {
		return
	}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, _ = io.Copy(upstream, client)
		if tcp, ok := upstream.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
	}()
	_, _ = io.Copy(client, upstream)
	_ = client.Close()
	wg.Wait()
}
