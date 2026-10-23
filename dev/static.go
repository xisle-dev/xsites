package main

import (
	"bytes"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// reloadScript is added to every HTML page: it reloads the page when the
// dev server reports a change under server/public, or when the dev server
// itself restarts.
const reloadScript = `<script>(() => {
  let up = false;
  const es = new EventSource("/__dev/reload");
  es.onopen = () => { if (up) location.reload(); up = true; };
  es.onmessage = () => location.reload();
})();</script>`

// static serves server/public with no caching, injecting reloadScript into
// HTML.
func static(dir string) http.Handler {
	files := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		p := r.URL.Path
		if strings.HasSuffix(p, "/") {
			p += "index.html"
		}
		if !strings.HasSuffix(p, ".html") {
			files.ServeHTTP(w, r)
			return
		}
		b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(strings.TrimPrefix(p, "/"))))
		if err != nil {
			files.ServeHTTP(w, r) // redirects and 404s
			return
		}
		if i := bytes.LastIndex(b, []byte("</body>")); i >= 0 {
			b = append(b[:i:i], append([]byte(reloadScript), b[i:]...)...)
		} else {
			b = append(b, reloadScript...)
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(b)
	})
}

// reloader polls server/public for changes and tells every open page
// (via server-sent events) to reload.
type reloader struct {
	mu      sync.Mutex
	clients map[chan struct{}]bool
}

func newReloader(dir string) *reloader {
	rl := &reloader{clients: map[chan struct{}]bool{}}
	go func() {
		last := snapshot(dir)
		for range time.Tick(300 * time.Millisecond) {
			if now := snapshot(dir); now != last {
				last = now
				log.Print("server/public changed; reloading pages")
				rl.mu.Lock()
				for c := range rl.clients {
					select {
					case c <- struct{}{}:
					default:
					}
				}
				rl.mu.Unlock()
			}
		}
	}()
	return rl
}

// snapshot sums up every file's path, size and mtime under dir.
func snapshot(dir string) string {
	var b strings.Builder
	filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if info, err := d.Info(); err == nil {
				fmt.Fprintf(&b, "%s|%d|%d\n", path, info.Size(), info.ModTime().UnixNano())
			}
		}
		return nil
	})
	return b.String()
}

func (rl *reloader) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	c := make(chan struct{}, 1)
	rl.mu.Lock()
	rl.clients[c] = true
	rl.mu.Unlock()
	defer func() {
		rl.mu.Lock()
		delete(rl.clients, c)
		rl.mu.Unlock()
	}()
	for {
		select {
		case <-c:
			fmt.Fprint(w, "data: reload\n\n")
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}
