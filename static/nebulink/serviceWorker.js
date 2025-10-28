const STATIC_CACHE = "static-0.1";
const APP_CACHE = "nebulink-0.1";

self.addEventListener("install", (e) => {
    self.skipWaiting();
});

self.addEventListener("activate", (e) => {
    e.waitUntil(self.clients.claim());
});

function shouldProxyRequest(req, url) {
    return new URL(req.url).origin !== location.origin;
}

self.addEventListener("fetch", (e) => {
    const req = e.request;
    const url = new URL(req.url);


    if (!shouldProxyRequest(req, url)) {
        // normal fetch / let network handle
        return;
    }

    // Proxy: fetch upstream and return a same-origin Response.
    e.respondWith((async () => {
        const cacheName = 'media-cache-v1';

        try {
            // Check if it's a video request
            const isVideo = req.destination === 'video' ||
                url.pathname.endsWith('.mp4') ||
                url.pathname.endsWith('.webm');

            if (isVideo) {
                // Try to get from cache first
                const cache = await caches.open(cacheName);
                const cachedResponse = await cache.match(url.href, {ignoreSearch: false});

                if (cachedResponse) {
                    // Serve from cache with range support
                    return await handleRangeRequest(req, cachedResponse.clone());
                }

                // Not in cache - fetch the FULL video (ignore Range header for caching)
                // Create a new request WITHOUT the Range header to get complete video
                const fullRequest = new Request(url.href, {
                    method: 'GET',
                    headers: new Headers(),
                    mode: 'cors',
                    credentials: 'omit',
                    redirect: 'follow'
                });

                const upstreamResp = await fetch(fullRequest);

                // Only cache successful full responses (not 206)
                if (upstreamResp.status === 200 && upstreamResp.ok) {
                    // Clone and cache the full video
                    const responseToCache = upstreamResp.clone();
                    await cache.put(url.href, responseToCache);

                    // Now serve the appropriate range from the response we just got
                    if (req.headers.get('Range')) {
                        return await handleRangeRequest(req, upstreamResp);
                    }
                }

                return upstreamResp;
            }

            // Non-video requests - your existing logic
            const upstreamResp = await fetch(req, {
                credentials: "omit",
                mode: "cors",
                redirect: "follow"
            });

            const headers = new Headers(upstreamResp.headers);

            if (!headers.get("Content-Type")) {
                if (url.pathname.endsWith(".wasm")) {
                    headers.set("Content-Type", "application/wasm");
                }
            }

            headers.set("Cross-Origin-Resource-Policy", "same-origin");

            return new Response(upstreamResp.body, {
                status: upstreamResp.status,
                statusText: upstreamResp.statusText,
                headers
            });
        } catch (err) {
            console.error('Service worker fetch failed:', err);
            try {
                return await fetch(req);
            } catch (_) {
                return new Response("proxy failed", {status: 502});
            }
        }
    })());
});


async function handleRangeRequest(request, cachedResponse) {
    const rangeHeader = request.headers.get('Range');

    if (!rangeHeader) {
        // No range requested, return full cached response
        return cachedResponse;
    }

    // Get the full response body as ArrayBuffer
    const arrayBuffer = await cachedResponse.arrayBuffer();

    // Parse the Range header (e.g., "bytes=0-1023" or "bytes=1024-")
    const rangeMatch = /^bytes=(\d+)-(\d+)?$/g.exec(rangeHeader);

    if (!rangeMatch) {
        // Invalid range header format
        return new Response(null, {
            status: 416, // Range Not Satisfiable
            statusText: 'Range Not Satisfiable',
            headers: {
                'Content-Range': `*/${arrayBuffer.byteLength}`
            }
        });
    }

    const start = Number(rangeMatch[1]);
    const end = rangeMatch[2] ? Number(rangeMatch[2]) : arrayBuffer.byteLength - 1;

    // Validate range
    if (start >= arrayBuffer.byteLength || end >= arrayBuffer.byteLength || start > end) {
        return new Response(null, {
            status: 416,
            statusText: 'Range Not Satisfiable',
            headers: {
                'Content-Range': `*/${arrayBuffer.byteLength}`
            }
        });
    }

    // Slice the buffer for the requested range
    const slicedBuffer = arrayBuffer.slice(start, end + 1);

    // Build response headers
    const headers = new Headers(cachedResponse.headers);
    headers.set('Content-Length', slicedBuffer.byteLength.toString());
    headers.set('Content-Range', `bytes ${start}-${end}/${arrayBuffer.byteLength}`);
    headers.set('Accept-Ranges', 'bytes');

    return new Response(slicedBuffer, {
        status: 206,
        statusText: 'Partial Content',
        headers
    });
}