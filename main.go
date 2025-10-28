package main

import (
	"bytes"
	"embed"
	"encoding/json"
	"io"

	"fmt"
	"galacticApps/mastodon"
	"html/template"

	"io/fs"
	"log"
	"mime"
	"net/http"
	"sync"
	"time"

	"os"
	"path/filepath"
	"strings"

	"github.com/tdewolff/minify/v2"
	"github.com/tdewolff/minify/v2/css"
	htmlm "github.com/tdewolff/minify/v2/html"
	"github.com/tdewolff/minify/v2/js"
)

// The `//go:embed` directive tells the Go compiler to embed the files in
// the specified directory into the `files` variable.
//
//go:embed templates/* static/*
var files embed.FS

// SignalMessage is the JSON shape used to exchange signaling payloads between peers
type SignalMessage struct {
	Code string          `json:"code"`
	From string          `json:"from"`
	To   string          `json:"to,omitempty"`
	Type string          `json:"type"`
	Data json.RawMessage `json:"data,omitempty"`
}

// Peer represents a participant waiting in a room (in-memory)
type Peer struct {
	Name     string
	Code     string
	IP       string
	Queue    []SignalMessage
	LastSeen time.Time
}

func main() {
	// Create the minifier instance and add the CSS and JS minifiers.
	m := minify.New()
	m.AddFunc("text/css", css.Minify)
	m.AddFunc("application/javascript", js.Minify)
	m.AddFunc("application/x-javascript", js.Minify)
	m.AddFunc("text/javascript", js.Minify)
	m.AddFunc("text/html", htmlm.Minify)

	isDev := os.Getenv("ENV") == "development"

	logPath := os.Getenv("LOG_PATH")

	if logPath == "" {
		logPath = "app.log"
	}

	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0666)
	if err != nil {
		log.Fatal("Failed to open log file:", err)
	}

	defer logFile.Close()

	// Create a logger that writes to the file
	logger := log.New(logFile, "INFO: ", log.Ldate|log.Ltime|log.Lshortfile)

	// Load persisted mastodon server registrations
	if err := mastodon.LoadMastodonServers(); err != nil {
		logger.Println("Warning: failed to load mastodon servers:", err)
	}

	if !isDev {
		staticFS, err := fs.Sub(files, "static")
		if err != nil {
			logger.Fatal(err)
		}

		// Ensure .wasm files are served with correct MIME type
		if err := mime.AddExtensionType(".wasm", "application/wasm"); err != nil {
			// Log and continue; AddExtensionType returns an error only if the extension is invalid
			logger.Println("Warning: failed to register .wasm mime type:", err)
		}

		staticHandler := http.StripPrefix("/static/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// set security headers for static assets as well
			setSecurityHeaders(w)
			path := r.URL.Path
			ext := filepath.Ext(path)

			if strings.HasSuffix(path, ".css") || strings.HasSuffix(path, ".js") {
				file, err := staticFS.Open(path)
				if err != nil {
					http.NotFound(w, r)
					return
				}
				defer func() {
					err := file.Close()
					if err != nil {
						fmt.Println(err)
					}
				}()

				mtype := mime.TypeByExtension(ext)
				if mtype == "" {
					mtype = "text/plain"
				}
				w.Header().Set("Content-Type", mtype)

				var buf bytes.Buffer
				if err := m.Minify(mtype, &buf, file); err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				_, err = w.Write(buf.Bytes())
				if err != nil {
					fmt.Println(err)
					return
				}
				return
			}
			http.FileServer(http.FS(staticFS)).ServeHTTP(w, r)
		}))
		http.Handle("/static/", staticHandler)
	} else {
		staticHandler := func(w http.ResponseWriter, r *http.Request) {
			// set security headers for static assets in dev mode
			setSecurityHeaders(w)
			filePath := strings.TrimLeft(r.URL.Path, "/")
			http.ServeFile(w, r, filePath)
		}
		http.HandleFunc("/static/", staticHandler)
	}

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		setSecurityHeaders(w)
		subdomainRouter(w, r, logger)
	})

	http.HandleFunc("/authorize", func(w http.ResponseWriter, r *http.Request) {
		setSecurityHeaders(w)
		mastodon.AuthNebuLinkHandler(w, r, logger)
	})
	http.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		setSecurityHeaders(w)
		mastodon.OauthCallbackHandler(w, r, logger)
	})

	// Simple HTTP-based signaling endpoints for WebRTC (polling-based signaling)
	// In-memory store: rooms[code][name] -> *Peer
	var rooms = make(map[string]map[string]*Peer)
	var roomsMu sync.Mutex

	http.HandleFunc("/webrtc/join", func(w http.ResponseWriter, r *http.Request) {
		setSecurityHeaders(w)
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Name string `json:"name"`
			Code string `json:"code"`
			IP   string `json:"ip,omitempty"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if req.Code == "" || req.Name == "" {
			http.Error(w, "missing name or code", http.StatusBadRequest)
			return
		}

		roomsMu.Lock()
		defer roomsMu.Unlock()
		room := rooms[req.Code]
		if room == nil {
			room = make(map[string]*Peer)
			rooms[req.Code] = room
		}
		p := &Peer{
			Name:     req.Name,
			Code:     req.Code,
			IP:       req.IP,
			Queue:    []SignalMessage{},
			LastSeen: time.Now(),
		}
		room[req.Name] = p

		// return list of other participants
		others := []string{}
		for n := range room {
			if n != req.Name {
				others = append(others, n)
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "peers": others})
	})

	http.HandleFunc("/webrtc/signal", func(w http.ResponseWriter, r *http.Request) {
		setSecurityHeaders(w)
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var msg SignalMessage
		if err := json.NewDecoder(r.Body).Decode(&msg); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if msg.Code == "" || msg.From == "" || msg.Type == "" {
			http.Error(w, "missing fields", http.StatusBadRequest)
			return
		}

		roomsMu.Lock()
		defer roomsMu.Unlock()
		room := rooms[msg.Code]
		if room == nil {
			http.Error(w, "room not found", http.StatusNotFound)
			return
		}

		// if To specified, deliver to that participant, otherwise broadcast to others
		if msg.To != "" {
			if target, ok := room[msg.To]; ok {
				target.Queue = append(target.Queue, msg)
			} else {
				http.Error(w, "target not found", http.StatusNotFound)
				return
			}
		} else {
			for name, peer := range room {
				if name == msg.From {
					continue
				}
				peer.Queue = append(peer.Queue, msg)
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok"})
	})

	http.HandleFunc("/webrtc/poll", func(w http.ResponseWriter, r *http.Request) {
		setSecurityHeaders(w)
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		code := r.URL.Query().Get("code")
		name := r.URL.Query().Get("name")
		if code == "" || name == "" {
			http.Error(w, "missing code or name", http.StatusBadRequest)
			return
		}
		roomsMu.Lock()
		defer roomsMu.Unlock()
		room := rooms[code]
		if room == nil {
			_ = json.NewEncoder(w).Encode([]SignalMessage{})
			return
		}
		peer := room[name]
		if peer == nil {
			_ = json.NewEncoder(w).Encode([]SignalMessage{})
			return
		}
		msgs := peer.Queue
		peer.Queue = []SignalMessage{}
		peer.LastSeen = time.Now()
		_ = json.NewEncoder(w).Encode(msgs)
	})

	http.HandleFunc("/webrtc/leave", func(w http.ResponseWriter, r *http.Request) {
		setSecurityHeaders(w)
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct{ Name, Code string }
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		roomsMu.Lock()
		defer roomsMu.Unlock()
		if room := rooms[req.Code]; room != nil {
			delete(room, req.Name)
			if len(room) == 0 {
				delete(rooms, req.Code)
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok"})
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "3737"
	}
	if os.Getenv("ENV") != "development" {
		logger.Fatal(http.ListenAndServe(":"+port, nil))
	} else {
		// Check if HTTPS is enabled for local development
		useHTTPS := os.Getenv("USE_HTTPS") == "true"
		certFile := os.Getenv("CERT_FILE")
		keyFile := os.Getenv("KEY_FILE")

		if certFile == "" {
			certFile = "local/cert.pem"
		}
		if keyFile == "" {
			keyFile = "local/key.pem"
		}

		certFile = filepath.Clean(certFile)
		keyFile = filepath.Clean(keyFile)

		if useHTTPS {
			logger.Println("Starting HTTPS server on port", port)
			logger.Fatal(http.ListenAndServeTLS(":"+port, certFile, keyFile, nil))
		} else {
			logger.Println("Starting HTTP server on port", port)
			logger.Fatal(http.ListenAndServe(":"+port, nil))
		}
	}
}

func Render(filename string, data interface{}, w http.ResponseWriter) {
	// Security headers
	setSecurityHeaders(w)
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("X-Frame-Options", "DENY")

	var tmpl *template.Template
	var err error

	if os.Getenv("ENV") != "development" {
		tmpl, err = template.ParseFS(files, filename)
	} else {
		tmpl, err = template.ParseFiles(filename)
	}

	if err != nil {
		fmt.Println(err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if err := tmpl.Execute(w, data); err != nil {

		fmt.Println(err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// setSecurityHeaders sets security-related response headers required by the app.
func setSecurityHeaders(w http.ResponseWriter) {
	// Required for COEP/COOP when using cross-origin resources such as SharedArrayBuffer or certain WASM/worker patterns
	w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
	w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
}

func subdomainRouter(w http.ResponseWriter, r *http.Request, logger *log.Logger) {
	host := r.Host
	switch {
	case strings.HasPrefix(host, "nebulink."):
		nebulinkHandler(w, r, logger)
	default:
		mainHandler(w, r, logger)
	}
}

func mainHandler(w http.ResponseWriter, r *http.Request, logger *log.Logger) {
	data := make(map[string]interface{})
	data["domain"] = r.Host

	if os.Getenv("ENV") == "development" {
		if strings.HasSuffix(r.URL.String(), "test") {
			testHandler(w, r, logger)
			return
		}

		if strings.HasSuffix(r.URL.String(), "nebulink") {
			nebulinkHandler(w, r, logger)
			return
		}
	}
	Render("templates/index.gohtml", data, w)
}


func nebulinkHandler(w http.ResponseWriter, r *http.Request, logger *log.Logger) {

	if strings.Contains(r.URL.Path, "/service-worker.js") {
		w.Header().Set("Content-Type", "application/javascript")
		data, err := files.ReadFile("static/nebulink/serviceWorker.js")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(data)
		return
	} else if strings.Contains(r.URL.Path, "/apiTranslate") {
		translateHandler(w, r)
		return
	}

	Render("templates/nebuLink.gohtml", nil, w)
}

func testHandler(w http.ResponseWriter, r *http.Request, logger *log.Logger) {
	Render("templates/test.gohtml", nil, w)
}

type TranslateRequest struct {
	Text           string `json:"text"`
	TargetLanguage string `json:"targetLanguage"`
	SourceLanguage string `json:"sourceLanguage"`
}

type TranslateResponse struct {
	Success        bool   `json:"success"`
	Original       string `json:"original,omitempty"`
	Translated     string `json:"translated,omitempty"`
	TargetLanguage string `json:"targetLanguage,omitempty"`
	Error          string `json:"error,omitempty"`
}

func translateHandler(w http.ResponseWriter, r *http.Request) {

	// Enable CORS for your frontend
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Parse incoming request
	var req TranslateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	// Forward to Google Apps Script (NO CORS issues server-side!)
	scriptURL := "https://script.google.com/macros/s/AKfycbxLbYr4soXAp1yxqzmLNxE3fnG2k8iJIcTgv5zfoNwxy2vgzJpa2kgqkWTa1CEEQIekig/exec"

	reqBody, _ := json.Marshal(req)
	resp, err := http.Post(scriptURL, "application/json", bytes.NewBuffer(reqBody))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	defer resp.Body.Close()

	// Read and forward the response
	body, _ := io.ReadAll(resp.Body)

	w.Header().Set("Content-Type", "application/json")
	w.Write(body)
}
