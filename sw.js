
const CACHE_NAME = "roadguard-v2";

const FILES_TO_CACHE = [
    "./",
    "./index.html",
    "./style.css",
    "./app.js",
    "./manifest.json",
    "./icons/icon-192.png",
    "./icons/icon-512.png",
    "./icons/apple-touch-icon.png"
];

// Installation
self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(FILES_TO_CACHE);
        })
    );

    self.skipWaiting();
});

// Aktivierung und alte Caches löschen
self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys
                    .filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            );
        }).then(() => self.clients.claim())
    );
});

// Dateien laden
self.addEventListener("fetch", event => {
    const request = event.request;

    if (request.method !== "GET") return;

    const url = new URL(request.url);

    // Nur eigene App-Dateien zwischenspeichern
    if (url.origin !== self.location.origin) return;

    event.respondWith(
        fetch(request)
            .then(response => {
                if (response && response.ok) {
                    const responseCopy = response.clone();

                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(request, responseCopy);
                    });
                }

                return response;
            })
            .catch(async () => {
                const cachedResponse = await caches.match(request);

                if (cachedResponse) {
                    return cachedResponse;
                }

                if (request.mode === "navigate") {
                    return caches.match("./index.html");
                }

                return new Response("Offline – Datei nicht verfügbar.", {
                    status: 503,
                    headers: {
                        "Content-Type": "text/plain; charset=utf-8"
                    }
                });
            })
    );
});
