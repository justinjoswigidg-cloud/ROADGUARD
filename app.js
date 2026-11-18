
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

let locationWatchId = null;
let hasInitialLocation = false;

const reportMarkers = new Map();
const confirmationCounts = new Map();


// =====================================================
// ROADGUARD WARNTOENE
// =====================================================

let roadguardAudioContext = null;
let roadguardAudioEnabled = false;

const ROADGUARD_WARNING_SETTINGS = {
    firstDistance: 500,
    secondDistance: 150,
    volume: 0.9
};

const playedWarnings = new Map();


function initializeWarningSounds() {

    const button = document.getElementById("roadguardSoundButton");

    if (!button) {
        console.error("ROADGUARD Lautsprecher-Button nicht gefunden.");
        return;
    }

    function updateSoundButton() {

        if (roadguardAudioEnabled) {
            button.textContent = "🔊";
            button.title = "Warntöne deaktivieren";
            button.setAttribute("aria-label", "Warntöne deaktivieren");
            button.classList.add("sound-active");
        } else {
            button.textContent = "🔇";
            button.title = "Warntöne aktivieren";
            button.setAttribute("aria-label", "Warntöne aktivieren");
            button.classList.remove("sound-active");
        }
    }

    updateSoundButton();

    button.addEventListener("click", async () => {

        try {
            const AudioContextClass =
                window.AudioContext || window.webkitAudioContext;

            if (!AudioContextClass) {
                alert("Dein Browser unterstützt keine Warntöne.");
                return;
            }

            if (!roadguardAudioContext) {
                roadguardAudioContext = new AudioContextClass();
            }

            if (roadguardAudioEnabled) {
                roadguardAudioEnabled = false;
                updateSoundButton();
                return;
            }

            await roadguardAudioContext.resume();

            roadguardAudioEnabled =
                roadguardAudioContext.state === "running";

            updateSoundButton();

            if (!roadguardAudioEnabled) {
                alert("Die Warntöne konnten nicht aktiviert werden.");
            }

        } catch (error) {
            console.error("ROADGUARD Audio:", error);
            alert("Die Warntöne konnten nicht aktiviert werden.");
        }
    });
}


// =====================================================
// WARNTOENE ABSPIELEN
// =====================================================

function playRoadguardTone(category, level) {

    if (
        !roadguardAudioEnabled ||
        !roadguardAudioContext ||
        roadguardAudioContext.state !== "running"
    ) {
        return;
    }

    const context = roadguardAudioContext;
    const isBlitzer = category === "blitzer";

    // Bei 500 m normaler Ton, bei 150 m etwas höher.
    let frequency;

    if (isBlitzer) {
        frequency = level === 1 ? 1200 : 1450;
    } else {
        frequency = level === 1 ? 700 : 850;
    }

    const volume = ROADGUARD_WARNING_SETTINGS.volume;

    function playBeep(startTime, duration) {

        const oscillator = context.createOscillator();
        const gain = context.createGain();

        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, startTime);

        gain.gain.setValueAtTime(0, startTime);

        gain.gain.linearRampToValueAtTime(
            volume,
            startTime + 0.015
        );

        gain.gain.setValueAtTime(
            volume,
            startTime + duration - 0.02
        );

        gain.gain.linearRampToValueAtTime(
            0,
            startTime + duration
        );

        oscillator.connect(gain);
        gain.connect(context.destination);

        oscillator.start(startTime);
        oscillator.stop(startTime + duration);
    }

    const now = context.currentTime;

    if (isBlitzer) {
        // Zwei schnelle Pieptöne.
        playBeep(now, 0.12);
        playBeep(now + 0.18, 0.12);
    } else {
        // Ein einzelner kurzer Piepton.
        playBeep(now, 0.18);
    }
}


// =====================================================
// START
// =====================================================

document.addEventListener("DOMContentLoaded", () => {
    initializeWarningSounds();
});

document.addEventListener("DOMContentLoaded", startRoadguard);

