/* Google Sheets CSV sources. If unavailable, the app uses data.js fallback. */
const STOPS_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQEbPJceCQjWMHt-EuiHWoENhGcP08MBMn0j0ueG3YDAqos3NQ0rxH_oXrtL85h7ruD_UJlmgyFmwQN/pub?gid=0&single=true&output=csv";
const ROUTES_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQEbPJceCQjWMHt-EuiHWoENhGcP08MBMn0j0ueG3YDAqos3NQ0rxH_oXrtL85h7ruD_UJlmgyFmwQN/pub?gid=1078026098&single=true&output=csv";

/* Optional: set a Formspree endpoint here to submit directly. Leave blank for mailto. */
const FORM_ENDPOINT = "";

const state = { stops: [], routes: [], map: null, mapLayers: [], stopById: new Map() };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const esc = (value = "") => String(value).replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[c]));

document.addEventListener("DOMContentLoaded", init);

async function init() {
  wireNavigation();
  wireControls();
  applySavedTheme();
  state.map = L.map("map", { scrollWheelZoom: true }).setView([15.05, 120.62], 10);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(state.map);

  await loadData();
  populateSelects();
  populateMunicipalityFilter();
  renderDirectory();
  renderCatalog();
  updateFareEstimate();
  $("#planner-status").textContent = `Loaded ${state.stops.length} stops and ${state.routes.length} route connections.`;
  setTimeout(() => state.map.invalidateSize(), 100);
  if (window.lucide) lucide.createIcons();
}

function wireNavigation() {
  $$("[data-view-link]").forEach((button) => button.addEventListener("click", () => {
    const view = button.dataset.viewLink;
    $$(".view").forEach((el) => el.classList.toggle("active", el.id === `view-${view}`));
    $$("[data-view-link]").forEach((el) => el.classList.toggle("active", el.dataset.viewLink === view));
    if (view === "planner") setTimeout(() => state.map && state.map.invalidateSize(), 80);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }));
}

function wireControls() {
  $("#plan-btn").addEventListener("click", planJourney);
  $("#swap-btn").addEventListener("click", () => {
    const origin = $("#origin"), destination = $("#destination");
    [origin.value, destination.value] = [destination.value, origin.value];
  });
  $("#locate-btn").addEventListener("click", locateNearestStop);
  $("#stop-search").addEventListener("input", renderDirectory);
  $("#municipality-filter").addEventListener("change", renderDirectory);
  $("#route-search").addEventListener("input", renderCatalog);
  $("#jeep-type").addEventListener("change", updateFareEstimate);
  $("#distance-km").addEventListener("input", updateFareEstimate);
  $("#calc-passenger").addEventListener("change", updateFareEstimate);
  $("#theme-toggle").addEventListener("click", toggleTheme);
  $("#contribution-form").addEventListener("submit", submitContribution);
}

async function loadData() {
  const fallback = window.BP_DATA || { stops: [], routes: [] };
  const urlsConfigured = STOPS_CSV_URL && ROUTES_CSV_URL &&
    !STOPS_CSV_URL.includes("PASTE_") && !ROUTES_CSV_URL.includes("PASTE_");

  if (urlsConfigured && window.Papa) {
    try {
      const [stopsText, routesText] = await Promise.all([
        fetchCsv(STOPS_CSV_URL), fetchCsv(ROUTES_CSV_URL)
      ]);
      const stops = Papa.parse(stopsText, { header: true, skipEmptyLines: true, transformHeader: h => h.trim() });
      const routes = Papa.parse(routesText, { header: true, skipEmptyLines: true, transformHeader: h => h.trim() });
      const cleanStops = stops.data.filter(row => row.stop_id && row.name).map(row => ({
        stop_id: row.stop_id.trim(), name: row.name.trim(), municipality: (row.municipality || "Other").trim(),
        lat: num(row.lat, NaN), lng: num(row.lng, NaN)
      })).filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lng));
      const cleanRoutes = routes.data.filter(row => row.route_id && row.from_stop_id && row.to_stop_id).map(row => ({
        route_id: row.route_id.trim(), signboard: (row.signboard || "Jeepney route").trim(),
        jeep_color: normalizeColor(row.jeep_color), from_stop_id: row.from_stop_id.trim(),
        to_stop_id: row.to_stop_id.trim(), regular_fare: num(row.regular_fare),
        discounted_fare: num(row.discounted_fare, num(row.regular_fare) * 0.8),
        notes: (row.notes || "").trim()
      }));
      if (cleanStops.length && cleanRoutes.length) {
        state.stops = cleanStops;
        state.routes = cleanRoutes;
      } else throw new Error("The published sheets contained no usable rows.");
    } catch (error) {
      console.warn("Could not load the live CSV data; using built-in fallback.", error);
      state.stops = fallback.stops || [];
      state.routes = fallback.routes || [];
      $("#planner-status").textContent = "Using built-in sample data; live sheet was unavailable.";
    }
  } else {
    state.stops = fallback.stops || [];
    state.routes = fallback.routes || [];
  }
  state.stopById = new Map(state.stops.map(stop => [stop.stop_id, stop]));
}

