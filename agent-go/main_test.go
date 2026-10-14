package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestControlRequiresSessionToken(t *testing.T) {
	s := &session{token: "test-secret"}
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:12345/v1/meta", nil)
	request.RemoteAddr = "127.0.0.1:1234"
	response := httptest.NewRecorder()
	s.handler().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("missing token: %d", response.Code)
	}
	request.Header.Set("Authorization", "Bearer test-secret")
	response = httptest.NewRecorder()
	s.handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("valid token: %d %s", response.Code, response.Body.String())
	}
	request.Header.Set("Origin", "https://example.com")
	response = httptest.NewRecorder()
	s.handler().ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("foreign origin: %d", response.Code)
	}
}

func TestProxyUsesLinuxSideHTTPClient(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(201)
		_, _ = w.Write([]byte("through proxy"))
	}))
	defer target.Close()
	request := httptest.NewRequest(http.MethodGet, target.URL, nil)
	request.RemoteAddr = "127.0.0.1:1234"
	response := httptest.NewRecorder()
	proxyHandler(response, request)
	if response.Code != 201 || response.Body.String() != "through proxy" {
		t.Fatalf("proxy: %d %q", response.Code, response.Body.String())
	}
}
