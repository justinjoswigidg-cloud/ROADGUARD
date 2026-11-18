// =====================================================
// ROADGUARD - SUPABASE VERSION
// Gemeinsame Meldungen, Echtzeit, Admin und Live-GPS
// =====================================================

const SUPABASE_URL = "https://wsglphxrufpuacabqusr.supabase.co";
const SUPABASE_KEY = "sb_publishable_5kE--zsFYloR9noTvnBPdA_BQD0AVWr";

const supabaseClient = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_KEY
);

const NORMAL_LIFETIME = 2 * 60 * 60 * 1000;
const MOBILE_BLITZER_LIFETIME = 7 * 24 * 60 * 60 * 1000;
const SAME_REPORT_DISTANCE = 100;

let map = null;
let userMarker = null;
let reports = [];
let adminMode = false;
let currentUser = null;

// LIVE-STANDORT
let locationWatchId = null;
let hasInitialLocation = false;

const reportMarkers = new Map();
const confirmationCounts = new Map();


// =====================================================
// START
// =====================================================

document.addEventListener("DOMContentLoaded", startRoadguard);

async function startRoadguard() {
    initializeMap();

    // Live-Standort automatisch starten
    startLiveLocation();

    initializeAddressSearch();

    await checkLogin();
    await loadReports();

    subscribeToChanges();

    supabaseClient.auth.onAuthStateChange(async (_event, session) => {
        currentUser = session?.user || null;

        await checkAdmin();
        updateAuthInterface();
        await loadReports();
    });

    console.log("ROADGUARD gestartet.");
}


// =====================================================
// KARTE
// =====================================================

function initializeMap() {
    if (map) return;

    const mapElement = document.getElementById("map");

    if (!mapElement || typeof L === "undefined") {
        console.error("ROADGUARD: Karte oder Leaflet fehlt.");
        return;
    }

    map = L.map("map").setView([51.5700, 6.9850], 13);

    L.tileLayer(
        "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        {
            attribution: "&copy; OpenStreetMap",
            maxZoom: 19
        }
    ).addTo(map);

    setTimeout(() => map.invalidateSize(), 300);
}


// =====================================================
// ANMELDUNG
// =====================================================

async function checkLogin() {
    const { data, error } = await supabaseClient.auth.getSession();

    if (error) {
        console.error("Login-Fehler:", error.message);
        return;
    }

    currentUser = data.session?.user || null;

    await checkAdmin();
    updateAuthInterface();
}

async function checkAdmin() {
    adminMode = false;

    if (!currentUser) return;

    const { data, error } = await supabaseClient.rpc(
        "roadguard_is_admin"
    );

    if (error) {
        console.error("Admin-Prüfung:", error.message);
        return;
    }

    adminMode = data === true;
}

function openAuthModal() {
    const modal = document.getElementById("authModal");
    if (!modal) return;

    modal.style.display = "flex";
    modal.classList.add("active");
    updateAuthInterface();
}

function closeAuthModal() {
    const modal = document.getElementById("authModal");
    if (!modal) return;

    modal.style.display = "none";
    modal.classList.remove("active");
}

function updateAuthInterface() {
    const status = document.getElementById("authStatus");
    const form = document.getElementById("authForm");
    const signOutButton = document.getElementById("signOutButton");

    if (!status || !form || !signOutButton) return;

    if (currentUser) {
        status.textContent = "Angemeldet als " + currentUser.email;
        form.style.display = "none";
        signOutButton.style.display = "block";
    } else {
        status.textContent = "Melde dich an oder erstelle ein kostenloses Konto.";
        form.style.display = "block";
        signOutButton.style.display = "none";
    }
}

async function signIn() {
    const email = document.getElementById("authEmail").value.trim();
    const password = document.getElementById("authPassword").value;

    if (!email || !password) {
        alert("Bitte E-Mail und Passwort eingeben.");
        return;
    }

    const { error } = await supabaseClient.auth.signInWithPassword({
        email,
        password
    });

    if (error) {
        alert("Anmeldung fehlgeschlagen: " + error.message);
        return;
    }

    alert("Du bist angemeldet!");
    closeAuthModal();
}

