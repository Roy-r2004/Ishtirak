package main

import (
 "net/http"
 "net/http/httptest"
 "strings"
 "testing"
)

func TestDemoControlsRejectUnsafeRequests(t *testing.T){
 t.Setenv("ENABLE_DEMO","true")
 tests:=[]struct{name,body,origin string;want int}{
  {"unknown container",`{"service":"unrelated-database","action":"stop"}`,"",400},
  {"arbitrary action",`{"service":"coordinator1","action":"exec"}`,"",400},
  {"cross origin",`{"service":"coordinator1","action":"stop"}`,"http://attacker.example",403},
 }
 for _,tc:=range tests{t.Run(tc.name,func(t *testing.T){r:=httptest.NewRequest("POST","http://localhost:8088/api/actions",strings.NewReader(tc.body));r.Header.Set("Content-Type","application/json");r.Header.Set("Origin",tc.origin);w:=httptest.NewRecorder();action(w,r);if w.Code!=tc.want{t.Fatalf("got %d want %d",w.Code,tc.want)}})}
}
func TestDemoControlChecksContainerOwnership(t *testing.T){
 t.Setenv("ENABLE_DEMO","true")
 old:=docker;defer func(){docker=old}()
 called:=false
 mock:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){if strings.HasSuffix(r.URL.Path,"/json"){_,_=w.Write([]byte(`{"Config":{"Labels":{"com.docker.compose.project":"another-project","com.docker.compose.service":"coordinator1"}}}`));return};called=true;w.WriteHeader(204)}));defer mock.Close()
 docker=&http.Client{Transport:roundTripFunc(func(r *http.Request)(*http.Response,error){r.URL.Scheme="http";r.URL.Host=strings.TrimPrefix(mock.URL,"http://");return http.DefaultTransport.RoundTrip(r)})}
 r:=httptest.NewRequest("POST","/api/actions",strings.NewReader(`{"service":"coordinator1","action":"stop"}`));r.Header.Set("Content-Type","application/json");w:=httptest.NewRecorder();action(w,r)
 if w.Code!=403||called{t.Fatalf("ownership bypass: code %d action called %v",w.Code,called)}
}
type roundTripFunc func(*http.Request)(*http.Response,error)
func(f roundTripFunc)RoundTrip(r *http.Request)(*http.Response,error){return f(r)}
