package main

import (
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type processSample struct {
	ticks uint64
	at    time.Time
}

var tickOnce sync.Once
var ticksPerSecond float64 = 100

func clockTicks() float64 {
	tickOnce.Do(func() {
		out, err := commandOutput(5*time.Second, false, "getconf", "CLK_TCK")
		if err == nil {
			if n, e := strconv.ParseFloat(strings.TrimSpace(out), 64); e == nil && n > 0 {
				ticksPerSecond = n
			}
		}
	})
	return ticksPerSecond
}

func (s *session) processList() []processInfo {
	rows := processes()
	now := time.Now()
	next := make(map[string]processSample, len(rows))
	s.mu.Lock()
	for i := range rows {
		p := &rows[i]
		key := strconv.Itoa(p.PID) + ":" + p.Start
		if old, ok := s.lastProcs[key]; ok && p.Ticks >= old.ticks && now.After(old.at) {
			v := float64(p.Ticks-old.ticks) / clockTicks() / now.Sub(old.at).Seconds() * 100
			p.CPU = &v
		}
		next[key] = processSample{p.Ticks, now}
	}
	s.lastProcs = next
	s.mu.Unlock()
	sort.Slice(rows, func(i, j int) bool {
		a, b := 0.0, 0.0
		if rows[i].CPU != nil {
			a = *rows[i].CPU
		}
		if rows[j].CPU != nil {
			b = *rows[j].CPU
		}
		if a != b {
			return a > b
		}
		return rows[i].RSS > rows[j].RSS
	})
	return rows
}

func memoryInfo() map[string]uint64 {
	result := map[string]uint64{}
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return result
	}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 {
			n, _ := strconv.ParseUint(f[1], 10, 64)
			result[strings.TrimSuffix(f[0], ":")] = n * 1024
		}
	}
	return result
}

func cpuCores() map[string][2]uint64 {
	result := map[string][2]uint64{}
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return result
	}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) < 5 || !strings.HasPrefix(f[0], "cpu") {
			continue
		}
		total, idle := uint64(0), uint64(0)
		for i := 1; i < len(f); i++ {
			n, _ := strconv.ParseUint(f[i], 10, 64)
			total += n
			if i == 4 || i == 5 {
				idle += n
			}
		}
		result[f[0]] = [2]uint64{total, idle}
	}
	return result
}

func networkBytes() [2]uint64 {
	var result [2]uint64
	b, err := os.ReadFile("/proc/net/dev")
	if err != nil {
		return result
	}
	for _, line := range strings.Split(string(b), "\n") {
		name, values, ok := strings.Cut(line, ":")
		if !ok || strings.TrimSpace(name) == "lo" {
			continue
		}
		f := strings.Fields(values)
		if len(f) < 9 {
			continue
		}
		rx, _ := strconv.ParseUint(f[0], 10, 64)
		tx, _ := strconv.ParseUint(f[8], 10, 64)
		result[0] += rx
		result[1] += tx
	}
	return result
}

func diskUsage() map[string]uint64 {
	result := map[string]uint64{"total": 0, "used": 0, "free": 0}
	out, err := commandOutput(5*time.Second, false, "df", "-B1", "--output=size,used,avail", "/")
	if err != nil {
		return result
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) < 2 {
		return result
	}
	f := strings.Fields(lines[len(lines)-1])
	if len(f) < 3 {
		return result
	}
	result["total"], _ = strconv.ParseUint(f[0], 10, 64)
	result["used"], _ = strconv.ParseUint(f[1], 10, 64)
	result["free"], _ = strconv.ParseUint(f[2], 10, 64)
	return result
}

func (s *session) metrics() map[string]any {
	now := time.Now()
	samples := cpuCores()
	mem := memoryInfo()
	net := networkBytes()
	rows := s.processList()
	s.mu.Lock()
	usage := map[string]*float64{}
	for name, sample := range samples {
		if old, ok := s.lastCores[name]; ok && sample[0] > old[0] {
			v := 100 * (1 - float64(sample[1]-old[1])/float64(sample[0]-old[0]))
			if v < 0 {
				v = 0
			}
			if v > 100 {
				v = 100
			}
			usage[name] = &v
		}
	}
	coreCount := len(samples) - 1
	if coreCount < 0 {
		coreCount = 0
	}
	cores := make([]*float64, 0, coreCount)
	for i := 0; i < len(samples)-1; i++ {
		cores = append(cores, usage["cpu"+strconv.Itoa(i)])
	}
	var rx, tx *float64
	if !s.lastMetricsAt.IsZero() {
		elapsed := now.Sub(s.lastMetricsAt).Seconds()
		if elapsed > 0 {
			if net[0] >= s.lastNet[0] {
				v := float64(net[0]-s.lastNet[0]) / elapsed
				rx = &v
			}
			if net[1] >= s.lastNet[1] {
				v := float64(net[1]-s.lastNet[1]) / elapsed
				tx = &v
			}
		}
	}
	s.lastCores = samples
	s.lastNet = net
	s.lastMetricsAt = now
	s.mu.Unlock()
	load := []float64{0, 0, 0}
	if b, err := os.ReadFile("/proc/loadavg"); err == nil {
		f := strings.Fields(string(b))
		for i := 0; i < 3 && i < len(f); i++ {
			load[i], _ = strconv.ParseFloat(f[i], 64)
		}
	}
	uptime := 0.0
	if b, err := os.ReadFile("/proc/uptime"); err == nil {
		f := strings.Fields(string(b))
		if len(f) > 0 {
			uptime, _ = strconv.ParseFloat(f[0], 64)
		}
	}
	var rss uint64
	for _, p := range rows {
		rss += p.RSS
	}
	top := rows
	if len(top) > 8 {
		top = top[:8]
	}
	return map[string]any{"time": float64(now.UnixMilli()) / 1000, "cpu": usage["cpu"], "cores": cores,
		"memory": map[string]uint64{"total": mem["MemTotal"], "used": mem["MemTotal"] - mem["MemAvailable"], "available": mem["MemAvailable"], "cached": mem["Cached"], "swapTotal": mem["SwapTotal"], "swapUsed": mem["SwapTotal"] - mem["SwapFree"]},
		"disk":   diskUsage(), "load": load, "uptime": uptime, "rx": rx, "tx": tx, "diskRead": nil, "diskWrite": nil, "processCount": len(rows), "processRss": rss, "top": top}
}
