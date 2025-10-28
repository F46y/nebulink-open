package mastodon

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
)

type AppRegistrationRequest struct {
	InstanceDomain string `json:"instance_domain"`
}

type AppRegistrationResponse struct {
	ClientID              string   `json:"client_id"`
	ClientSecret          string   `json:"client_secret"`
	RedirectURIs          []string `json:"redirect_uris"`
	Scopes                []string `json:"scopes"`
	ClientSecretExpiresAt int64    `json:"client_secret_expires_at"`
}

func AuthNebuLinkHandler(w http.ResponseWriter, r *http.Request, logger *log.Logger) {
	instanceDomain, err := parseInstanceDomain(r)
	if err != nil || instanceDomain == "" {
		http.Error(w, "Invalid request: missing instance_domain", http.StatusBadRequest)
		return
	}

	// If we already have credentials for this domain, use them; otherwise register
	mastodonMu.RLock()
	entry, ok := mastodonServers[instanceDomain]
	mastodonMu.RUnlock()

	// Generate state and build authorize URL
	state, err := genState()
	if err != nil {
		http.Error(w, "failed to generate state", http.StatusInternalServerError)
		return
	}

	if !ok {
		// Register the app with the instance
		instanceURL := fmt.Sprintf("https://%s/api/v1/apps", instanceDomain)

		payload := map[string]interface{}{
			"client_name":   "Nebulink Client",
			"redirect_uris": getCallbackURL(),
			"scopes":        "read write push admin:read admin:write",
			"website":       getBaseURL(),
		}

		body, _ := json.Marshal(payload)
		resp, err := http.Post(instanceURL, "application/json", bytes.NewBuffer(body))
		if err != nil {
			http.Error(w, "Failed to register app", http.StatusInternalServerError)
			return
		}

		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			http.Error(w, "Instance rejected registration", resp.StatusCode)
			return
		}
		var appResp AppRegistrationResponse
		if err := json.NewDecoder(resp.Body).Decode(&appResp); err != nil {
			http.Error(w, "Failed to parse response", http.StatusInternalServerError)
			return
		}

		// Persist the newly registered client id/secret for future reuse
		mastodonMu.Lock()
		mastodonServers[instanceDomain] = ServerEntry{
			Domain: instanceDomain,
			ID:     appResp.ClientID,
			Secret: appResp.ClientSecret,
		}

		_ = SaveMastodonServers()
		mastodonMu.Unlock()

		entry = mastodonServers[instanceDomain]

	}

	oauthStatesMu.Lock()
	oauthStates[state] = instanceDomain
	oauthStatesMu.Unlock()

	authorizeURL := fmt.Sprintf("https://%s/oauth/authorize?client_id=%s&redirect_uri=%s&response_type=code&scope=read+write+push&state=%s", instanceDomain, url.QueryEscape(entry.ID), url.QueryEscape(getCallbackURL()), url.QueryEscape(state))

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"authorize_url": authorizeURL})
}

// Helper to parse instance_domain from form or JSON
func parseInstanceDomain(r *http.Request) (string, error) {
	ct := r.Header.Get("Content-Type")
	if strings.HasPrefix(ct, "application/x-www-form-urlencoded") {
		if err := r.ParseForm(); err != nil {
			return "", err
		}
		return r.FormValue("instance_domain"), nil
	}
	// Try JSON
	var req AppRegistrationRequest
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return "", err
	}
	if len(body) == 0 {
		return "", nil
	}
	if err := json.Unmarshal(body, &req); err != nil {
		return "", err
	}

	return req.InstanceDomain, nil
}

func getBaseURL() string {
	if os.Getenv("ENV") == "development" {
		return "https://nebulink.localhost:3737"
	}
	return "https://nebulink.galacticapps.studio"
}

func getCallbackURL() string {
	url := getBaseURL() + "/callback"

	return url
}