async function signUp() {
    const email = document.getElementById("authEmail").value.trim();
    const password = document.getElementById("authPassword").value;

    if (!email || !password) {
        alert("Bitte E-Mail und Passwort eingeben.");
        return;
    }

    if (password.length < 6) {
        alert("Das Passwort muss mindestens 6 Zeichen haben.");
        return;
    }

    const { data, error } = await supabaseClient.auth.signUp({
        email,
        password
    });

    if (error) {
        alert("Registrierung fehlgeschlagen: " + error.message);
        return;
    }

    if (data.session) {
        alert("Dein ROADGUARD-Konto wurde erstellt!");
        closeAuthModal();
    } else {
        alert("Registrierung erfolgreich! Bitte bestätige deine E-Mail-Adresse, falls Supabase dich dazu auffordert.");
    }
}

async function signOut() {
    const { error } = await supabaseClient.auth.signOut();

    if (error) {
        alert("Abmelden fehlgeschlagen: " + error.message);
        return;
    }

    adminMode = false;
    closeAuthModal();
    alert("Du wurdest abgemeldet.");
}


// =====================================================
// MELDUNGEN AUS SUPABASE LADEN
// =====================================================

async function loadReports() {
    if (!map) return;

    const { data, error } = await supabaseClient
        .from("roadguard_reports")
        .select("*")
        .order("created_at", { ascending: false });

    if (error) {
        console.error("Meldungen konnten nicht geladen werden:", error);
        return;
    }

    const now = Date.now();

    reports = (data || []).filter(report => {
        if (!report.expires_at) return true;
        return new Date(report.expires_at).getTime() > now;
    });

    await loadConfirmationCounts();
    rebuildMarkers();
    updateReportList();
}

async function loadConfirmationCounts() {
    confirmationCounts.clear();

    const { data, error } = await supabaseClient
        .from("roadguard_confirmations")
        .select("report_id");

    if (error) {
        console.error("Bestätigungen konnten nicht geladen werden:", error);
        return;
    }

    (data || []).forEach(item => {
        const oldCount = confirmationCounts.get(item.report_id) || 0;
        confirmationCounts.set(item.report_id, oldCount + 1);
    });
}


// =====================================================
// ECHTZEIT-AKTUALISIERUNG
// =====================================================

function subscribeToChanges() {
    supabaseClient
        .channel("roadguard-live")
        .on(
            "postgres_changes",
            {
                event: "*",
                schema: "public",
                table: "roadguard_reports"
            },
            () => loadReports()
        )
        .on(
            "postgres_changes",
            {
                event: "*",
                schema: "public",
                table: "roadguard_confirmations"
            },
            () => loadReports()
        )
        .subscribe(status => {
            console.log("ROADGUARD Echtzeit:", status);
        });
}


// =====================================================
// ADRESSSUCHE
// =====================================================

let searchMarker = null;
let lastAddressSearch = 0;

function initializeAddressSearch() {
    const input = document.getElementById("addressSearch");

    if (!input) {
        console.warn("ROADGUARD: Suchfeld #addressSearch wurde nicht gefunden.");
        return;
    }

    input.addEventListener("keydown", event => {
        if (event.key === "Enter") {
            event.preventDefault();
            searchAddress();
        }
    });

    const button = document.getElementById("addressSearchButton");

    if (button) {
        button.addEventListener("click", searchAddress);
    }
}

