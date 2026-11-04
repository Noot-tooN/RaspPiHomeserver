package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type cachedYouTubeTitle struct {
	title string
	until time.Time
}

// The TV receiver sometimes omits titles from both getVideoData and the player
// response. Look up only its validated current video ID, never a submitted URL.
// Bound the cache and retry failures slowly; status polling must not hammer
// YouTube. No account credentials or cookies are sent with these requests.
type youtubeTitleCache struct {
	mu      sync.Mutex
	entries map[string]cachedYouTubeTitle
	client  *http.Client
}

var youtubeMetadataHTTP = &http.Client{
	Timeout:       2 * time.Second,
	Transport:     &http.Transport{Proxy: nil, MaxIdleConnsPerHost: 1, IdleConnTimeout: 30 * time.Second},
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

func (c *youtubeTitleCache) title(ctx context.Context, id string) string {
	if !youtubeIDPattern.MatchString(id) {
		return ""
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if cached, ok := c.entries[id]; ok && time.Now().Before(cached.until) {
		return cached.title
	}
	client := c.client
	if client == nil {
		client = youtubeMetadataHTTP
	}
	title := ""
	endpoint := "https://www.youtube.com/oembed?format=json&url=" + url.QueryEscape("https://www.youtube.com/watch?v="+id)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err == nil {
		response, err := client.Do(req)
		if err == nil {
			defer response.Body.Close()
			if response.StatusCode == http.StatusOK {
				var data struct {
					Title string `json:"title"`
				}
				if json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&data) == nil {
					runes := []rune(strings.TrimSpace(data.Title))
					title = string(runes[:min(300, len(runes))])
				}
			}
		}
	}
	ttl := time.Minute
	if title != "" {
		ttl = 6 * time.Hour
	}
	if c.entries == nil || len(c.entries) >= 16 {
		c.entries = make(map[string]cachedYouTubeTitle)
	}
	c.entries[id] = cachedYouTubeTitle{title: title, until: time.Now().Add(ttl)}
	return title
}