async function fetchCsv(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`CSV request failed (${response.status}).`);
  return response.text();
}

function normalizeColor(color) {
  const c = String(color || "gray").toLowerCase().trim();
  return ["gray", "yellow", "green", "checkered"].includes(c) ? c : "gray";
}

function populateSelects() {
  const groups = groupStops();
  ["#origin", "#destination"].forEach((selector) => {
    const select = $(selector);
    select.innerHTML = `<option value="">Choose a stop…</option>` +
      [...groups.entries()].map(([municipality, stops]) =>
        `<optgroup label="${esc(municipality)}">${stops.map(stop =>
          `<option value="${esc(stop.stop_id)}">${esc(stop.name)}</option>`).join("")}</optgroup>`
      ).join("");
  });
  if (state.stops.length > 1) {
    $("#origin").value = state.stops[0].stop_id;
    $("#destination").value = state.stops[1].stop_id;
  }
}

function groupStops() {
  const groups = new Map();
  state.stops.forEach(stop => {
    if (!groups.has(stop.municipality)) groups.set(stop.municipality, []);
    groups.get(stop.municipality).push(stop);
  });
  return new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function populateMunicipalityFilter() {
  const select = $("#municipality-filter");
  [...new Set(state.stops.map(s => s.municipality))].sort().forEach(municipality => {
    const option = document.createElement("option");
    option.value = municipality; option.textContent = municipality; select.append(option);
  });
}

function planJourney() {
  const originId = $("#origin").value, destinationId = $("#destination").value;
  const status = $("#planner-status"), results = $("#route-results");
  results.innerHTML = "";
  clearMap();
  if (!originId || !destinationId) { status.textContent = "Choose both a starting point and destination."; return; }
  if (originId === destinationId) { status.textContent = "Choose two different stops."; return; }

  const discount = $("#passenger-type").value === "discounted";
  const journeys = findJourneys(originId, destinationId, 3, discount);
  if (!journeys.length) {
    status.textContent = "No route found within three rides using the available data.";
    return;
  }
  status.textContent = `Found ${journeys.length} route option${journeys.length === 1 ? "" : "s"} (up to 3 rides).`;
  journeys.slice(0, 5).forEach((journey, index) => {
    const card = document.createElement("article");
    card.className = `route-card${index === 0 ? " best" : ""}`;
    card.innerHTML = `
      <div class="route-card-head">
        <strong>${index === 0 ? "Recommended · " : ""}${journey.legs.length} ride${journey.legs.length > 1 ? "s" : ""}</strong>
        <span class="fare-pill">₱${journey.fare.toFixed(2)}</span>
      </div>
      ${journey.legs.map((leg, i) => {
        const from = state.stopById.get(leg.from_stop_id), to = state.stopById.get(leg.to_stop_id);
        return `<div class="trip-leg">
          <span class="jeep-badge ${normalizeColor(leg.jeep_color)}">${i + 1}</span>
          <div><strong>${esc(leg.signboard)}</strong><p>Board: ${esc(from?.name || leg.from_stop_id)} → Drop off: ${esc(to?.name || leg.to_stop_id)}</p></div>
        </div>${leg.notes ? `<p class="notes">${esc(leg.notes)}</p>` : ""}`;
      }).join("")}
      <a class="maps-link" target="_blank" rel="noopener" href="${googleMapsUrl(journey)}">
        <i data-lucide="external-link"></i> Open in Google Maps
      </a>`;
    results.append(card);
  });
  drawJourney(journeys[0]);
  if (window.lucide) lucide.createIcons();
}

/* Breadth-first search enumerates paths by rides; keep the lowest-fare options. */
function findJourneys(originId, destinationId, maxRides, discounted) {
  const queue = [{ stopId: originId, legs: [], visited: new Set([originId]), fare: 0 }];
  const found = [];
  while (queue.length) {
    const current = queue.shift();
    if (current.legs.length >= maxRides) continue;
    for (const route of state.routes) {
      if (route.from_stop_id !== current.stopId || current.visited.has(route.to_stop_id)) continue;
      const fare = num(discounted ? route.discounted_fare : route.regular_fare);
      const next = {
        stopId: route.to_stop_id, legs: [...current.legs, route],
        visited: new Set([...current.visited, route.to_stop_id]), fare: current.fare + fare
      };
      if (next.stopId === destinationId) found.push(next);
      else queue.push(next);
    }
  }
  found.sort((a, b) => a.legs.length - b.legs.length || a.fare - b.fare);
  return found;
}

function googleMapsUrl(journey) {
  const origin = state.stopById.get(journey.legs[0].from_stop_id);
  const destination = state.stopById.get(journey.legs.at(-1).to_stop_id);
  const waypoints = journey.legs.slice(0, -1)
    .map(leg => state.stopById.get(leg.to_stop_id))
    .filter(Boolean).map(s => `${s.lat},${s.lng}`).join("|");
  const params = new URLSearchParams({
    api: "1", origin: `${origin.lat},${origin.lng}`, destination: `${destination.lat},${destination.lng}`,
    travelmode: "driving"
  });
  if (waypoints) params.set("waypoints", waypoints);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function clearMap() {
  state.mapLayers.forEach(layer => state.map.removeLayer(layer));
  state.mapLayers = [];
}

function drawJourney(journey) {
  clearMap();
  const coordinates = [];
  const stopIds = [journey.legs[0].from_stop_id, ...journey.legs.map(leg => leg.to_stop_id)];
  journey.legs.forEach((leg, index) => {
    const from = state.stopById.get(leg.from_stop_id), to = state.stopById.get(leg.to_stop_id);
    if (!from || !to) return;
    const points = [[from.lat, from.lng], [to.lat, to.lng]];
    coordinates.push(...points);
    const line = L.polyline(points, { color: colorHex(leg.jeep_color), weight: 6, opacity: .85 }).addTo(state.map);
    line.bindPopup(`<strong>${esc(leg.signboard)}</strong><br>${esc(from.name)} → ${esc(to.name)}`);
    state.mapLayers.push(line);
  });
  [...new Set(stopIds)].forEach((id, index) => {
    const stop = state.stopById.get(id);
    if (!stop) return;
    const marker = L.marker([stop.lat, stop.lng]).addTo(state.map)
      .bindPopup(`<strong>${index === 0 ? "Origin" : id === stopIds.at(-1) ? "Destination" : "Transfer stop"}:</strong><br>${esc(stop.name)}`);
    state.mapLayers.push(marker);
  });
  if (coordinates.length) state.map.fitBounds(coordinates, { padding: [35, 35], maxZoom: 13 });
}

function colorHex(color) {
  return ({ yellow: "#e7ad25", green: "#39945a", gray: "#66736f", checkered: "#3c4a46" })[normalizeColor(color)];
}

function renderDirectory() {
  const query = ($("#stop-search")?.value || "").toLowerCase().trim();
  const municipality = $("#municipality-filter")?.value || "";
  const visible = state.stops.filter(stop =>
    (!municipality || stop.municipality === municipality) &&
    `${stop.name} ${stop.municipality}`.toLowerCase().includes(query)
  );
  $("#stops-grid").innerHTML = visible.length ? visible.map(stop => {
    const count = state.routes.filter(r => r.from_stop_id === stop.stop_id || r.to_stop_id === stop.stop_id).length;
    return `<article class="stop-card">
      <h3>${esc(stop.name)}</h3><p>${esc(stop.municipality)}</p>
      <div class="stop-meta"><span>${count} route connection${count === 1 ? "" : "s"}</span>
      <span>${stop.lat.toFixed(4)}, ${stop.lng.toFixed(4)}</span></div>
      <button class="text-button set-origin" data-stop-id="${esc(stop.stop_id)}"><i data-lucide="corner-up-left"></i> Set as origin</button>
    </article>`;
  }).join("") : `<p class="empty-state">No stops match that search.</p>`;
  $$(".set-origin").forEach(button => button.addEventListener("click", () => {
    $("#origin").value = button.dataset.stopId;
    document.querySelector('[data-view-link="planner"]').click();
  }));
  if (window.lucide) lucide.createIcons();
}

function renderCatalog() {
  if (!$("#routes-list")) return;
  const query = ($("#route-search")?.value || "").toLowerCase().trim();
  const rows = state.routes.filter(route => {
    const from = state.stopById.get(route.from_stop_id), to = state.stopById.get(route.to_stop_id);
    return `${route.signboard} ${route.notes} ${from?.municipality || ""} ${to?.municipality || ""}`
      .toLowerCase().includes(query);
  });
  $("#routes-list").innerHTML = rows.length ? rows.map(route => {
    const from = state.stopById.get(route.from_stop_id), to = state.stopById.get(route.to_stop_id);
    return `<div class="catalog-route">
      <span class="jeep-badge ${normalizeColor(route.jeep_color)}">J</span>
      <div><strong>${esc(route.signboard)}</strong>
      <small>${esc(from?.name || route.from_stop_id)} → ${esc(to?.name || route.to_stop_id)} · ₱${num(route.regular_fare).toFixed(2)}</small></div>
    </div>`;
  }).join("") : `<p class="empty-state">No routes match that search.</p>`;
}

function updateFareEstimate() {
  if (!$("#fare-estimate")) return;
  const km = Math.max(0, num($("#distance-km").value));
  /* Sample calculator assumptions only; replace with current official fare table. */
  const isModern = $("#jeep-type").value === "modern";
  const baseFare = isModern ? 15 : 13;
  const includedKm = 4;
  const perKm = isModern ? 2.20 : 1.80;
  const regular = baseFare + Math.max(0, km - includedKm) * perKm;
  const fare = $("#calc-passenger").value === "discounted" ? regular * 0.8 : regular;
  $("#fare-estimate").innerHTML = `<span>Estimated fare</span><strong>₱${fare.toFixed(2)}</strong>
    <small>${km.toFixed(1)} km · ${isModern ? "Modern" : "Traditional"} · ${$("#calc-passenger").value === "discounted" ? "discount estimate applied" : "regular"}</small>`;
}

function locateNearestStop() {
  const status = $("#planner-status");
  if (!navigator.geolocation) { status.textContent = "Geolocation is not supported by this browser."; return; }
  status.textContent = "Requesting your location…";
  navigator.geolocation.getCurrentPosition(position => {
    const { latitude, longitude } = position.coords;
    const nearest = state.stops.map(stop => ({
      stop, distance: haversineKm(latitude, longitude, stop.lat, stop.lng)
    })).sort((a, b) => a.distance - b.distance)[0];
    if (!nearest) { status.textContent = "No stops are available to compare."; return; }
    $("#origin").value = nearest.stop.stop_id;
    status.textContent = `Nearest stop: ${nearest.stop.name} · about ${formatDistance(nearest.distance)} away.`;
    state.map.setView([latitude, longitude], 13);
    const marker = L.marker([latitude, longitude]).addTo(state.map).bindPopup("Your approximate location").openPopup();
    state.mapLayers.push(marker);
  }, error => {
    status.textContent = error.code === 1
      ? "Location permission was denied. You can choose your starting stop from the list."
      : "Couldn't determine your location. Try choosing a stop manually.";
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function formatDistance(km) { return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`; }

function toggleTheme() {
  document.body.classList.toggle("dark");
  localStorage.setItem("bp-dark", document.body.classList.contains("dark") ? "1" : "0");
  $("#theme-toggle").innerHTML = document.body.classList.contains("dark")
    ? '<i data-lucide="sun"></i>' : '<i data-lucide="moon"></i>';
  if (window.lucide) lucide.createIcons();
}
function applySavedTheme() {
  if (localStorage.getItem("bp-dark") === "1") document.body.classList.add("dark");
}

async function submitContribution(event) {
  event.preventDefault();
  const values = {
    type: $("#report-type").value,
    location: $("#report-location").value.trim(),
    details: $("#report-details").value.trim(),
    contact: $("#report-contact").value.trim()
  };
  const status = $("#form-status");
  if (FORM_ENDPOINT) {
    try {
      const response = await fetch(FORM_ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(values)
      });
      if (!response.ok) throw new Error("Submission failed.");
      status.textContent = "Thanks! Your contribution was submitted.";
      event.target.reset();
    } catch (error) {
      status.textContent = "Online submission was unavailable. Opening your email app instead.";
      openMailto(values);
    }
  } else {
    status.textContent = "Your email app will open with the contribution prepared.";
    openMailto(values);
  }
}
function openMailto(values) {
  const subject = encodeURIComponent(`Biyaheng Pampanga: ${values.type}`);
  const body = encodeURIComponent(
    `Type: ${values.type}\nRoute/stop: ${values.location}\nDetails: ${values.details}\nContact: ${values.contact || "Not provided"}`
  );
  window.location.href = `mailto: biyahengpampanga@example.com?subject=${subject}&body=${body}`;
}