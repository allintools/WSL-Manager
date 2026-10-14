package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

const textLimit = 2 * 1024 * 1024
const transferLimit = 64 * 1024 * 1024

func pathParam(p map[string]any, key string) (string, error) {
	value, ok := p[key].(string)
	if !ok || !filepath.IsAbs(value) || strings.ContainsRune(value, 0) {
		return "", errors.New("请输入绝对 Linux 路径")
	}
	return filepath.Clean(value), nil
}

func fsList(p map[string]any) (any, error) {
	path, err := pathParam(p, "path")
	if err != nil {
		return nil, err
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, err
	}
	if len(entries) > 10000 {
		return nil, errors.New("目录超过 10000 项，请使用终端查看")
	}
	rows := make([]map[string]any, 0, len(entries))
	for _, entry := range entries {
		full := filepath.Join(path, entry.Name())
		info, err := os.Lstat(full)
		if err != nil {
			continue
		}
		isLink := info.Mode()&os.ModeSymlink != 0
		isDir := info.IsDir()
		if isLink {
			if target, e := os.Stat(full); e == nil {
				isDir = target.IsDir()
			}
		}
		uid, gid := owner(info)
		rows = append(rows, map[string]any{"name": entry.Name(), "path": full, "isDir": isDir, "isLink": isLink, "size": info.Size(), "modified": float64(info.ModTime().UnixNano()) / 1e9, "mode": info.Mode().String(), "uid": uid, "gid": gid})
	}
	sort.Slice(rows, func(i, j int) bool {
		a, b := rows[i], rows[j]
		if a["isDir"].(bool) != b["isDir"].(bool) {
			return a["isDir"].(bool)
		}
		return strings.ToLower(a["name"].(string)) < strings.ToLower(b["name"].(string))
	})
	return map[string]any{"path": path, "entries": rows}, nil
}

func fileVersion(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}
func regular(path string) (os.FileInfo, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("此操作仅支持普通文件")
	}
	return info, nil
}

func fsRead(p map[string]any) (any, error) {
	path, err := pathParam(p, "path")
	if err != nil {
		return nil, err
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		return nil, err
	}
	info, err := regular(path)
	if err != nil {
		return nil, err
	}
	binary, _ := p["binary"].(bool)
	limit := int64(textLimit)
	if binary {
		limit = transferLimit
	}
	if info.Size() > limit {
		return nil, errors.New("文件超过大小限制（编辑 2 MB，传输 64 MB）")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("文件超过大小限制")
	}
	if binary {
		return map[string]any{"path": path, "data": base64.StdEncoding.EncodeToString(data)}, nil
	}
	if !utf8.Valid(data) || strings.ContainsRune(string(data), 0) {
		return nil, errors.New("二进制或非 UTF-8 文件不能在文本编辑器中打开")
	}
	return map[string]any{"path": path, "content": string(data), "version": fileVersion(data)}, nil
}

func fsWrite(p map[string]any) (any, error) {
	path, err := pathParam(p, "path")
	if err != nil {
		return nil, err
	}
	var data []byte
	if encoded, ok := p["data"].(string); ok {
		data, err = base64.StdEncoding.Strict().DecodeString(encoded)
		if err != nil {
			return nil, errors.New("上传内容不是有效 Base64")
		}
	} else {
		content, ok := p["content"].(string)
		if !ok {
			return nil, errors.New("缺少文件内容")
		}
		data = []byte(content)
	}
	if len(data) > transferLimit {
		return nil, errors.New("文件超过 64 MB")
	}
	info, err := os.Lstat(path)
	exists := err == nil
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if exists {
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("路径现在是符号链接，请重新打开文件")
		}
		if !info.Mode().IsRegular() {
			return nil, errors.New("此操作仅支持普通文件")
		}
		version, ok := p["version"].(string)
		if !ok || version == "" {
			return nil, errors.New("文件已存在，请重新读取后再保存")
		}
		current, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		if fileVersion(current) != version {
			return nil, errors.New("文件已在外部修改，请重新读取后再保存")
		}
	}
	parent := filepath.Dir(path)
	tmp, err := os.CreateTemp(parent, ".linuxdesk-*")
	if err != nil {
		return nil, err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if exists {
		if err = tmp.Chmod(info.Mode().Perm()); err != nil {
			tmp.Close()
			return nil, err
		}
		if err = preserveOwnerAndAttrs(path, tmpPath, info); err != nil {
			tmp.Close()
			return nil, err
		}
	}
	if _, err = tmp.Write(data); err != nil {
		tmp.Close()
		return nil, err
	}
	if err = tmp.Sync(); err != nil {
		tmp.Close()
		return nil, err
	}
	if err = tmp.Close(); err != nil {
		return nil, err
	}
	if exists {
		current, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		if fileVersion(current) != p["version"] {
			return nil, errors.New("保存期间文件发生变化，请重新读取")
		}
		if info, err = os.Lstat(path); err != nil || info.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("保存期间路径发生变化，请重新读取")
		}
		if err = os.Rename(tmpPath, path); err != nil {
			return nil, err
		}
	} else {
		if err = os.Link(tmpPath, path); err != nil {
			return nil, fmt.Errorf("文件已存在或无法创建：%w", err)
		}
		if err = os.Remove(tmpPath); err != nil {
			return nil, err
		}
	}
	if dir, err := os.Open(parent); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return map[string]any{"path": path, "version": fileVersion(data)}, nil
}