async function searchAddress() {
    const input = document.getElementById("addressSearch");

    if (!input || !map) return;

    const query = input.value.trim();

    if (query.length < 2) {
        alert("Bitte gib mindestens zwei Zeichen ein.");
        input.focus();
        return;
    }

    const wait = Math.max(0, 1100 - (Date.now() - lastAddressSearch));

    if (wait > 0) {
        await new Promise(resolve => setTimeout(resolve, wait));
    }

    lastAddressSearch = Date.now();

    const button = document.getElementById("addressSearchButton");

    if (button) {
        button.disabled = true;
        button.dataset.oldText = button.textContent;
        button.textContent = "Suche…";
    }

    try {
        const url = new URL("https://nominatim.openstreetmap.org/search");

        url.searchParams.set("format", "jsonv2");
        url.searchParams.set("q", query);
        url.searchParams.set("limit", "1");
        url.searchParams.set("countrycodes", "de");

        const response = await fetch(url.toString(), {
            headers: { "Accept": "application/json" }
        });

        if (!response.ok) {
            throw new Error("Der Suchdienst antwortet gerade nicht (HTTP " + response.status + ").");
        }

        const results = await response.json();

        if (!results.length) {
            alert("Leider wurde keine passende Adresse gefunden. Bitte prüfe die Schreibweise.");
            return;
        }

        const place = results[0];
        const lat = Number(place.lat);
        const lon = Number(place.lon);

        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            throw new Error("Der Suchdienst hat keine gültigen Koordinaten geliefert.");
        }

        map.setView([lat, lon], 16);

        if (searchMarker) {
            map.removeLayer(searchMarker);
        }

        searchMarker = L.marker([lat, lon])
            .addTo(map)
            .bindPopup(
                "<strong>📍 Suchergebnis</strong><br>" +
                escapeHTML(place.display_name || query)
            )
            .openPopup();

    } catch (error) {
        console.error("ROADGUARD Adresssuche:", error);
        alert("Die Adresssuche ist fehlgeschlagen: " + error.message);
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = button.dataset.oldText || "Suchen";
        }
    }
}


// =====================================================
// LIVE-STANDORT
// =====================================================

function startLiveLocation() {
    if (!navigator.geolocation) {
        console.error("Standortbestimmung wird nicht unterstützt.");
        return;
    }

    // Verhindert, dass mehrere GPS-Überwachungen gleichzeitig starten.
    if (locationWatchId !== null) return;

    locationWatchId = navigator.geolocation.watchPosition(
        position => {
            const lat = position.coords.latitude;
            const lon = position.coords.longitude;

            if (!map) return;

            // Standortmarker erstellen oder aktualisieren.
            if (!userMarker) {
                userMarker = L.marker([lat, lon])
                    .addTo(map)
                    .bindPopup("📍 Dein aktueller Standort");
            } else {
                userMarker.setLatLng([lat, lon]);
            }

            // Beim ersten Standort auf die eigene Position zoomen.
            if (!hasInitialLocation) {
                map.setView([lat, lon], 16);
                hasInitialLocation = true;
            } else {
                // Karte der aktuellen Position folgen lassen.
                map.panTo([lat, lon], { animate: true });
            }

            // Entfernungen und Gefahrenliste aktualisieren.
            updateReportList();

            console.log("ROADGUARD Live-Standort:", lat, lon);
        },
        error => {
            console.error("Live-Standortfehler:", error);

            if (error.code === 1) {
                alert("Bitte erlaube ROADGUARD den Standortzugriff in deinen iPhone-Einstellungen.");
            }
        },
        {
            enableHighAccuracy: true,
            maximumAge: 3000,
            timeout: 20000
        }
    );
}


// Der runde Standortknopf bleibt weiterhin funktionsfähig.
function getMyLocation() {
    if (userMarker && map) {
        const position = userMarker.getLatLng();

        map.setView(
            [position.lat, position.lng],
            16
        );

        return;
    }

    startLiveLocation();
}


// =====================================================
// MELDE-MENÜ
// =====================================================

function openReportMenu() {
    if (!currentUser) {
        alert("Bitte melde dich zuerst an, um eine Gefahr zu melden.");
        openAuthModal();
        return;
    }

    const modal = document.getElementById("reportModal");
    modal.style.display = "flex";
    modal.classList.add("active");
}

function closeReportMenu() {
    const modal = document.getElementById("reportModal");

    if (!modal) return;

    modal.style.display = "none";
    modal.classList.remove("active");
}


