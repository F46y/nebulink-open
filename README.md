# nebulink-open
FOSS Version of our Mastodon Web Client

## Environment Variables

Set the following environment variables to run the project:

- `ENV`: Set to `development` or `production`.
- `LOG_PATH`: Path to the log file (default: `app.log`).
- `PORT`: Port for the server (default: `3737`).
- `USE_HTTPS`: Set to `true` to enable HTTPS in development.
- `CERT_FILE`: Path to TLS certificate file (default: `local/cert.pem`).
- `KEY_FILE`: Path to TLS key file (default: `local/key.pem`).
- `MASTODON_STORE_PATH`: Path to Mastodon server registration JSON (e.g., `local/mastodon_servers.json`).

Example (Windows CMD):
```
set ENV=development
set LOG_PATH=app.log
set PORT=3737
set USE_HTTPS=true
set CERT_FILE=local/cert.pem
set KEY_FILE=local/key.pem
set MASTODON_STORE_PATH=local/mastodon_servers.json
```

## TLS Certificates

The project requires `cert.pem` and `key.pem` in the `local` directory for HTTPS. For development, generate self-signed certificates using OpenSSL:

```
openssl req -x509 -newkey rsa:4096 -keyout local/key.pem -out local/cert.pem -days 365 -nodes -subj "/CN=localhost"
```

For production, use certificates from a trusted CA (e.g., Let's Encrypt).

- `cert.pem`: Contains the public certificate.
- `key.pem`: Contains the private key.

## Notes
- Place all environment variables and certificate files as described above before running the project.
- For Mastodon integration, ensure `local/mastodon_servers.json` exists and is writable.