func fsMkdir(p map[string]any) (any, error) {
	path, err := pathParam(p, "path")
	if err != nil {
		return nil, err
	}
	if err = os.Mkdir(path, 0755); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}
func fsMove(p map[string]any) (any, error) {
	source, err := pathParam(p, "path")
	if err != nil {
		return nil, err
	}
	dest, err := pathParam(p, "destination")
	if err != nil {
		return nil, err
	}
	if source == "/" {
		return nil, errors.New("不能移动根目录")
	}
	if err = renameNoReplace(source, dest); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}
func fsCopy(p map[string]any) (any, error) {
	source, err := pathParam(p, "path")
	if err != nil {
		return nil, err
	}
	dest, err := pathParam(p, "destination")
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(source)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("目前只支持复制普通文件")
	}
	input, err := os.Open(source)
	if err != nil {
		return nil, err
	}
	defer input.Close()
	tmp, err := os.CreateTemp(filepath.Dir(dest), ".linuxdesk-copy-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp.Name())
	if err = tmp.Chmod(info.Mode().Perm()); err != nil {
		tmp.Close()
		return nil, err
	}
	if err = preserveOwnerAndAttrs(source, tmp.Name(), info); err != nil {
		tmp.Close()
		return nil, err
	}
	if _, err = io.Copy(tmp, input); err != nil {
		tmp.Close()
		return nil, err
	}
	if err = tmp.Sync(); err != nil {
		tmp.Close()
		return nil, err
	}
	if err = tmp.Close(); err != nil {
		return nil, err
	}
	if err = os.Link(tmp.Name(), dest); err != nil {
		return nil, fmt.Errorf("目标已存在或无法复制：%w", err)
	}
	if dir, err := os.Open(filepath.Dir(dest)); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return map[string]any{"ok": true}, nil
}
func fsChmod(p map[string]any) (any, error) {
	path, err := pathParam(p, "path")
	if err != nil {
		return nil, err
	}
	modeText, ok := p["mode"].(string)
	if !ok || len(modeText) < 3 || len(modeText) > 4 {
		return nil, errors.New("请输入三位或四位八进制权限")
	}
	for _, c := range modeText {
		if c < '0' || c > '7' {
			return nil, errors.New("权限只能包含 0–7")
		}
	}
	mode, err := strconv.ParseUint(modeText, 8, 12)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("不修改符号链接权限")
	}
	if err = os.Chmod(path, os.FileMode(mode)); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}
func fsDelete(p map[string]any) (any, error) {
	path, err := pathParam(p, "path")
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	resolved := path
	if info.Mode()&os.ModeSymlink == 0 {
		resolved, err = filepath.EvalSymlinks(path)
		if err != nil {
			return nil, err
		}
	}
	home := os.Getenv("HOME")
	for _, protected := range []string{"/", "/home", "/etc", "/usr", "/var", home} {
		if resolved == protected || path == protected {
			return nil, errors.New("不能删除系统目录或主目录")
		}
	}
	if err = os.Remove(path); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}
