package middleware

import (
	"net"
	"net/http"
	"strings"
)

func GetClientIP(r *http.Request) string {
	ip := r.Header.Get("X-Forwarded-For")
	if ip != "" {
		ips := strings.Split(ip, ",")
		return strings.TrimSpace(ips[0])
	}
	ip, _, _ = net.SplitHostPort(r.RemoteAddr)
	return ip
}

func RestrictByIP(allowedIP string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clientIP := GetClientIP(r)
		if clientIP != allowedIP {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}
