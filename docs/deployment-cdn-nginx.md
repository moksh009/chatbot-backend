# CDN / reverse proxy (gzip, caching)

## Nginx (example)

Place TLS termination and compression **in front of** Node when possible:

```nginx
gzip on;
gzip_types application/json application/javascript text/css image/svg+xml;
gzip_min_length 1024;

location /public/ {
    alias /var/www/app/public/;
    expires 1d;
    add_header Cache-Control "public, max-age=86400";
}

location /api/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Express already uses **`compression`** for JSON; nginx gzip is optional and should not double-break encodings.

## Static dashboard assets

Build the Vite dashboard with hashed filenames; serve `dist/` via CDN or nginx with long cache. After deploy, old HTML pointing at old chunks is handled by your existing lazy-load retry in `App.jsx`.

## Health and metrics

Do **not** cache **`/api/health`** or **`/api/metrics/summary`** at the CDN (they send `Cache-Control: no-store` for health).