// ServerEntry represents a saved mastodon server app registration
type ServerEntry struct {
	Domain string `json:"domain"`
	ID     string `json:"id"`
	Secret string `json:"secret"`
}

var (
	mastodonServers = make(map[string]ServerEntry)
	mastodonMu      sync.RWMutex
	oauthStates     = make(map[string]string) // state -> instanceDomain
	oauthStatesMu   sync.RWMutex
)

// LoadMastodonServers reads the JSON file and populates the mastodonServers map
func LoadMastodonServers() error {
	data, err := os.ReadFile(os.Getenv("MASTODON_STORE_PATH"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil // no file yet
		}
		return err
	}
	var list []ServerEntry
	if err := json.Unmarshal(data, &list); err != nil {
		return err
	}
	mastodonMu.Lock()
	defer mastodonMu.Unlock()
	for _, e := range list {
		mastodonServers[e.Domain] = e
	}
	return nil
}

// SaveMastodonServers writes the current map to the JSON file
func SaveMastodonServers() error {
	list := make([]ServerEntry, 0, len(mastodonServers))
	for _, e := range mastodonServers {
		list = append(list, e)
	}
	data, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(os.Getenv("MASTODON_STORE_PATH"), data, 0644)
}

// genState returns a cryptographically random hex string
func genState() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// OauthCallbackHandler exchanges code for token using stored client_id/secret
func OauthCallbackHandler(w http.ResponseWriter, r *http.Request, logger *log.Logger) {
	q := r.URL.Query()
	code := q.Get("code")
	state := q.Get("state")
	if code == "" || state == "" {
		http.Error(w, "missing code or state", http.StatusBadRequest)
		return
	}

	// Lookup which instance this state belongs to
	oauthStatesMu.RLock()
	instance, ok := oauthStates[state]

	oauthStatesMu.RUnlock()
	if !ok {
		http.Error(w, "invalid state", http.StatusBadRequest)
		return
	}

	// Must have client credentials for this instance
	mastodonMu.RLock()
	entry, ok := mastodonServers[instance]
	mastodonMu.RUnlock()
	if !ok {
		http.Error(w, "server registration missing", http.StatusInternalServerError)
		return
	}

	// Exchange code for token at instance /oauth/token
	tokenURL := fmt.Sprintf("https://%s/oauth/token", instance)
	data := url.Values{}
	data.Set("grant_type", "authorization_code")
	data.Set("client_id", entry.ID)
	data.Set("client_secret", entry.Secret)
	data.Set("redirect_uri", getCallbackURL())
	data.Set("code", code)

	resp, err := http.Post(tokenURL, "application/x-www-form-urlencoded", strings.NewReader(data.Encode()))
	if err != nil {
		http.Error(w, "token exchange failed", http.StatusInternalServerError)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		http.Error(w, "token exchange rejected", resp.StatusCode)
		return
	}

	var tok map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&tok); err != nil {
		http.Error(w, "failed to parse token response", http.StatusInternalServerError)
		return
	}

	accessToken, ok := tok["access_token"].(string)
	if !ok {
		http.Error(w, "invalid access token", http.StatusInternalServerError)
		return
	}

	// Return HTML page that posts token back to the opener window
	html := fmt.Sprintf(`<!DOCTYPE html>
<html>
<head>
    <title>Authentication Success</title>
</head>
<body style="background: #20202c; color: #ffffff; font-family: 'samsung-reg', sans-serif; text-align: center; padding-top: 50px;">
    <h1>Authentication Successful</h1>
    <p>Redirecting...</p>
    <script> 
        const token = %q;
        const instance = %q;
        const channel = new BroadcastChannel('auth_channel');
        channel.postMessage({ type: 'oauth_token', access_token: token });
        setTimeout(() => window.close(), 200);
    </script>
</body>
</html>`, accessToken, instance)

	w.Header().Set("Content-Type", "text/html")
	_, _ = w.Write([]byte(html))
}
