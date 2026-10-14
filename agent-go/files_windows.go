//go:build windows

package main

import (
	"errors"
	"os"
)

func owner(os.FileInfo) (uint32, uint32)                      { return 0, 0 }
func preserveOwnerAndAttrs(string, string, os.FileInfo) error { return nil }
func renameNoReplace(string, string) error                    { return errors.New("Linux only") }
func signalProcess(map[string]any) (any, error)               { return nil, errors.New("Linux only") }
