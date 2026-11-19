/* Published Google Sheets CSV endpoints. Replace with your published CSV URLs as needed. */
const STOPS_CSV_URL = "./stops.csv";
const ROUTES_CSV_URL = "./routes.csv";
/* Optional free Formspree endpoint, e.g. https://formspree.io/f/xxxxxxx. */
const FORM_ENDPOINT = "";
const state = { stops: [], routes: [], stopById: new Map() };
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const esc = (value = "") => String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

document.addEventListener("DOMContentLoaded", init);

async function init() {
  wireNavigation();
  wireControls();
  applySavedTheme();
  await loadData();
  populateSelects();
  populateMunicipalityFilter();
  renderDirectory();
  renderCatalog();
  updateFareEstimate();
  renderGoogleMap();
  if (!$("#planner-status").textContent) $("#planner-status").textContent = `Loaded ${state.stops.length} stops and ${state.routes.length} route connections.`;
  if (window.lucide) lucide.createIcons();
}

function wireNavigation() {
  $$('[data-view-link]').forEach(button => button.addEventListener("click", () => {
    const view = button.dataset.viewLink;
    $$(".view").forEach(el => el.classList.toggle("active", el.id === `view-${view}`));
    $$('[data-view-link]').forEach(el => el.classList.toggle("active", el.dataset.viewLink === view));
    if (view === "planner") setTimeout(() => renderGoogleMap(), 80);
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
  const configured = STOPS_CSV_URL && ROUTES_CSV_URL && !STOPS_CSV_URL.includes("PASTE_") && !ROUTES_CSV_URL.includes("PASTE_");
  if (configured && window.Papa) {
    try {
      const [stopsText, routesText] = await Promise.all([fetchCsv(STOPS_CSV_URL), fetchCsv(ROUTES_CSV_URL)]);
      const stopsResult = Papa.parse(stopsText, {header:true,skipEmptyLines:true,transformHeader:h=>h.trim()});
      const routesResult = Papa.parse(routesText, {header:true,skipEmptyLines:true,transformHeader:h=>h.trim()});
      const stops = stopsResult.data.filter(r=>r.stop_id&&r.name).map(r=>({stop_id:r.stop_id.trim(),name:r.name.trim(),municipality:(r.municipality||"Other").trim(),lat:num(r.lat,NaN),lng:num(r.lng,NaN)})).filter(s=>Number.isFinite(s.lat)&&Number.isFinite(s.lng));
      const routes = routesResult.data.filter(r=>r.route_id&&r.from_stop_id&&r.to_stop_id).map(r=>({route_id:r.route_id.trim(),signboard:(r.signboard||"Jeepney route").trim(),jeep_color:normalizeColor(r.jeep_color),from_stop_id:r.from_stop_id.trim(),to_stop_id:r.to_stop_id.trim(),regular_fare:num(r.regular_fare),discounted_fare:num(r.discounted_fare,num(r.regular_fare)*.8),notes:(r.notes||"").trim()}));
      if (!stops.length || !routes.length) throw new Error("Published sheets contained no usable rows.");
      state.stops=stops; state.routes=routes;
    } catch (error) {
      console.warn("Live CSV unavailable; falling back to bundled data.",error);
      state.stops=fallback.stops||[]; state.routes=fallback.routes||[];
      $("#planner-status").textContent="Using built-in sample data; the live sheet could not be loaded.";
    }
  } else { state.stops=fallback.stops||[]; state.routes=fallback.routes||[]; }
  state.stopById=new Map(state.stops.map(stop=>[stop.stop_id,stop]));
}
async function fetchCsv(url) { const response=await fetch(url,{cache:"no-store"}); if(!response.ok) throw new Error(`CSV request failed (${response.status}).`); return response.text(); }
function normalizeColor(color) { const value=String(color||"gray").toLowerCase().trim(); return ["gray","yellow","green","checkered"].includes(value)?value:"gray"; }

function populateSelects() {
  const groups=groupStops();
  ["#origin","#destination"].forEach(selector=>{
    const select=$(selector);
    select.innerHTML='<option value="">Choose a stop…</option>'+[...groups.entries()].map(([municipality,stops])=>`<optgroup label="${esc(municipality)}">${stops.map(stop=>`<option value="${esc(stop.stop_id)}">${esc(stop.name)}</option>`).join("")}</optgroup>`).join("");
  });
  if(state.stops.length>1){$("#origin").value=state.stops[0].stop_id;$("#destination").value=state.stops[1].stop_id;}
}
function groupStops() { const groups=new Map(); state.stops.forEach(stop=>{if(!groups.has(stop.municipality))groups.set(stop.municipality,[]);groups.get(stop.municipality).push(stop);}); return new Map([...groups.entries()].sort(([a],[b])=>a.localeCompare(b))); }
function populateMunicipalityFilter() { const select=$("#municipality-filter"); [...new Set(state.stops.map(s=>s.municipality))].sort().forEach(m=>{const option=document.createElement("option");option.value=m;option.textContent=m;select.append(option);}); }

function planJourney() {
  const originId=$("#origin").value,destinationId=$("#destination").value,status=$("#planner-status"),results=$("#route-results");
  results.innerHTML="";
  if(!originId||!destinationId){status.textContent="Choose both a starting point and destination.";return;}
  if(originId===destinationId){status.textContent="Choose two different stops.";return;}
  const discounted=$("#passenger-type").value==="discounted";
  const journeys=findJourneys(originId,destinationId,discounted);
  if(!journeys.length){status.textContent="No route found in the available stop and route data.";renderGoogleMap();return;}
  status.textContent=`Found ${journeys.length} option${journeys.length===1?"":"s"} using the fewest rides available (no ride-count limit).`;
  journeys.slice(0,5).forEach((journey,index)=>{
    const card=document.createElement("article"); card.className=`route-card${index===0?" best":""}`;
    card.innerHTML=`<div class="route-card-head"><strong>${index===0?"Recommended · ":""}${journey.legs.length} ride${journey.legs.length===1?"":"s"}</strong><span class="fare-pill">₱${journey.fare.toFixed(2)}</span></div>${journey.legs.map((leg,i)=>{const from=state.stopById.get(leg.from_stop_id),to=state.stopById.get(leg.to_stop_id);return `<div class="trip-leg"><span class="jeep-badge ${normalizeColor(leg.jeep_color)}">${i+1}</span><div><strong>${esc(leg.signboard)}</strong><p>Board: ${esc(from?.name||leg.from_stop_id)} → Drop off: ${esc(to?.name||leg.to_stop_id)}</p></div></div>${leg.notes?`<p class="notes">${esc(leg.notes)}</p>`:""}`}).join("")}<a class="maps-link" target="_blank" rel="noopener" href="${googleMapsUrl(journey)}"><i data-lucide="external-link"></i> Open directions in Google Maps</a>`;
    results.append(card);
  });
  renderGoogleMap(journeys[0]);
  if(window.lucide)lucide.createIcons();
}

/* Unlimited ride depth: BFS advances one ride at a time, and stops after examining
   the complete first level that reaches the destination. It therefore returns
   lowest-ride paths, sorted by fare, without enumerating longer cyclic journeys. */
function findJourneys(originId,destinationId,discounted) {
  let frontier=[{stopId:originId,legs:[],visited:new Set([originId]),fare:0}];
  while(frontier.length) {
    const nextLevel=[],found=[];
    for(const current of frontier) for(const route of state.routes) {
      if(route.from_stop_id!==current.stopId||current.visited.has(route.to_stop_id))continue;
      const fare=num(discounted?route.discounted_fare:route.regular_fare);
      const next={stopId:route.to_stop_id,legs:[...current.legs,route],visited:new Set([...current.visited,route.to_stop_id]),fare:current.fare+fare};
      if(next.stopId===destinationId)found.push(next); else nextLevel.push(next);
    }
    if(found.length){found.sort((a,b)=>a.fare-b.fare);return found;}
    frontier=nextLevel;
  }
  return [];
}

function googleMapsUrl(journey) {
  const from=state.stopById.get(journey.legs[0].from_stop_id),to=state.stopById.get(journey.legs.at(-1).to_stop_id);
  const params=new URLSearchParams({api:"1",origin:`${from.lat},${from.lng}`,destination:`${to.lat},${to.lng}`,travelmode:"driving"});
  const waypoints=journey.legs.slice(0,-1).map(leg=>state.stopById.get(leg.to_stop_id)).filter(Boolean).map(s=>`${s.lat},${s.lng}`).join("|");
  if(waypoints)params.set("waypoints",waypoints);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/* Google's public Maps embed search mode does not require an API key. The iframe
   displays a place/area; actual turn-by-turn route is opened via the link above. */
function renderGoogleMap(journey=null) {
  const frame=$("#map"); if(!frame)return;
  let query="Pampanga Philippines";
  if(journey?.legs?.length){const from=state.stopById.get(journey.legs[0].from_stop_id),to=state.stopById.get(journey.legs.at(-1).to_stop_id);if(from&&to)query=`${from.lat},${from.lng} to ${to.lat},${to.lng}`;}
  frame.src=`https://www.google.com/maps?q=${encodeURIComponent(query)}&output=embed`;
}

function renderDirectory() {
  if(!$("#stops-grid"))return;
  const query=$("#stop-search").value.toLowerCase().trim(),municipality=$("#municipality-filter").value;
  const visible=state.stops.filter(s=>(!municipality||s.municipality===municipality)&&`${s.name} ${s.municipality}`.toLowerCase().includes(query));
  $("#stops-grid").innerHTML=visible.length?visible.map(stop=>{const count=state.routes.filter(r=>r.from_stop_id===stop.stop_id||r.to_stop_id===stop.stop_id).length;return `<article class="stop-card"><h3>${esc(stop.name)}</h3><p>${esc(stop.municipality)}</p><div class="stop-meta"><span>${count} route connection${count===1?"":"s"}</span><span>${stop.lat.toFixed(4)}, ${stop.lng.toFixed(4)}</span></div><button class="text-button set-origin" data-stop-id="${esc(stop.stop_id)}"><i data-lucide="corner-up-left"></i> Set as origin</button></article>`}).join(""):'<p class="empty-state">No stops match that search.</p>';
  $$(".set-origin").forEach(button=>button.addEventListener("click",()=>{$("#origin").value=button.dataset.stopId;document.querySelector('[data-view-link="planner"]').click();}));
  if(window.lucide)lucide.createIcons();
}
function renderCatalog() {
  if(!$("#routes-list"))return;
  const query=$("#route-search").value.toLowerCase().trim();
  const rows=state.routes.filter(route=>{const from=state.stopById.get(route.from_stop_id),to=state.stopById.get(route.to_stop_id);return `${route.signboard} ${route.notes} ${from?.municipality||""} ${to?.municipality||""}`.toLowerCase().includes(query);});
  $("#routes-list").innerHTML=rows.length?rows.map(route=>{const from=state.stopById.get(route.from_stop_id),to=state.stopById.get(route.to_stop_id);return `<div class="catalog-route"><span class="jeep-badge ${normalizeColor(route.jeep_color)}">J</span><div><strong>${esc(route.signboard)}</strong><small>${esc(from?.name||route.from_stop_id)} → ${esc(to?.name||route.to_stop_id)} · ₱${num(route.regular_fare).toFixed(2)}</small></div></div>`}).join(""):'<p class="empty-state">No routes match that search.</p>';
}

function updateFareEstimate() {
  if(!$("#fare-estimate"))return;
  const km=Math.max(0,num($("#distance-km").value)),modern=$("#jeep-type").value==="modern";
  /* Illustrative calculator values only. Replace with an up-to-date official fare table. */
  const base=modern?15:13,perKm=modern?2.2:1.8,regular=base+Math.max(0,km-4)*perKm;
  const discounted=$("#calc-passenger").value==="discounted",fare=discounted?regular*.8:regular;
  $("#fare-estimate").innerHTML=`<span>Estimated fare</span><strong>₱${fare.toFixed(2)}</strong><small>${km.toFixed(1)} km · ${modern?"Modern":"Traditional"} · ${discounted?"discount estimate applied":"regular"}</small>`;
}
function locateNearestStop() {
  const status=$("#planner-status");
  if(!navigator.geolocation){status.textContent="Geolocation is not supported by this browser.";return;}
  status.textContent="Requesting your location…";
  navigator.geolocation.getCurrentPosition(position=>{const {latitude,longitude}=position.coords;const nearest=state.stops.map(stop=>({stop,distance:haversineKm(latitude,longitude,stop.lat,stop.lng)})).sort((a,b)=>a.distance-b.distance)[0];if(!nearest){status.textContent="No stops are available to compare.";return;}$("#origin").value=nearest.stop.stop_id;status.textContent=`Nearest stop: ${nearest.stop.name} · about ${formatDistance(nearest.distance)} away.`;renderGoogleMap();},error=>{status.textContent=error.code===1?"Location permission was denied. Choose your starting stop from the list.":"Couldn't determine your location. Try choosing a stop manually.";},{enableHighAccuracy:true,timeout:10000,maximumAge:60000});
}
function haversineKm(lat1,lon1,lat2,lon2){const rad=v=>v*Math.PI/180,dLat=rad(lat2-lat1),dLon=rad(lon2-lon1),a=Math.sin(dLat/2)**2+Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLon/2)**2;return 6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));}
function formatDistance(km){return km<1?`${Math.round(km*1000)} m`:`${km.toFixed(1)} km`;}
function toggleTheme(){document.body.classList.toggle("dark");localStorage.setItem("bp-dark",document.body.classList.contains("dark")?"1":"0");$("#theme-toggle").innerHTML=document.body.classList.contains("dark")?'<i data-lucide="sun"></i>':'<i data-lucide="moon"></i>';if(window.lucide)lucide.createIcons();}
function applySavedTheme(){if(localStorage.getItem("bp-dark")==="1")document.body.classList.add("dark");}

async function submitContribution(event) {
  event.preventDefault();
  const values={type:$("#report-type").value,location:$("#report-location").value.trim(),details:$("#report-details").value.trim(),contact:$("#report-contact").value.trim()},status=$("#form-status");
  if(FORM_ENDPOINT){try{const response=await fetch(FORM_ENDPOINT,{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify(values)});if(!response.ok)throw new Error("Submission failed.");status.textContent="Thanks! Your contribution was submitted.";event.target.reset();}catch(error){status.textContent="Online submission failed. Opening your email app as a fallback.";openMailto(values);}}
  else{status.textContent="Your email app will open with the contribution prepared.";openMailto(values);}
}
function openMailto(values){const subject=encodeURIComponent(`Biyaheng Pampanga: ${values.type}`),body=encodeURIComponent(`Type: ${values.type}\nRoute/stop: ${values.location}\nDetails: ${values.details}\nContact: ${values.contact||"Not provided"}`);window.location.href=`mailto:biyahengpampanga@example.com?subject=${subject}&body=${body}`;}