async function startRoadguard() {

    initializeMap();

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

    showRoadguardInfoIfNeeded();

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

    // Die Entfernungsprüfung erfolgt über den Live-GPS-Standort.
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

    const wait = Math.max(
        0,
        1100 - (Date.now() - lastAddressSearch)
    );

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
            throw new Error(
                "Der Suchdienst antwortet gerade nicht (HTTP " +
                response.status + ")."
            );
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
// STANDORT-PFEIL
// =====================================================

function createUserArrowIcon(heading = 0) {

    if (!document.getElementById("roadguard-arrow-style")) {

        const style = document.createElement("style");

        style.id = "roadguard-arrow-style";

        style.textContent = `
            .roadguard-user-arrow {
                background: transparent !important;
                border: none !important;
            }
        `;

        document.head.appendChild(style);
    }

    return L.divIcon({

        className: "roadguard-user-arrow",

        html: `
            <div style="
                width: 48px;
                height: 48px;
                display: flex;
                align-items: center;
                justify-content: center;
                transform: rotate(${heading}deg);
                filter: drop-shadow(0 2px 4px rgba(0,0,0,.55));
            ">
                <svg
                    width="46"
                    height="46"
                    viewBox="0 0 46 46"
                    xmlns="http://www.w3.org/2000/svg"
                >
                    <path
                        d="M23 3 L39 41 L23 32 L7 41 Z"
                        fill="#1677ff"
                        stroke="white"
                        stroke-width="3"
                        stroke-linejoin="round"
                    />
                    <path
                        d="M23 9 L23 29"
                        stroke="#ffffff"
                        stroke-width="2"
                        stroke-linecap="round"
                    />
                </svg>
            </div>
        `,

        iconSize: [48, 48],
        iconAnchor: [24, 24]
    });
}


// =====================================================
// LIVE-STANDORT
// =====================================================

function startLiveLocation() {

    if (!navigator.geolocation) {
        console.error("Standortbestimmung wird nicht unterstützt.");
        return;
    }

    if (locationWatchId !== null) return;

    locationWatchId = navigator.geolocation.watchPosition(

        position => {

            const lat = position.coords.latitude;
            const lon = position.coords.longitude;

            if (!map) return;

            const heading = Number.isFinite(position.coords.heading)
                ? position.coords.heading
                : 0;

            if (!userMarker) {

                userMarker = L.marker([lat, lon], {
                    icon: createUserArrowIcon(heading),
                    zIndexOffset: 1000
                })
                    .addTo(map)
                    .bindPopup("Dein aktueller Standort");

            } else {

                userMarker.setLatLng([lat, lon]);
                userMarker.setIcon(createUserArrowIcon(heading));
            }

            if (!hasInitialLocation) {

                map.setView([lat, lon], 16);
                hasInitialLocation = true;

            } else {

                map.panTo([lat, lon], { animate: true });
            }

            updateReportList();

            // Entfernungswarnungen mit dem aktuellen GPS-Standort prüfen.
            checkNearbyWarnings(lat, lon);

            console.log(
                "ROADGUARD Live-Standort:",
                lat,
                lon,
                "Richtung:",
                heading
            );
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
// ENTFERNUNGS-WARNSYSTEM
// =====================================================

function checkNearbyWarnings(userLat, userLon) {

    reports.forEach(report => {

        const distance = calculateDistance(
            userLat,
            userLon,
            report.lat,
            report.lon
        );

        const isBlitzer =
            report.type === "Fester Blitzer" ||
            report.type === "Mobiler Blitzer";

        const category = isBlitzer ? "blitzer" : "danger";

        let warningLevel = null;

        if (distance <= ROADGUARD_WARNING_SETTINGS.secondDistance) {
            warningLevel = 2;
        } else if (distance <= ROADGUARD_WARNING_SETTINGS.firstDistance) {
            warningLevel = 1;
        }

        if (warningLevel === null) {
            playedWarnings.delete(report.id);
            return;
        }

        // Wenn die Warntöne ausgeschaltet sind, nichts vormerken.
        // Nach dem Aktivieren kann die nächste GPS-Aktualisierung warnen.
        if (!roadguardAudioEnabled) {
            return;
        }

        const previousLevel = playedWarnings.get(report.id) || 0;

        if (warningLevel <= previousLevel) {
            return;
        }

        playedWarnings.set(report.id, warningLevel);

        playRoadguardTone(category, warningLevel);

        console.log(
            "ROADGUARD Warnung:",
            report.type,
            Math.round(distance) + " m",
            "Stufe:",
            warningLevel
        );
    });
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
// ROADGUARD UPDATE-FENSTER
// =====================================================

const ROADGUARD_INFO_VERSION = "roadguard-info-v1.1";

function showRoadguardInfoIfNeeded() {

    try {

        if (localStorage.getItem(ROADGUARD_INFO_VERSION) === "accepted") {
            return;
        }

    } catch (error) {

        console.error("ROADGUARD: Speicherzugriff nicht möglich.", error);
    }

    if (document.getElementById("roadguardWelcome")) return;

    const style = document.createElement("style");

    style.id = "roadguard-welcome-style";

    style.textContent = `
        #roadguardWelcome {
            position: fixed;
            inset: 0;
            z-index: 99999;
            background: rgba(0, 0, 0, 0.84);
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 18px;
            padding-top: max(18px, env(safe-area-inset-top));
            padding-bottom: max(18px, env(safe-area-inset-bottom));
            backdrop-filter: blur(8px);
        }

        #roadguardWelcome .welcomeBox {
            width: 100%;
            max-width: 440px;
            max-height: 88vh;
            overflow-y: auto;
            background: #151d29;
            color: #ffffff;
            border: 1px solid #29384b;
            border-radius: 22px;
            padding: 26px;
            box-shadow: 0 15px 50px rgba(0,0,0,.5);
            text-align: center;
        }

        #roadguardWelcome .welcomeLogo {
            font-size: 30px;
            font-weight: 900;
            letter-spacing: 3px;
            color: #3185ff;
            margin-bottom: 5px;
        }

        #roadguardWelcome .updateBadge {
            display: inline-block;
            background: rgba(22,119,255,.16);
            color: #60a5fa;
            border: 1px solid rgba(49,133,255,.35);
            border-radius: 30px;
            padding: 6px 13px;
            font-size: 11px;
            font-weight: bold;
            letter-spacing: 1px;
            margin: 12px 0 17px;
        }

        #roadguardWelcome .versionText {
            color: #8292a7;
            font-size: 12px;
            margin-bottom: 8px;
        }

        #roadguardWelcome h2 {
            font-size: 25px;
            margin: 0 0 12px;
            color: #ffffff;
        }

        #roadguardWelcome .updateTitle {
            color: #3185ff;
            font-size: 19px;
            font-weight: bold;
            margin-bottom: 18px;
        }

        #roadguardWelcome .updateDescription {
            color: #b7c5d6;
            font-size: 14px;
            line-height: 1.65;
            margin: 0 0 20px;
        }

        #roadguardWelcome .updateItem {
            display: flex;
            align-items: flex-start;
            text-align: left;
            gap: 13px;
            background: #1c293a;
            border: 1px solid #2b3d54;
            border-radius: 13px;
            padding: 13px;
            margin: 10px 0;
        }

        #roadguardWelcome .updateIcon {
            font-size: 25px;
            min-width: 30px;
        }

        #roadguardWelcome .updateText strong {
            display: block;
            font-size: 14px;
            margin-bottom: 4px;
        }

        #roadguardWelcome .updateText span {
            display: block;
            color: #aebdd0;
            font-size: 12px;
            line-height: 1.5;
        }

        #roadguardWelcome .welcomeButton {
            width: 100%;
            margin-top: 19px;
            padding: 15px;
            background: #1677ff;
            color: white;
            border: none;
            border-radius: 12px;
            font-size: 15px;
            font-weight: bold;
            cursor: pointer;
        }

        #roadguardWelcome .welcomeButton:active {
            transform: scale(.98);
        }

        #roadguardWelcome .welcomeFooter {
            color: #8292a7;
            font-size: 11px;
            margin-top: 13px;
        }
    `;

    document.head.appendChild(style);

    const overlay = document.createElement("div");

    overlay.id = "roadguardWelcome";

    overlay.innerHTML = `
        <div class="welcomeBox">

            <div class="welcomeLogo">ROADGUARD</div>

            <div class="updateBadge">
                NEUES UPDATE
            </div>

            <div class="versionText">
                VERSION 1.1
            </div>

            <h2>Das ist neu!</h2>

            <div class="updateTitle">
                📍 Live Tracking
            </div>

            <p class="updateDescription">
                ROADGUARD bekommt eine neue Funktion:
                Dein Standort wird jetzt automatisch während
                der Nutzung der App verfolgt.
            </p>

            <div class="updateItem">
                <div class="updateIcon">📍</div>
                <div class="updateText">
                    <strong>Automatische Standortaktualisierung</strong>
                    <span>
                        Dein Standort wird während der Nutzung
                        automatisch aktualisiert. Du musst nicht
                        mehr ständig auf den Standortknopf drücken.
                    </span>
                </div>
            </div>

            <div class="updateItem">
                <div class="updateIcon">🧭</div>
                <div class="updateText">
                    <strong>Neuer Richtungspfeil</strong>
                    <span>
                        Der blaue Pfeil zeigt deinen Standort
                        und, sofern GPS-Daten verfügbar sind,
                        deine Bewegungsrichtung.
                    </span>
                </div>
            </div>

            <div class="updateItem">
                <div class="updateIcon">🗺️</div>
                <div class="updateText">
                    <strong>Standort auf der Karte</strong>
                    <span>
                        Die Karte kann sich automatisch an
                        deinen aktuellen Standort anpassen.
                    </span>
                </div>
            </div>

            <div class="updateItem">
                <div class="updateIcon">🔉</div>
                <div class="updateText">
                    <strong>Neue Warntöne</strong>
                    <span>
                        Jetzt gibt es "Warn Töne" die dich vor
                        Gefahren warnen!.
                    </span>
                </div>
            </div>

            <button
                class="welcomeButton"
                id="roadguardWelcomeAccept"
                type="button"
            >
                Verstanden
            </button>

            <div class="welcomeFooter">
                ROADGUARD · Version 1.1
            </div>

        </div>
    `;

    document.body.appendChild(overlay);

    document.getElementById("roadguardWelcomeAccept")
        .addEventListener("click", () => {

            try {

                localStorage.setItem(
                    ROADGUARD_INFO_VERSION,
                    "accepted"
                );

            } catch (error) {

                console.error("ROADGUARD: Bestätigung konnte nicht gespeichert werden.", error);
            }

            overlay.remove();
            style.remove();
        });
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

            .then(() => {
                console.log("ROADGUARD: Offline-Funktion aktiviert.");
            })

            .catch(error => {
                console.error("Service Worker:", error);
            });
    });
}