// =====================================================
// ENTFERNUNG UND DOPPELTE MELDUNGEN
// =====================================================

function calculateDistance(lat1, lon1, lat2, lon2) {
    const earthRadius = 6371000;
    const radians = value => value * Math.PI / 180;

    const dLat = radians(lat2 - lat1);
    const dLon = radians(lon2 - lon1);

    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(radians(lat1)) *
        Math.cos(radians(lat2)) *
        Math.sin(dLon / 2) ** 2;

    return earthRadius * 2 *
        Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findExistingReport(type, lat, lon) {
    return reports.find(report => {
        if (report.type !== type) return false;

        return calculateDistance(
            lat,
            lon,
            report.lat,
            report.lon
        ) <= SAME_REPORT_DISTANCE;
    });
}


// =====================================================
// NEUE GEFAHR MELDEN
// =====================================================

async function submitReport(type, icon) {
    if (!currentUser) {
        alert("Bitte melde dich zuerst an.");
        closeReportMenu();
        openAuthModal();
        return;
    }

    if (!navigator.geolocation) {
        alert("Dein Browser unterstützt keine Standortbestimmung.");
        return;
    }

    navigator.geolocation.getCurrentPosition(
        async position => {
            const lat = position.coords.latitude;
            const lon = position.coords.longitude;

            const existingReport = findExistingReport(type, lat, lon);

            if (existingReport) {
                const shouldConfirm = confirm(
                    "In der Nähe gibt es bereits eine Meldung dieser Art.\n\n" +
                    "Möchtest du diese Meldung stattdessen bestätigen?"
                );

                if (shouldConfirm) {
                    await confirmReport(existingReport.id);
                    closeReportMenu();
                }

                return;
            }

            const now = new Date();

            let expiresAt = null;

            if (type === "Fester Blitzer") {
                expiresAt = null;
            } else if (type === "Mobiler Blitzer") {
                expiresAt = new Date(
                    now.getTime() + MOBILE_BLITZER_LIFETIME
                ).toISOString();
            } else {
                expiresAt = new Date(
                    now.getTime() + NORMAL_LIFETIME
                ).toISOString();
            }

            const { error } = await supabaseClient
                .from("roadguard_reports")
                .insert({
                    type: type,
                    icon: icon,
                    lat: lat,
                    lon: lon,
                    created_by: currentUser.id,
                    created_at: now.toISOString(),
                    last_reported_at: now.toISOString(),
                    expires_at: expiresAt
                });

            if (error) {
                console.error("Fehler beim Speichern:", error);
                alert("Die Meldung konnte nicht gespeichert werden: " + error.message);
                return;
            }

            closeReportMenu();

            alert(type + " wurde erfolgreich gemeldet!");

            await loadReports();
        },
        error => {
            console.error("Standortfehler:", error);
            alert("Dein Standort konnte nicht ermittelt werden. Bitte erlaube den Standortzugriff.");
        },
        {
            enableHighAccuracy: true,
            timeout: 15000,
            maximumAge: 0
        }
    );
}


// =====================================================
// MELDUNG BESTÄTIGEN
// =====================================================

async function confirmReport(reportId) {
    if (!currentUser) {
        alert("Bitte melde dich zuerst an.");
        openAuthModal();
        return;
    }

    const { data, error } = await supabaseClient.rpc(
        "roadguard_confirm_report",
        { p_report_id: reportId }
    );

    if (error) {
        console.error("Bestätigung fehlgeschlagen:", error);
        alert("Die Bestätigung ist fehlgeschlagen: " + error.message);
        return;
    }

    if (data === false) {
        alert("Du hast diese Meldung bereits bestätigt.");
        return;
    }

    alert("Danke! Deine Bestätigung wurde gespeichert.");

    await loadReports();
}


// =====================================================
// KARTEN-MARKER
// =====================================================

function addReportToMap(report) {
    if (!map || reportMarkers.has(report.id)) return;

    let sticker = report.icon || "⚠️";
    let borderColor = "#64748b";

    if (report.type === "Fester Blitzer") {
        sticker = "📸";
        borderColor = "#eab308";
    } else if (report.type === "Mobiler Blitzer") {
        sticker = "🚔";
        borderColor = "#f97316";
    } else if (report.type === "Unfall") {
        sticker = "🚨";
        borderColor = "#ef4444";
    } else if (report.type === "Stau") {
        sticker = "🚗";
        borderColor = "#f97316";
    } else if (report.type === "Baustelle") {
        sticker = "🚧";
        borderColor = "#eab308";
    }

    const markerIcon = L.divIcon({
        html: `
            <div style="
                width:42px;
                height:42px;
                background:#fff;
                border:3px solid ${borderColor};
                border-radius:50%;
                display:flex;
                align-items:center;
                justify-content:center;
                font-size:22px;
                box-shadow:0 3px 10px rgba(0,0,0,.45);
            ">${escapeHTML(sticker)}</div>
        `,
        className: "roadguard-sticker",
        iconSize: [42, 42],
        iconAnchor: [21, 21]
    });

    const marker = L.marker(
        [report.lat, report.lon],
        { icon: markerIcon }
    ).addTo(map);

    const count = confirmationCounts.get(report.id) || 0;

    marker.bindPopup(
        "<strong>" + escapeHTML(report.type) + "</strong>" +
        "<br>✔ " + count + " Bestätigungen"
    );

    reportMarkers.set(report.id, marker);
}

function rebuildMarkers() {
    if (!map) return;

    reportMarkers.forEach(marker => map.removeLayer(marker));
    reportMarkers.clear();

    reports.forEach(report => addReportToMap(report));
}


// =====================================================
// ADMIN: MELDUNG LÖSCHEN
// =====================================================

async function deleteReport(reportId) {
    if (!adminMode) {
        alert("Nur der Administrator darf Meldungen löschen.");
        return;
    }

    const report = reports.find(item => item.id === reportId);

    if (!report) return;

    if (!confirm("Möchtest du diese Meldung wirklich löschen?\n\n" + report.type)) {
        return;
    }

    const { error } = await supabaseClient
        .from("roadguard_reports")
        .delete()
        .eq("id", reportId);

    if (error) {
        console.error("Löschen fehlgeschlagen:", error);
        alert("Die Meldung konnte nicht gelöscht werden: " + error.message);
        return;
    }

    await loadReports();
}


// =====================================================
// MELDUNGSLISTE
// =====================================================

function updateReportList() {
    const list = document.getElementById("reportList");

    if (!list) return;

    list.innerHTML = "";

    if (adminMode) {
        const banner = document.createElement("div");
        banner.className = "adminBanner";

        banner.innerHTML = `
            <strong>🔐 ADMIN-MODUS AKTIV</strong>
            <span>Du bist als Administrator angemeldet.</span>
        `;

        list.appendChild(banner);
    }

    if (reports.length === 0) {
        const empty = document.createElement("div");
        empty.className = "emptyReports";

        empty.innerHTML = `
            <p>🚗 Keine aktuellen Meldungen.</p>
            <p>Melde eine Gefahr, um andere zu warnen!</p>
        `;

        list.appendChild(empty);
        return;
    }

    // Wenn der eigene Standort bekannt ist, kommen die nächsten Gefahren zuerst.
    const userPosition = userMarker ? userMarker.getLatLng() : null;

    const sortedReports = [...reports].sort((a, b) => {
        if (!userPosition) {
            return new Date(b.created_at).getTime() -
                new Date(a.created_at).getTime();
        }

        const distanceA = calculateDistance(
            userPosition.lat,
            userPosition.lng,
            a.lat,
            a.lon
        );

        const distanceB = calculateDistance(
            userPosition.lat,
            userPosition.lng,
            b.lat,
            b.lon
        );

        return distanceA - distanceB;
    });

    sortedReports.forEach(report => {
        const card = document.createElement("div");
        card.className = "reportCard";

        const lastTime = new Date(
            report.last_reported_at || report.created_at
        ).getTime();

        const minutesAgo = Math.max(
            0,
            Math.floor((Date.now() - lastTime) / 60000)
        );

        let timeText = "Gerade eben";

        if (minutesAgo >= 1 && minutesAgo < 60) {
            timeText = "Vor " + minutesAgo + " Minuten";
        } else if (minutesAgo >= 60 && minutesAgo < 1440) {
            timeText = "Vor " + Math.floor(minutesAgo / 60) + " Stunden";
        } else if (minutesAgo >= 1440) {
            timeText = "Vor " + Math.floor(minutesAgo / 1440) + " Tagen";
        }

        let expiryText = "Dauerhaft gespeichert";

        if (report.expires_at) {
            const remaining = Math.max(
                0,
                Math.ceil(
                    (new Date(report.expires_at).getTime() - Date.now()) / 60000
                )
            );

            if (remaining < 60) {
                expiryText = "Noch " + remaining + " Minuten";
            } else if (remaining < 1440) {
                expiryText = "Noch " + Math.floor(remaining / 60) + " Stunden";
            } else {
                expiryText = "Noch " + Math.ceil(remaining / 1440) + " Tage";
            }
        }

        const count = confirmationCounts.get(report.id) || 0;

        // Entfernung zum eigenen Standort berechnen.
        let distanceText = "";

        if (userPosition) {
            const distance = calculateDistance(
                userPosition.lat,
                userPosition.lng,
                report.lat,
                report.lon
            );

            if (distance < 1000) {
                distanceText = Math.round(distance) + " m entfernt";
            } else {
                distanceText = (distance / 1000)
                    .toFixed(1)
                    .replace(".", ",") + " km entfernt";
            }
        }

        card.innerHTML = `
            <div class="reportIcon">
                ${escapeHTML(report.icon || "⚠️")}
            </div>

            <div class="reportInfo">
                <strong>${escapeHTML(report.type)}</strong>

                ${distanceText ? `
                    <small>📍 ${escapeHTML(distanceText)}</small>
                ` : ""}

                <small>${escapeHTML(timeText)}</small>
                <small>✔ ${count} Bestätigung(en)</small>
                <small>${escapeHTML(expiryText)}</small>
            </div>

            <button class="confirmReportButton" type="button">
                ✔ Bestätigen
            </button>

            ${adminMode ? `
                <button
                    class="deleteReportButton"
                    type="button"
                    title="Meldung löschen"
                >🗑️</button>
            ` : ""}
        `;

        // Klick auf die Meldung öffnet ihre Position auf der Karte.
        card.addEventListener("click", event => {
            if (event.target.closest("button")) return;

            map.setView([report.lat, report.lon], 16);

            const marker = reportMarkers.get(report.id);

            if (marker) {
                marker.openPopup();
            }
        });

        card.querySelector(".confirmReportButton")
            .addEventListener("click", () => {
                confirmReport(report.id);
            });

        if (adminMode) {
            card.querySelector(".deleteReportButton")
                .addEventListener("click", () => {
                    deleteReport(report.id);
                });
        }

        list.appendChild(card);
    });
}


// =====================================================
// HTML SICHERHEIT
// =====================================================

function escapeHTML(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}


// =====================================================
// NAVIGATION
// =====================================================

function showMap() {
    if (map) {
        setTimeout(() => map.invalidateSize(), 100);
    }
}

function showReports() {
    loadReports();
}

function showCommunity() {
    alert("Die Community-Funktion kommt bald!");
}

function showSettings() {
    openAuthModal();
}


// =====================================================
// AUTOMATISCHE AKTUALISIERUNG
// =====================================================

setInterval(() => {
    loadReports();
}, 60000);


// =====================================================
// SERVICE WORKER
// =====================================================

if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js")
            .then(() => console.log("ROADGUARD: Offline-Funktion aktiviert."))
            .catch(error => console.error("Service Worker:", error));
    });
}
