package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type titleTransport func(*http.Request) (*http.Response, error)

func (f titleTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func metadataClient(fn titleTransport) *http.Client {
	c := *youtubeMetadataHTTP
	c.Transport = fn
	return &c
}
func metadataResponse(code int, body string) *http.Response {
	return &http.Response{StatusCode: code, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}
func TestYouTubeTitleCacheIsBoundedAndUsesCurrentVideo(t *testing.T) {
	calls := 0
	cache := youtubeTitleCache{client: metadataClient(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Scheme != "https" || r.URL.Host != "www.youtube.com" || r.URL.Path != "/oembed" || r.Header.Get("Cookie") != "" {
			t.Fatal("unexpected metadata request")
		}
		video := r.URL.Query().Get("url")
		if !strings.HasPrefix(video, "https://www.youtube.com/watch?v=") || !youtubeIDPattern.MatchString(strings.TrimPrefix(video, "https://www.youtube.com/watch?v=")) {
			t.Fatal("unexpected video", video)
		}
		if strings.HasSuffix(video, "=-abcdefghij") {
			return metadataResponse(200, `{"title":"Different video title"}`), nil
		}
		return metadataResponse(200, `{"title":" Correct title "}`), nil
	})}
	for i := 0; i < 3; i++ {
		if got := cache.title(context.Background(), "abcdefghijk"); got != "Correct title" {
			t.Fatal(got)
		}
	}
	if calls != 1 {
		t.Fatal("not cached", calls)
	}
	if got := cache.title(context.Background(), "-abcdefghij"); got != "Different video title" {
		t.Fatal("new video kept old title", got)
	}
	if calls != 2 {
		t.Fatal("new video not looked up")
	}
	for _, id := range []string{"", "short", "https://example.com", "abcdefghij;"} {
		if cache.title(context.Background(), id) != "" {
			t.Fatal("invalid ID returned a title")
		}
	}
	if calls != 2 {
		t.Fatal("invalid ID made a request")
	}
	for i := 0; i < 20; i++ {
		cache.title(context.Background(), fmt.Sprintf("%011d", i))
	}
	if len(cache.entries) > 16 {
		t.Fatal("unbounded cache")
	}
}
func TestYouTubeMetadataFailuresDoNotReturnPreviousTitleOrFlood(t *testing.T) {
	calls := 0
	cache := youtubeTitleCache{client: metadataClient(func(r *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			return metadataResponse(200, `{"title":"Previous video"}`), nil
		}
		response := metadataResponse(302, "")
		response.Header.Set("Location", "https://example.com/must-not-follow")
		return response, nil
	})}
	cache.title(context.Background(), "abcdefghijk")
	for i := 0; i < 3; i++ {
		if cache.title(context.Background(), "-abcdefghij") != "" {
			t.Fatal("stale title leaked")
		}
	}
	if calls != 2 {
		t.Fatal("failure not cached or redirect followed", calls)
	}
	cache.entries["-abcdefghij"] = cachedYouTubeTitle{until: time.Now().Add(-time.Second)}
	cache.title(context.Background(), "-abcdefghij")
	if calls != 3 {
		t.Fatal("failed lookup never retried")
	}
}
func TestYouTubeStateFillsMissingTVTitle(t *testing.T) {
	for _, test := range []struct {
		name, title string
		active      bool
		want        string
		calls       int
	}{
		{"missing", "", true, "Public video title", 1},
		{"native", "Native title", true, "Native title", 0},
		{"idle", "", false, "", 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			helper := filepath.Join(t.TempDir(), "youtube-control")
			body := fmt.Sprintf(`{"id":"youtube","available":true,"active":%t,"video_id":"abcdefghijk","title":%q}`, test.active, test.title)
			if err := os.WriteFile(helper, []byte("#!/bin/sh\nprintf '%s' '"+body+"'\n"), 0700); err != nil {
				t.Fatal(err)
			}
			calls := 0
			c := systemController{youtubeCommand: helper, youtubeTitles: youtubeTitleCache{client: metadataClient(func(*http.Request) (*http.Response, error) {
				calls++
				return metadataResponse(200, `{"title":"Public video title"}`), nil
			})}}
			state := c.youtube(context.Background())
			if !state.Available || state.Title != test.want || calls != test.calls {
				t.Fatalf("state=%+v calls=%d", state, calls)
			}
		})
	}
}
