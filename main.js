"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const DEFAULT_MAPBOX_TOKEN = "pk.eyJ1IjoiZWxpYW4zMTc4IiwiYSI6ImNtcnZlZGpkdDBvbXgyd3B2eGMyajdseDUifQ.GlgugnGUmcRzqOLIaF_16w";
const API_URL = "https://data.cityofnewyork.us/resource/43nn-pn8j.json";
const API_FIELDS = [
  "camis","dba","boro","building","street","zipcode","cuisine_description",
  "grade","score","inspection_date","latitude","longitude"
].join(",");

const state = {
  all: [],
  filtered: [],
  scoreRange: null,
  selected: null,
  destination: null,
  map: null,
  mapReady: false,
  token: "",
  syncViewport: false,
  contextMap: null,
  contextMapReady: false,
  contextLayer: "density",
  questionShareMode: false,
  argumentTotalMode: false,
  cart: [],
  tipPercent: 15,
  route: { distanceMi: null, minutes: null, geometry: null },
  scenario: { wait: 8, pickup: 4, risk: 40 }
};

const el = {
  progress: $("#scrollProgress"),
  tokenPanel: $("#tokenPanel"), tokenInput: $("#tokenInput"), tokenMessage: $("#tokenMessage"),
  tokenButton: $("#openTokenPanel"), closeToken: $("#closeTokenPanel"), connectMap: $("#connectMap"), clearToken: $("#clearToken"),
  placeholderTokenButton: $("#placeholderTokenButton"), mapPlaceholder: $("#mapPlaceholder"),
  dataStatus: $("#dataStatus"), search: $("#searchInput"), borough: $("#boroughFilter"), grade: $("#gradeFilter"), reset: $("#resetFilters"),
  resultCount: $("#resultCount"), selected: $("#selectedRestaurant"), routeToColumbia: $("#routeToColumbia"), clearRoute: $("#clearRoute"),
  distance: $("#distanceValue"), duration: $("#durationValue"), pay: $("#payValue"),
  menu: $("#menuList"), cartCount: $("#cartCount"), cartItems: $("#cartItems"), cartTotal: $("#cartTotal"), placeOrder: $("#placeOrder"),
  tipSlider: $("#tipSlider"), tipLabel: $("#tipLabel"), sync: $("#syncViewport"), scoreLabel: $("#scoreLabel"), restaurantStrip: $("#restaurantStrip"),
  waitSlider: $("#waitSlider"), waitLabel: $("#waitLabel"), pickupSlider: $("#pickupSlider"), pickupLabel: $("#pickupLabel"), riskSlider: $("#riskSlider"), riskLabel: $("#riskLabel"),
  caseIdentity: $("#caseIdentity"), platformTime: $("#platformTime"), platformDistance: $("#platformDistance"), platformPay: $("#platformPay"),
  workerTime: $("#workerTime"), hiddenTime: $("#hiddenTime"), hourlyPay: $("#hourlyPay"), batteryUse: $("#batteryUse"), workerRisk: $("#workerRisk"), gapStatement: $("#gapStatement"),
  confirmation: $("#confirmation"), orderNumber: $("#orderNumber"), closeConfirmation: $("#closeConfirmation")
};

function safe(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function address(item) {
  return [item.building, item.street, item.boro, item.zipcode].filter(Boolean).join(" · ");
}

function normalize(row) {
  const score = Number(row.score);
  return {
    id: row.camis,
    name: row.dba || "Unnamed restaurant",
    boro: row.boro || "Unknown",
    building: row.building || "",
    street: row.street || "",
    zipcode: row.zipcode || "",
    cuisine: row.cuisine_description || "Other",
    grade: row.grade || "N/A",
    score: Number.isFinite(score) ? score : null,
    inspectionDate: row.inspection_date || "",
    lat: Number(row.latitude),
    lng: Number(row.longitude)
  };
}

function dedupe(rows) {
  const seen = new Set();
  return rows.reduce((result, row) => {
    if (!row.camis || seen.has(row.camis)) return result;
    const item = normalize(row);
    if (!Number.isFinite(item.lat) || !Number.isFinite(item.lng)) return result;
    seen.add(row.camis);
    result.push(item);
    return result;
  }, []);
}

async function loadData() {
  el.dataStatus.querySelector("strong").textContent = "CONNECTING";
  try {
    const params = new URLSearchParams({
      "$select": API_FIELDS,
      "$where": "grade in('A','B','C') AND latitude IS NOT NULL AND longitude IS NOT NULL",
      "$order": "inspection_date DESC",
      "$limit": "5000"
    });
    const response = await fetch(`${API_URL}?${params}`, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`NYC Open Data returned ${response.status}`);
    state.all = dedupe(await response.json());
    state.filtered = [...state.all];
    populateFilters();
    applyFilters();
    el.dataStatus.classList.add("live");
    el.dataStatus.querySelector("strong").textContent = `${state.all.length.toLocaleString()} LIVE RECORDS`;
    renderLiveFoundationVisuals();
  } catch (error) {
    console.error(error);
    el.dataStatus.querySelector("strong").textContent = "DATA CONNECTION FAILED";
    el.restaurantStrip.innerHTML = `<div class="loading-records">${safe(error.message)} · Run through Live Server or GitHub Pages.</div>`;
    drawCharts([]);
  }
}

function populateFilters() {
  const boroughs = [...new Set(state.all.map(d => d.boro))].sort();
  el.borough.innerHTML = `<option value="ALL">ALL BOROUGHS</option>${boroughs.map(d => `<option value="${safe(d)}">${safe(d)}</option>`).join("")}`;
}

function applyFilters() {
  const query = el.search.value.trim().toLowerCase();
  const boro = el.borough.value;
  const grade = el.grade.value;
  state.filtered = state.all.filter(d => {
    const text = `${d.name} ${d.cuisine} ${d.street} ${d.boro}`.toLowerCase();
    const scoreMatch = !state.scoreRange || (d.score !== null && d.score >= state.scoreRange[0] && d.score <= state.scoreRange[1]);
    return (!query || text.includes(query)) && (boro === "ALL" || d.boro === boro) && (grade === "ALL" || d.grade === grade) && scoreMatch;
  });
  el.resultCount.textContent = `${state.filtered.length.toLocaleString()} RECORDS`;
  updateMapData();
  drawCharts(currentChartData());
  renderRestaurantStrip();
  renderLiveFoundationVisuals();
}

function currentChartData() {
  if (!state.syncViewport || !state.mapReady) return state.filtered;
  const bounds = state.map.getBounds();
  return state.filtered.filter(d => bounds.contains([d.lng, d.lat]));
}

function geojson(data = state.filtered) {
  return {
    type: "FeatureCollection",
    features: data.map(d => ({
      type: "Feature",
      id: d.id,
      geometry: { type: "Point", coordinates: [d.lng, d.lat] },
      properties: { id: d.id, name: d.name, cuisine: d.cuisine, grade: d.grade, score: d.score ?? "", address: address(d) }
    }))
  };
}

function openTokenPanel() {
  el.tokenPanel.classList.add("open");
  el.tokenPanel.setAttribute("aria-hidden", "false");
  setTimeout(() => el.tokenInput.focus(), 100);
}
function closeTokenPanel() {
  el.tokenPanel.classList.remove("open");
  el.tokenPanel.setAttribute("aria-hidden", "true");
}

function initMap(token) {
  const clean = token.trim();
  if (!clean.startsWith("pk.")) {
    el.tokenMessage.textContent = "Use a public Mapbox token beginning with pk.";
    el.tokenMessage.classList.add("error");
    return;
  }
  if (!window.mapboxgl) {
    el.tokenMessage.textContent = "Mapbox GL JS did not load.";
    el.tokenMessage.classList.add("error");
    return;
  }
  state.token = clean;
  mapboxgl.accessToken = clean;
  localStorage.setItem("ib_mapbox_token", clean);
  el.tokenMessage.textContent = "Connecting…";
  el.tokenMessage.classList.remove("error");

  if (state.map) state.map.remove();
  state.mapReady = false;
  state.map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/dark-v11",
    center: [-73.9857, 40.7484],
    zoom: 10.2,
    pitch: 25,
    bearing: -8,
    antialias: true
  });
  state.map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");
  state.map.addControl(new mapboxgl.FullscreenControl(), "top-right");

  state.map.on("load", () => {
    state.mapReady = true;
    el.mapPlaceholder.classList.add("hidden");
    el.tokenButton.classList.add("connected");
    el.tokenMessage.textContent = "Connected. Token saved in this browser.";
    closeTokenPanel();

    state.map.addSource("restaurants", { type: "geojson", data: geojson(), cluster: true, clusterMaxZoom: 14, clusterRadius: 45, promoteId: "id" });
    state.map.addLayer({ id: "clusters", type: "circle", source: "restaurants", filter: ["has", "point_count"], paint: {
      "circle-color": ["step", ["get", "point_count"], "#73101c", 30, "#a91329", 100, "#d61e38", 250, "#ff2845"],
      "circle-radius": ["step", ["get", "point_count"], 15, 30, 21, 100, 28, 250, 35],
      "circle-stroke-width": 1, "circle-stroke-color": "rgba(255,255,255,.55)", "circle-opacity": .9
    }});
    state.map.addLayer({ id: "cluster-count", type: "symbol", source: "restaurants", filter: ["has", "point_count"], layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 11 }, paint: { "text-color": "#fff" } });
    state.map.addLayer({ id: "points", type: "circle", source: "restaurants", filter: ["!", ["has", "point_count"]], paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 3.4, 14, 7.4, 18, 11],
      "circle-color": ["match", ["get", "grade"], "A", "#ff2845", "B", "#941124", "C", "#ff7583", "#71676a"],
      "circle-stroke-width": 1.2, "circle-stroke-color": "#130408", "circle-opacity": .88
    }});
    state.map.addLayer({ id: "selected-point", type: "circle", source: "restaurants", filter: ["==", ["get", "id"], ""], paint: { "circle-radius": 15, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#fff", "circle-stroke-width": 3 } });
    state.map.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    state.map.addLayer({ id: "route-glow", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ff2845", "line-width": 12, "line-opacity": .18, "line-blur": 4 } });
    state.map.addLayer({ id: "route", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ff2845", "line-width": 4, "line-opacity": .96, "line-dasharray": [1.2, 1.2] } });
    state.map.addSource("destination", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    state.map.addLayer({ id: "destination", type: "circle", source: "destination", paint: { "circle-radius": 9, "circle-color": "#050505", "circle-stroke-color": "#ff7583", "circle-stroke-width": 3 } });

    state.map.on("click", "clusters", event => {
      const feature = event.features[0];
      state.map.getSource("restaurants").getClusterExpansionZoom(feature.properties.cluster_id, (error, zoom) => {
        if (!error) state.map.easeTo({ center: feature.geometry.coordinates, zoom });
      });
    });
    state.map.on("click", "points", event => {
      event.originalEvent.cancelBubble = true;
      const feature = event.features[0];
      selectRestaurant(feature.properties.id, false);
      new mapboxgl.Popup({ offset: 12 }).setLngLat(feature.geometry.coordinates).setHTML(
        `<div class="map-popup"><span>${safe(feature.properties.cuisine)} · GRADE ${safe(feature.properties.grade)}</span><h4>${safe(feature.properties.name)}</h4><p>${safe(feature.properties.address)}</p></div>`
      ).addTo(state.map);
    });
    state.map.on("mouseenter", "points", () => state.map.getCanvas().style.cursor = "pointer");
    state.map.on("mouseleave", "points", () => state.map.getCanvas().style.cursor = "");
    state.map.on("mouseenter", "clusters", () => state.map.getCanvas().style.cursor = "zoom-in");
    state.map.on("mouseleave", "clusters", () => state.map.getCanvas().style.cursor = "");
    state.map.on("click", event => {
      if (!state.selected) return;
      const hit = state.map.queryRenderedFeatures(event.point, { layers: ["points", "clusters"] });
      if (hit.length) return;
      setDestination([event.lngLat.lng, event.lngLat.lat]);
    });
    state.map.on("moveend", () => {
      if (state.syncViewport) drawCharts(currentChartData());
    });
    updateMapData();
    initContextMap(clean);
    if (state.selected) selectRestaurant(state.selected.id, false);
  });

  state.map.on("error", event => {
    const message = event.error?.message || "Mapbox could not initialize.";
    console.error(message);
    if (/token|401|403/i.test(message)) {
      el.tokenMessage.textContent = message;
      el.tokenMessage.classList.add("error");
      el.mapPlaceholder.classList.remove("hidden");
    }
  });
}

function updateMapData() {
  if (state.mapReady && state.map.getSource("restaurants")) state.map.getSource("restaurants").setData(geojson());
  updateContextMapData();
}

function renderRestaurantStrip() {
  const records = state.filtered.slice(0, 18);
  if (!records.length) {
    el.restaurantStrip.innerHTML = `<div class="loading-records">No restaurant records match these filters.</div>`;
    return;
  }
  el.restaurantStrip.innerHTML = records.map(d => `
    <article class="restaurant-record" data-id="${safe(d.id)}" tabindex="0" role="button">
      <span>${safe(d.cuisine)} · ${safe(d.boro)}</span>
      <h4>${safe(d.name)}</h4>
      <p>${safe(address(d))}</p>
      <footer><small>SCORE ${d.score ?? "N/A"}</small><b>${safe(d.grade)}</b></footer>
    </article>`).join("");
  $$(".restaurant-record", el.restaurantStrip).forEach(card => {
    const activate = () => { selectRestaurant(card.dataset.id, true); $("#experiments").scrollIntoView({ behavior: "smooth", block: "start" }); };
    card.addEventListener("click", activate);
    card.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); } });
  });
}

function selectRestaurant(id, fly = true) {
  const item = state.all.find(d => d.id === id);
  if (!item) return;
  state.selected = item;
  state.cart = [];
  clearRoute(false);
  el.selected.innerHTML = `<small>SELECTED RESTAURANT · REAL RECORD</small><h3>${safe(item.name)}</h3><p>${safe(item.cuisine)} · ${safe(item.boro)} · GRADE ${safe(item.grade)} · SCORE ${item.score ?? "N/A"}<br>${safe(address(item))}</p>`;
  el.routeToColumbia.disabled = false;
  el.caseIdentity.innerHTML = `<span>ACTIVE CASE</span><strong>${safe(item.name)}</strong><p>${safe(item.cuisine)} · ${safe(address(item))}</p>`;
  renderMenu();
  renderCart();
  if (state.mapReady) {
    state.map.setFilter("selected-point", ["==", ["get", "id"], item.id]);
    if (fly) state.map.flyTo({ center: [item.lng, item.lat], zoom: 14.4, pitch: 34, essential: true });
  }
  updateCase();
}

const menuTemplates = {
  Chinese: [["Red Oil Dumplings",12.5],["Mapo Tofu Rice",16],["Scallion Noodles",14.5],["Black Sesame Bun",7.5]],
  Italian: [["Spicy Vodka Rigatoni",19],["Mushroom Pizza",21],["Little Gem Caesar",13],["Tiramisu",8.5]],
  Japanese: [["Miso Salmon Bowl",19.5],["Spicy Tuna Roll",13],["Vegetable Udon",16],["Matcha Pudding",7.5]],
  Mexican: [["Birria Tacos",17.5],["Chicken Mole Bowl",18],["Mushroom Tostada",13.5],["Churro Bites",7]],
  Pizza: [["Spicy Pepperoni Pie",24],["Mushroom Square",22],["Red Caesar",12],["Cannoli",7]],
  default: [["House Signature Bowl",16],["Crispy Chili Sandwich",15],["Roasted Market Plate",17.5],["Dark Chocolate Dessert",8]]
};

function menuForCuisine(cuisine) {
  const key = Object.keys(menuTemplates).find(k => k !== "default" && cuisine.toLowerCase().includes(k.toLowerCase()));
  return menuTemplates[key || "default"];
}

function renderMenu() {
  if (!state.selected) return;
  el.menu.innerHTML = menuForCuisine(state.selected.cuisine).map(([name, price], index) => `
    <div class="menu-item"><div><h4>${safe(name)}</h4><p>MODELED MENU ITEM</p></div><span>$${price.toFixed(2)}</span><button data-index="${index}" data-name="${safe(name)}" data-price="${price}" aria-label="Add ${safe(name)}">+</button></div>`).join("");
  $$(".menu-item button", el.menu).forEach(button => button.addEventListener("click", () => addCart(button.dataset.name, Number(button.dataset.price))));
}

function addCart(name, price) {
  const existing = state.cart.find(item => item.name === name);
  existing ? existing.quantity++ : state.cart.push({ name, price, quantity: 1 });
  renderCart();
}

function cartTotals() {
  const subtotal = state.cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const service = subtotal * .08;
  const delivery = subtotal ? 3.99 : 0;
  const tip = subtotal * state.tipPercent / 100;
  return { subtotal, service, delivery, tip, total: subtotal + service + delivery + tip };
}

function renderCart() {
  const count = state.cart.reduce((sum, item) => sum + item.quantity, 0);
  const totals = cartTotals();
  el.cartCount.textContent = count;
  el.cartItems.innerHTML = state.cart.length ? state.cart.map(item => `<div class="cart-line"><span>${safe(item.name)} × ${item.quantity}</span><b>$${(item.price * item.quantity).toFixed(2)}</b></div>`).join("") : `<p>Cart is empty.</p>`;
  el.tipLabel.textContent = `${state.tipPercent}%`;
  el.cartTotal.textContent = `$${totals.total.toFixed(2)}`;
  el.placeOrder.disabled = !count;
  updateCase();
}

function setDestination(coords) {
  state.destination = coords;
  if (state.mapReady) state.map.getSource("destination").setData({ type: "Feature", geometry: { type: "Point", coordinates: coords }, properties: {} });
  el.clearRoute.disabled = false;
  requestRoute();
}

async function requestRoute() {
  if (!state.selected || !state.destination || !state.token || !state.mapReady) return;
  el.distance.textContent = el.duration.textContent = "…";
  try {
    const start = `${state.selected.lng},${state.selected.lat}`;
    const end = state.destination.join(",");
    const response = await fetch(`https://api.mapbox.com/directions/v5/mapbox/cycling/${start};${end}?geometries=geojson&overview=full&steps=false&access_token=${encodeURIComponent(state.token)}`);
    if (!response.ok) throw new Error(`Directions returned ${response.status}`);
    const json = await response.json();
    const route = json.routes?.[0];
    if (!route) throw new Error("No cycling route returned.");
    state.route.distanceMi = route.distance / 1609.344;
    state.route.minutes = route.duration / 60;
    state.route.geometry = route.geometry;
    state.map.getSource("route").setData({ type: "Feature", geometry: route.geometry, properties: {} });
    const coords = route.geometry.coordinates;
    const bounds = coords.reduce((box, point) => box.extend(point), new mapboxgl.LngLatBounds(coords[0], coords[0]));
    state.map.fitBounds(bounds, { padding: 80, maxZoom: 15, duration: 1000 });
    updateCase();
  } catch (error) {
    console.error(error);
    el.distance.textContent = el.duration.textContent = "ERROR";
  }
}

function clearRoute(resetDestination = true) {
  state.route = { distanceMi: null, minutes: null, geometry: null };
  if (resetDestination) state.destination = null;
  el.distance.textContent = el.duration.textContent = el.pay.textContent = "—";
  el.clearRoute.disabled = true;
  if (state.mapReady) {
    state.map.getSource("route")?.setData({ type: "FeatureCollection", features: [] });
    state.map.getSource("destination")?.setData({ type: "FeatureCollection", features: [] });
  }
  updateCase();
}

function calculateCase() {
  const distance = state.route.distanceMi;
  const routeMinutes = state.route.minutes;
  if (!Number.isFinite(distance) || !Number.isFinite(routeMinutes)) return null;
  const basePay = 3.2 + distance * 1.4 + routeMinutes * .14;
  const hiddenMinutes = state.scenario.wait + state.scenario.pickup;
  const workerMinutes = routeMinutes + hiddenMinutes;
  const tip = cartTotals().tip;
  const hourly = (basePay + tip) / workerMinutes * 60;
  const battery = Math.min(100, distance * 5 + workerMinutes * .12);
  return { distance, routeMinutes, basePay, hiddenMinutes, workerMinutes, tip, hourly, battery, risk: state.scenario.risk };
}

function updateCase() {
  el.waitLabel.textContent = `${state.scenario.wait} MIN`;
  el.pickupLabel.textContent = `${state.scenario.pickup} MIN`;
  el.riskLabel.textContent = `${state.scenario.risk}%`;
  el.workerRisk.textContent = `${state.scenario.risk}%`;
  el.hiddenTime.textContent = `${state.scenario.wait + state.scenario.pickup} MIN`;
  const result = calculateCase();
  if (!result) {
    el.platformTime.textContent = el.platformDistance.textContent = el.platformPay.textContent = "—";
    el.workerTime.textContent = el.hourlyPay.textContent = el.batteryUse.textContent = "—";
    el.distance.textContent = el.duration.textContent = el.pay.textContent = "—";
    el.gapStatement.textContent = state.selected ? "SET A DELIVERY DESTINATION TO CALCULATE THE GAP." : "SELECT A RESTAURANT AND ROUTE TO CALCULATE INVISIBLE LABOR.";
    drawVisibilityChart(null);
    return;
  }
  el.distance.textContent = `${result.distance.toFixed(2)} MI`;
  el.duration.textContent = `${Math.round(result.routeMinutes)} MIN`;
  el.pay.textContent = `$${result.basePay.toFixed(2)}`;
  el.platformTime.textContent = `${Math.round(result.routeMinutes)}`;
  el.platformDistance.textContent = `${result.distance.toFixed(2)} MI`;
  el.platformPay.textContent = `$${result.basePay.toFixed(2)}`;
  el.workerTime.textContent = `${Math.round(result.workerMinutes)}`;
  el.hourlyPay.textContent = `$${result.hourly.toFixed(2)}/HR`;
  el.batteryUse.textContent = `${result.battery.toFixed(1)}%`;
  const hiddenShare = result.hiddenMinutes / result.workerMinutes * 100;
  el.gapStatement.textContent = `${result.hiddenMinutes} MINUTES — ${hiddenShare.toFixed(0)}% OF THIS DELIVERY — EXIST OUTSIDE THE PLATFORM'S ROUTE RECORD.`;
  drawVisibilityChart(result);
}

function drawCharts(data) {
  if (!window.d3) return;
  drawCuisine(data);
  drawGrade(data);
  drawScore(data);
}

function drawCuisine(data) {
  const root = d3.select("#cuisineChart"); root.selectAll("*").remove();
  const rows = d3.rollups(data, values => values.length, d => d.cuisine).sort((a,b) => b[1]-a[1]).slice(0,10);
  if (!rows.length) { root.append("div").attr("class","chart-empty").text("No cuisine data in this selection."); return; }
  const w=650,h=330,m={t:14,r:48,b:26,l:160};
  const x=d3.scaleLinear().domain([0,d3.max(rows,d=>d[1])||1]).nice().range([m.l,w-m.r]);
  const y=d3.scaleBand().domain(rows.map(d=>d[0])).range([m.t,h-m.b]).padding(.21);
  const svg=root.append("svg").attr("viewBox",`0 0 ${w} ${h}`).attr("role","img").attr("aria-label","Top cuisines bar chart");
  svg.append("g").attr("class","grid").attr("transform",`translate(0,${h-m.b})`).call(d3.axisBottom(x).ticks(5).tickSize(-(h-m.t-m.b))).call(g=>g.select(".domain").remove());
  svg.append("g").attr("class","axis").attr("transform",`translate(${m.l},0)`).call(d3.axisLeft(y).tickSize(0)).call(g=>g.select(".domain").remove());
  const bars=svg.selectAll(".d3-bar").data(rows).join("rect").attr("class",d=>`d3-bar${el.search.value===d[0]?" selected":""}`).attr("x",m.l).attr("y",d=>y(d[0])).attr("height",y.bandwidth()).attr("width",0).attr("tabindex",0).on("click keydown",(event,d)=>{
    if(event.type==="keydown"&&event.key!=="Enter"&&event.key!==" ")return;
    event.preventDefault(); el.search.value=el.search.value===d[0]?"":d[0]; applyFilters();
  });
  bars.transition().duration(550).attr("width",d=>Math.max(1,x(d[1])-m.l));
  svg.selectAll(".bar-value").data(rows).join("text").attr("class","bar-value").attr("x",d=>x(d[1])+7).attr("y",d=>y(d[0])+y.bandwidth()/2).attr("dominant-baseline","middle").text(d=>d[1]);
}

function drawGrade(data) {
  const root=d3.select("#gradeChart"); root.selectAll("*").remove();
  const rows=["A","B","C"].map(grade=>({grade,value:data.filter(d=>d.grade===grade).length}));
  const total=d3.sum(rows,d=>d.value); if(!total){root.append("div").attr("class","chart-empty").text("No grade data in this selection.");return;}
  const w=390,h=330,r=117,colors={A:"#ff2845",B:"#941124",C:"#ff7583"};
  const pie=d3.pie().sort(null).value(d=>d.value),arc=d3.arc().innerRadius(70).outerRadius(r);
  const svg=root.append("svg").attr("viewBox",`0 0 ${w} ${h}`).attr("role","img").attr("aria-label","Inspection grade donut chart");
  const g=svg.append("g").attr("transform",`translate(${w/2},${h/2-8})`);
  g.selectAll("path").data(pie(rows)).join("path").attr("class",d=>`grade-arc${el.grade.value===d.data.grade?" selected":""}`).attr("fill",d=>colors[d.data.grade]).attr("d",arc).attr("tabindex",0).on("click keydown",(event,d)=>{
    if(event.type==="keydown"&&event.key!=="Enter"&&event.key!==" ")return;
    event.preventDefault(); el.grade.value=el.grade.value===d.data.grade?"ALL":d.data.grade; applyFilters();
  });
  g.append("text").attr("class","donut-total").attr("text-anchor","middle").attr("y",-2).text(total.toLocaleString());
  g.append("text").attr("class","donut-label").attr("text-anchor","middle").attr("y",18).text("RESTAURANTS");
  rows.forEach((d,i)=>{const lg=svg.append("g").attr("transform",`translate(${32+i*110},${h-28})`);lg.append("rect").attr("width",10).attr("height",10).attr("fill",colors[d.grade]);lg.append("text").attr("class","legend-text").attr("x",17).attr("y",9).text(`${d.grade}  ${d.value}`);});
}

function drawScore(data) {
  const root=d3.select("#scoreChart"); root.selectAll("*").remove();
  const values=data.map(d=>d.score).filter(Number.isFinite); if(!values.length){root.append("div").attr("class","chart-empty").text("No inspection scores in this selection.");return;}
  const w=960,h=285,m={t:15,r:20,b:38,l:46};
  const x=d3.scaleLinear().domain([0,Math.max(50,d3.max(values))]).nice().range([m.l,w-m.r]);
  const bins=d3.bin().domain(x.domain()).thresholds(x.ticks(24))(values);
  const y=d3.scaleLinear().domain([0,d3.max(bins,d=>d.length)]).nice().range([h-m.b,m.t]);
  const svg=root.append("svg").attr("viewBox",`0 0 ${w} ${h}`).attr("role","img").attr("aria-label","Inspection score histogram with brush filter");
  svg.append("g").attr("class","grid").attr("transform",`translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickSize(-(w-m.l-m.r))).call(g=>g.select(".domain").remove());
  svg.selectAll(".hist-bar").data(bins).join("rect").attr("class","hist-bar").attr("x",d=>x(d.x0)+1).attr("y",d=>y(d.length)).attr("width",d=>Math.max(0,x(d.x1)-x(d.x0)-2)).attr("height",d=>y(0)-y(d.length));
  svg.append("g").attr("class","axis").attr("transform",`translate(0,${h-m.b})`).call(d3.axisBottom(x).ticks(12));
  const brush=d3.brushX().extent([[m.l,m.t],[w-m.r,h-m.b]]).on("end",event=>{
    if(!event.sourceEvent)return;
    if(!event.selection){state.scoreRange=null;el.scoreLabel.textContent="ALL SCORES";}
    else{const [a,b]=event.selection.map(x.invert);state.scoreRange=[Math.floor(a),Math.ceil(b)];el.scoreLabel.textContent=`SCORE ${state.scoreRange[0]}–${state.scoreRange[1]}`;}
    applyFilters();
  });
  svg.append("g").attr("class","brush").call(brush);
}

function drawVisibilityChart(result) {
  const root=d3.select("#visibilityChart"); root.selectAll("*").remove();
  if(!result){root.append("div").attr("class","chart-empty").text("Route a delivery to generate the comparison.");return;}
  const metrics=[
    {label:"TIME",unit:"MIN",platform:result.routeMinutes,worker:result.workerMinutes},
    {label:"WAITING",unit:"MIN",platform:0,worker:result.hiddenMinutes},
    {label:"RISK",unit:"%",platform:0,worker:result.risk},
    {label:"BATTERY",unit:"%",platform:0,worker:result.battery}
  ];
  const w=620,h=410,m={t:20,r:38,b:35,l:100};
  const groups=d3.scaleBand().domain(metrics.map(d=>d.label)).range([m.t,h-m.b]).padding(.24);
  const svg=root.append("svg").attr("viewBox",`0 0 ${w} ${h}`).attr("role","img").attr("aria-label","Platform record versus worker experience comparison chart");
  metrics.forEach(metric=>{
    const max=Math.max(metric.platform,metric.worker,1);
    const x=d3.scaleLinear().domain([0,max]).range([m.l,w-m.r]);
    const y=groups(metric.label);
    svg.append("text").attr("class","visibility-label").attr("x",0).attr("y",y+11).text(metric.label);
    svg.append("rect").attr("x",m.l).attr("y",y).attr("width",w-m.l-m.r).attr("height",13).attr("fill","rgba(255,255,255,.055)");
    svg.append("rect").attr("x",m.l).attr("y",y).attr("width",0).attr("height",13).attr("fill","#941124").transition().duration(550).attr("width",x(metric.platform)-m.l);
    svg.append("text").attr("class","visibility-value").attr("x",Math.max(m.l+4,x(metric.platform)+6)).attr("y",y+10).text(`PLATFORM ${formatMetric(metric.platform,metric.unit)}`);
    svg.append("rect").attr("x",m.l).attr("y",y+23).attr("width",w-m.l-m.r).attr("height",13).attr("fill","rgba(255,255,255,.055)");
    svg.append("rect").attr("x",m.l).attr("y",y+23).attr("width",0).attr("height",13).attr("fill","#ff2845").transition().duration(650).attr("width",x(metric.worker)-m.l);
    svg.append("text").attr("class","visibility-value").attr("x",Math.max(m.l+4,x(metric.worker)+6)).attr("y",y+33).text(`WORKER ${formatMetric(metric.worker,metric.unit)}`);
  });
  svg.append("text").attr("class","visibility-axis").attr("x",m.l).attr("y",h-6).text("EACH METRIC USES ITS OWN SCALE · COMPARISON IS WITHIN METRIC");
}

function formatMetric(value, unit){return `${value.toFixed(value<10&&value!==0?1:0)} ${unit}`;}



// =====================================================
// FOUNDATION VISUALIZATIONS — DATA SUPPORT ON EACH SECTION
// =====================================================
const OFFICIAL_DATA = {
  workers: 65000,
  weeklyDeliveries: 2640000,
  minPay2026: 22.13,
  q1Hours: [
    { label: "TRIP TIME", value: 908000, note: "time performing deliveries" },
    { label: "ON-CALL TIME", value: 560000, note: "connected and available" }
  ],
  payTrend: [
    { period: "Q2 2023", pay: 5.25, tips: 5.37, total: 10.62 },
    { period: "Q2 2024", pay: 19.88, tips: 2.60, total: 22.48 }
  ],
  payRates: [
    { year: 2023, rate: 17.96 },
    { year: 2024, rate: 19.56 },
    { year: 2025, rate: 21.44 },
    { year: 2026, rate: 22.13 }
  ]
};

function clearRoot(selector) {
  const root = d3.select(selector);
  root.selectAll("*").remove();
  return root;
}

function renderTitleMetrics() {
  const root = clearRoot("#titleMetricsChart");
  if (root.empty()) return;
  const loaded = state.all.length || 0;
  const data = [
    { label: "NYC DELIVERY WORKERS", value: OFFICIAL_DATA.workers, display: "≈65,000", max: 3000000 },
    { label: "DELIVERIES / WEEK", value: OFFICIAL_DATA.weeklyDeliveries, display: "2.64M", max: 3000000 },
    { label: "2026 MINIMUM PAY", value: OFFICIAL_DATA.minPay2026 * 100000, display: "$22.13/HR", max: 3000000 },
    { label: "LIVE RESTAURANTS LOADED", value: loaded * 500, display: loaded ? loaded.toLocaleString() : "LOADING", max: 3000000 }
  ];
  const w = 700, h = 210, m = {t:14,r:105,b:12,l:190};
  const x = d3.scaleLinear().domain([0,d3.max(data,d=>d.max)]).range([m.l,w-m.r]);
  const y = d3.scaleBand().domain(data.map(d=>d.label)).range([m.t,h-m.b]).padding(.28);
  const svg = root.append("svg").attr("viewBox",`0 0 ${w} ${h}`).attr("role","img").attr("aria-label","NYC delivery system indicators");
  svg.selectAll(".metric-bar-track").data(data).join("rect").attr("class","metric-bar-track").attr("x",m.l).attr("y",d=>y(d.label)).attr("height",y.bandwidth()).attr("width",w-m.l-m.r);
  svg.selectAll(".metric-bar-fill").data(data).join("rect").attr("class","metric-bar-fill").attr("x",m.l).attr("y",d=>y(d.label)).attr("height",y.bandwidth()).attr("width",0).transition().duration(700).attr("width",d=>Math.max(3,x(d.value)-m.l));
  svg.selectAll(".metric-bar-label").data(data).join("text").attr("class","metric-bar-label").attr("x",m.l-12).attr("y",d=>y(d.label)+y.bandwidth()/2).attr("text-anchor","end").attr("dominant-baseline","middle").text(d=>d.label);
  svg.selectAll(".metric-bar-value").data(data).join("text").attr("class","metric-bar-value").attr("x",w-m.r+12).attr("y",d=>y(d.label)+y.bandwidth()/2).attr("dominant-baseline","middle").text(d=>d.display);
}

function renderQuestionsChart() {
  const root = clearRoot("#questionsChart"); if(root.empty()) return;
  const data = OFFICIAL_DATA.q1Hours;
  const total = d3.sum(data,d=>d.value);
  const rows = data.map(d=>({...d, shown: state.questionShareMode ? d.value/total*100 : d.value}));
  const w=960,h=260,m={t:28,r:150,b:42,l:170};
  const x=d3.scaleLinear().domain([0,d3.max(rows,d=>d.shown)*1.08]).range([m.l,w-m.r]);
  const y=d3.scaleBand().domain(rows.map(d=>d.label)).range([m.t,h-m.b]).padding(.34);
  const svg=root.append("svg").attr("viewBox",`0 0 ${w} ${h}`).attr("role","img").attr("aria-label","Weekly trip and on-call hours for delivery workers");
  svg.append("g").attr("class","chart-grid").attr("transform",`translate(0,${h-m.b})`).call(d3.axisBottom(x).ticks(5).tickFormat(d=>state.questionShareMode?`${d}%`:`${d/1000}k`).tickSize(-(h-m.t-m.b))).call(g=>g.select(".domain").remove());
  svg.selectAll(".qbar").data(rows).join("rect").attr("x",m.l).attr("y",d=>y(d.label)).attr("height",y.bandwidth()).attr("width",0).attr("fill",(d,i)=>i===0?"#ff2845":"#941124").transition().duration(650).attr("width",d=>x(d.shown)-m.l);
  svg.selectAll(".chart-label").data(rows).join("text").attr("class","chart-label").attr("x",m.l-14).attr("y",d=>y(d.label)+y.bandwidth()/2).attr("text-anchor","end").attr("dominant-baseline","middle").text(d=>d.label);
  svg.selectAll(".chart-value").data(rows).join("text").attr("class","chart-value").attr("x",d=>x(d.shown)+10).attr("y",d=>y(d.label)+y.bandwidth()/2).attr("dominant-baseline","middle").text(d=>state.questionShareMode?`${d.shown.toFixed(1)}%`:`${(d.value/1000).toFixed(0)}K HOURS`);
  svg.selectAll(".chart-note").data(rows).join("text").attr("class","chart-note").attr("x",m.l).attr("y",d=>y(d.label)+y.bandwidth()+17).text(d=>d.note.toUpperCase());
}

const keywordData = [
  {id:"ALGORITHMIC MANAGEMENT",r:46,desc:"How platforms convert rules into rankings, dispatch, pay, and discipline.",links:["POLICY","INTERFACE","LABOR"]},
  {id:"PLATFORM LABOR",r:42,desc:"Work organized through software while employment protections remain contested.",links:["LABOR","POLICY","STREET"]},
  {id:"URBAN MOBILITY",r:39,desc:"Movement is shaped by street design, restaurant density, weather, and infrastructure.",links:["STREET","SPATIAL DATA"]},
  {id:"DATA VISIBILITY",r:37,desc:"What enters the record becomes governable; what is omitted becomes harder to contest.",links:["SPATIAL DATA","INTERFACE","POLICY"]},
  {id:"WORKER POWER",r:44,desc:"The ability to inspect, challenge, and collectively govern the systems that measure work.",links:["LABOR","POLICY","INTERFACE"]},
  {id:"LABOR",r:24,type:"evidence"},{id:"POLICY",r:24,type:"evidence"},{id:"INTERFACE",r:24,type:"evidence"},{id:"STREET",r:24,type:"evidence"},{id:"SPATIAL DATA",r:24,type:"evidence"}
];

function renderForceNetwork(selector, nodes, links, readoutSelector, defaultId) {
  const root=clearRoot(selector); if(root.empty()) return;
  const w=760,h=480;
  const svg=root.append("svg").attr("viewBox",`0 0 ${w} ${h}`).attr("role","img").attr("aria-label","Interactive network diagram");
  const nodeCopies=nodes.map(d=>({...d}));
  const linkCopies=links.map(d=>({...d}));
  const simulation=d3.forceSimulation(nodeCopies).force("link",d3.forceLink(linkCopies).id(d=>d.id).distance(d=>d.distance||115).strength(.6)).force("charge",d3.forceManyBody().strength(d=>d.type==="core"?-650:-260)).force("center",d3.forceCenter(w/2,h/2)).force("collision",d3.forceCollide().radius(d=>(d.r||30)+12));
  const link=svg.append("g").selectAll("line").data(linkCopies).join("line").attr("class","network-link");
  const node=svg.append("g").selectAll("g").data(nodeCopies).join("g").attr("class",d=>`network-node${d.id===defaultId?" selected":""}`).call(d3.drag().on("start",(event,d)=>{if(!event.active)simulation.alphaTarget(.3).restart();d.fx=d.x;d.fy=d.y;}).on("drag",(event,d)=>{d.fx=event.x;d.fy=event.y;}).on("end",(event,d)=>{if(!event.active)simulation.alphaTarget(0);d.fx=null;d.fy=null;}));
  node.append("circle").attr("r",d=>d.r||30).attr("fill",d=>d.type==="evidence"?"#941124":d.type==="core"?"#ff2845":"#6f0d1b");
  node.append("text").attr("dy",".35em").each(function(d){const words=d.id.split(" ");const text=d3.select(this);if(words.length<=2)text.text(d.id);else{words.forEach((word,i)=>text.append("tspan").attr("x",0).attr("dy",i?13:-6).text(word));}});
  node.on("click",(event,d)=>{node.classed("selected",n=>n.id===d.id);const read=$(readoutSelector);if(read){read.querySelector("span").textContent=d.type==="evidence"?"EVIDENCE DOMAIN":"SELECTED NODE";read.querySelector("h3").textContent=d.id;read.querySelector("p").textContent=d.desc||"This evidence domain connects multiple parts of the research framework.";}});
  simulation.on("tick",()=>{link.attr("x1",d=>d.source.x).attr("y1",d=>d.source.y).attr("x2",d=>d.target.x).attr("y2",d=>d.target.y);node.attr("transform",d=>`translate(${Math.max(55,Math.min(w-55,d.x))},${Math.max(45,Math.min(h-45,d.y))})`);});
}

function renderKeywordsChart(){
  const nodes=keywordData;
  const links=[];nodes.filter(d=>d.links).forEach(d=>d.links.forEach(target=>links.push({source:d.id,target})));
  renderForceNetwork("#keywordsChart",nodes,links,"#keywordsReadout","ALGORITHMIC MANAGEMENT");
}

function renderFieldsChart(){
  const nodes=[
    {id:"PROJECT",type:"core",r:55,desc:"A worker-centered urban interface that connects computation, labor, mobility, policy, and representation."},
    {id:"COMPUTATIONAL DESIGN",r:42,desc:"Builds the technical instrument while questioning what the instrument measures."},
    {id:"LABOR STUDIES",r:39,desc:"Examines classification, wages, working conditions, and collective power."},
    {id:"URBAN MOBILITY",r:39,desc:"Locates platform labor within streets, routes, infrastructure, and weather."},
    {id:"DATA ETHICS",r:36,desc:"Asks who collects, owns, interprets, and can refuse data."},
    {id:"INTERFACE DESIGN",r:38,desc:"Studies how visual choices frame action, authority, and visibility."},
    {id:"POLICY",type:"evidence",r:28},{id:"MAPBOX + D3",type:"evidence",r:31},{id:"WORKER TESTIMONY",type:"evidence",r:30}
  ];
  const links=[
    ["PROJECT","COMPUTATIONAL DESIGN"],["PROJECT","LABOR STUDIES"],["PROJECT","URBAN MOBILITY"],["PROJECT","DATA ETHICS"],["PROJECT","INTERFACE DESIGN"],
    ["COMPUTATIONAL DESIGN","MAPBOX + D3"],["URBAN MOBILITY","MAPBOX + D3"],["LABOR STUDIES","WORKER TESTIMONY"],["DATA ETHICS","WORKER TESTIMONY"],["LABOR STUDIES","POLICY"],["DATA ETHICS","POLICY"],["INTERFACE DESIGN","MAPBOX + D3"]
  ].map(([source,target])=>({source,target}));
  renderForceNetwork("#fieldsChart",nodes,links,"#fieldsReadout","COMPUTATIONAL DESIGN");
}

function renderLineageChart(){
  const root=clearRoot("#lineageChart");if(root.empty())return;
  const events=[
    {year:1911,title:"SCIENTIFIC MANAGEMENT",value:"TIME STUDY",desc:"Work is decomposed into measurable actions and optimized from above."},
    {year:1948,title:"CYBERNETICS",value:"FEEDBACK",desc:"Control becomes a problem of information, feedback, and system regulation."},
    {year:2011,title:"CRITICAL ENGINEERING",value:"INFRASTRUCTURE AS POLITICS",desc:"Engineering is treated as a language that shapes users and power."},
    {year:2016,title:"PLATFORM CAPITALISM",value:"APP GOVERNANCE",desc:"Digital intermediaries coordinate markets while extracting data and control."},
    {year:2020,title:"DATA FEMINISM",value:"POWER IN DATA",desc:"Data practices are situated within unequal social and institutional relations."},
    {year:2021,title:"NYC DELIVERY LAWS",value:"RIGHTS PACKAGE",desc:"New York City establishes rights concerning routes, tips, bags, and pay information."},
    {year:2023,title:"MINIMUM PAY ENFORCED",value:"$17.96 / HR",desc:"NYC begins enforcing a minimum pay standard for app-based restaurant delivery workers."},
    {year:2026,title:"WORKER RIGHTS",value:"$22.13 / HR",desc:"The minimum pay rate reaches $22.13 and expanded pay-statement protections take effect."}
  ];
  const w=1120,h=330,m={l:70,r:70,t:65,b:55};const x=d3.scaleLinear().domain([1911,2026]).range([m.l,w-m.r]);
  const svg=root.append("svg").attr("viewBox",`0 0 ${w} ${h}`).attr("role","img").attr("aria-label","Timeline from scientific management to delivery worker data rights");
  svg.append("line").attr("class","timeline-line").attr("x1",m.l).attr("x2",w-m.r).attr("y1",h/2).attr("y2",h/2);
  const g=svg.selectAll(".timeline-event").data(events).join("g").attr("class",d=>`timeline-event${d.year===2026?" active":""}`).attr("transform",d=>`translate(${x(d.year)},${h/2})`).on("click",(event,d)=>{g.classed("active",n=>n.year===d.year);const r=$("#lineageReadout");r.querySelector("span").textContent=`${d.year} · ${d.title}`;r.querySelector("h3").textContent=d.value;r.querySelector("p").textContent=d.desc;});
  g.append("line").attr("y1",0).attr("y2",(d,i)=>i%2===0?-62:62).attr("stroke","rgba(255,255,255,.18)");
  g.append("circle").attr("r",9);
  g.append("text").attr("y",(d,i)=>i%2===0?-80:85).text(d=>d.year);
  g.append("text").attr("y",(d,i)=>i%2===0?-64:101).each(function(d){const text=d3.select(this);d.title.split(" ").slice(0,2).forEach((word,i)=>text.append("tspan").attr("x",0).attr("dy",i?12:0).text(word));});
}

function renderPracticeChart(){
  const nodes=[
    {id:"MY POSITION",type:"core",r:56,desc:"Design an interface for contestation rather than surveillance."},
    {id:"FORENSIC ARCHITECTURE",r:42,desc:"Reconstructs events through spatial evidence, open-source investigation, and counter-forensics."},
    {id:"DATA FEMINISM",r:39,desc:"Makes power, context, embodiment, and labor central to data practice."},
    {id:"CRITICAL ENGINEERING",r:38,desc:"Treats technical systems as political and cultural constructions."},
    {id:"PLATFORM COOPERATIVISM",r:40,desc:"Explores worker ownership and democratic governance of digital platforms."},
    {id:"LOS DELIVERISTAS UNIDOS",r:43,desc:"Organizes delivery workers around safety, pay, dignity, and collective rights."},
    {id:"WORKER INFO EXCHANGE",r:39,desc:"Develops tools and research around worker data access and algorithmic accountability."},
    {id:"SPATIAL EVIDENCE",type:"evidence",r:27},{id:"COLLECTIVE POWER",type:"evidence",r:28},{id:"DATA RIGHTS",type:"evidence",r:26}
  ];
  const links=[
    ["MY POSITION","FORENSIC ARCHITECTURE"],["MY POSITION","DATA FEMINISM"],["MY POSITION","CRITICAL ENGINEERING"],["MY POSITION","PLATFORM COOPERATIVISM"],["MY POSITION","LOS DELIVERISTAS UNIDOS"],["MY POSITION","WORKER INFO EXCHANGE"],
    ["FORENSIC ARCHITECTURE","SPATIAL EVIDENCE"],["DATA FEMINISM","DATA RIGHTS"],["WORKER INFO EXCHANGE","DATA RIGHTS"],["LOS DELIVERISTAS UNIDOS","COLLECTIVE POWER"],["PLATFORM COOPERATIVISM","COLLECTIVE POWER"],["CRITICAL ENGINEERING","SPATIAL EVIDENCE"]
  ].map(([source,target])=>({source,target}));
  renderForceNetwork("#practiceChart",nodes,links,"#practiceReadout","MY POSITION");
}

function initContextMap(token){
  const container=$("#contextMap");if(!container||!window.mapboxgl)return;
  if(state.contextMap){state.contextMap.remove();state.contextMap=null;state.contextMapReady=false;}
  state.contextMap=new mapboxgl.Map({container:"contextMap",style:"mapbox://styles/mapbox/dark-v11",center:[-73.9857,40.735],zoom:10,pitch:0,bearing:0,interactive:true,attributionControl:false});
  state.contextMap.addControl(new mapboxgl.NavigationControl({showCompass:false}),"top-right");
  state.contextMap.on("load",()=>{
    state.contextMapReady=true;$("#contextMapPlaceholder")?.classList.add("hidden");
    state.contextMap.addSource("context-restaurants",{type:"geojson",data:geojson(state.all)});
    state.contextMap.addLayer({id:"context-density",type:"heatmap",source:"context-restaurants",maxzoom:15,paint:{"heatmap-weight":["interpolate",["linear"],["coalesce",["to-number",["get","score"]],0],0,0.35,40,1],"heatmap-intensity":["interpolate",["linear"],["zoom"],8,.7,14,2.4],"heatmap-color":["interpolate",["linear"],["heatmap-density"],0,"rgba(5,5,5,0)",.2,"#3a0710",.45,"#741020",.7,"#c51b35",1,"#ff2845"],"heatmap-radius":["interpolate",["linear"],["zoom"],8,10,14,30],"heatmap-opacity":.85}});
    state.contextMap.addLayer({id:"context-grade-c",type:"circle",source:"context-restaurants",filter:["==",["get","grade"],"C"],layout:{visibility:"none"},paint:{"circle-radius":["interpolate",["linear"],["zoom"],9,3,15,9],"circle-color":"#ff7583","circle-stroke-color":"#fff","circle-stroke-width":1,"circle-opacity":.85}});
  });
}
function updateContextMapData(){if(state.contextMapReady&&state.contextMap.getSource("context-restaurants"))state.contextMap.getSource("context-restaurants").setData(geojson(state.filtered));}
function setContextLayer(layer){state.contextLayer=layer;if(!state.contextMapReady)return;state.contextMap.setLayoutProperty("context-density","visibility",layer==="density"?"visible":"none");state.contextMap.setLayoutProperty("context-grade-c","visibility",layer==="gradeC"?"visible":"none");}

function renderSituatedChart(){
  const root=clearRoot("#situatedChart");if(root.empty())return;
  const data=[
    {label:"PLATFORM RULES",visibility:18,power:95,desc:"High operational power, low public visibility."},
    {label:"STREET RISK",visibility:64,power:72,desc:"Observable in space, but rarely included in platform pay calculations."},
    {label:"RESTAURANT WAIT",visibility:48,power:62,desc:"Experienced directly by workers but inconsistently represented in customer-facing records."},
    {label:"BATTERY COST",visibility:31,power:56,desc:"A worker expense that the platform depends on but does not own."},
    {label:"WEATHER",visibility:86,power:68,desc:"Visible to everyone, yet the embodied exposure remains uneven."},
    {label:"WORKER TESTIMONY",visibility:39,power:88,desc:"Crucial situated evidence that is often absent from official platform datasets."}
  ];
  const w=620,h=390,m={t:18,r:60,b:32,l:150};const x=d3.scaleLinear().domain([0,100]).range([m.l,w-m.r]);const y=d3.scaleBand().domain(data.map(d=>d.label)).range([m.t,h-m.b]).padding(.28);
  const svg=root.append("svg").attr("viewBox",`0 0 ${w} ${h}`).attr("role","img").attr("aria-label","Visibility index for situated components of delivery work");
  svg.append("g").attr("class","chart-grid").attr("transform",`translate(0,${h-m.b})`).call(d3.axisBottom(x).ticks(5).tickFormat(d=>`${d}%`).tickSize(-(h-m.t-m.b))).call(g=>g.select(".domain").remove());
  const g=svg.selectAll(".situated-bar").data(data).join("g").attr("class",(d,i)=>`situated-bar${i===0?" active":""}`).on("click",(event,d)=>{g.classed("active",n=>n.label===d.label);const r=$("#situatedReadout");r.querySelector("span").textContent=`VISIBILITY ${d.visibility}% · POWER ${d.power}%`;r.querySelector("h3").textContent=d.label;r.querySelector("p").textContent=d.desc;});
  g.append("rect").attr("x",m.l).attr("y",d=>y(d.label)).attr("height",y.bandwidth()).attr("width",d=>x(d.visibility)-m.l);
  g.append("text").attr("x",m.l-12).attr("y",d=>y(d.label)+y.bandwidth()/2).attr("text-anchor","end").attr("dominant-baseline","middle").text(d=>d.label);
  g.append("text").attr("class","situated-value").attr("x",d=>x(d.visibility)+8).attr("y",d=>y(d.label)+y.bandwidth()/2).attr("dominant-baseline","middle").text(d=>`${d.visibility}%`);
}

function renderMethodsChart(){
  const root=clearRoot("#methodsChart");if(root.empty())return;
  const total=state.all.length||1;const withScore=state.all.filter(d=>Number.isFinite(d.score)).length;const geocoded=state.all.filter(d=>Number.isFinite(d.lat)&&Number.isFinite(d.lng)).length;
  const data=[
    {label:"GEOCODED RECORDS",value:geocoded/total*100,color:"#ff2845"},
    {label:"WITH INSPECTION SCORE",value:withScore/total*100,color:"#c51b35"},
    {label:"WITH LETTER GRADE",value:state.all.filter(d=>["A","B","C"].includes(d.grade)).length/total*100,color:"#941124"},
    {label:"WORKER TESTIMONY IN DATASET",value:0,color:"#3d0a12"}
  ];
  const w=940,h=270,m={t:20,r:80,b:36,l:245};const x=d3.scaleLinear().domain([0,100]).range([m.l,w-m.r]);const y=d3.scaleBand().domain(data.map(d=>d.label)).range([m.t,h-m.b]).padding(.32);
  const svg=root.append("svg").attr("viewBox",`0 0 ${w} ${h}`).attr("role","img").attr("aria-label","Data completeness audit");
  svg.append("g").attr("class","chart-grid").attr("transform",`translate(0,${h-m.b})`).call(d3.axisBottom(x).ticks(5).tickFormat(d=>`${d}%`).tickSize(-(h-m.t-m.b))).call(g=>g.select(".domain").remove());
  svg.selectAll(".method-bar").data(data).join("rect").attr("x",m.l).attr("y",d=>y(d.label)).attr("height",y.bandwidth()).attr("fill",d=>d.color).attr("width",0).transition().duration(650).attr("width",d=>x(d.value)-m.l);
  svg.selectAll(".chart-label").data(data).join("text").attr("class","chart-label").attr("x",m.l-12).attr("y",d=>y(d.label)+y.bandwidth()/2).attr("text-anchor","end").attr("dominant-baseline","middle").text(d=>d.label);
  svg.selectAll(".chart-value").data(data).join("text").attr("class","chart-value").attr("x",d=>x(d.value)+9).attr("y",d=>y(d.label)+y.bandwidth()/2).attr("dominant-baseline","middle").text(d=>`${d.value.toFixed(1)}%`);
  const metrics=$("#methodsMetrics");if(metrics){const values=[state.all.length,state.all.filter(d=>Number.isFinite(d.lat)&&Number.isFinite(d.lng)).length,withScore,new Set(state.all.map(d=>d.cuisine)).size];[...metrics.querySelectorAll("b")].forEach((b,i)=>b.textContent=values[i]?values[i].toLocaleString():"—");}
}

function renderVisualEncoding(){
  const root=clearRoot("#visualEncodingChart");if(root.empty())return;
  const risk=Number($("#visualRiskSlider")?.value||40);$("#visualRiskLabel").textContent=`${risk}%`;
  const w=980,h=300;const points=[[55,230],[180,155],[315,205],[470,105],[640,145],[820,55],[930,85]];const line=d3.line().curve(d3.curveCatmullRom.alpha(.55));
  const svg=root.append("svg").attr("viewBox",`0 0 ${w} ${h}`).attr("role","img").attr("aria-label","Interactive visual encoding demonstration");
  const opacity=.25+risk/100*.75;const width=2+risk/100*9;const dash=risk<35?"14 9":risk<70?"8 5":"3 3";
  svg.append("path").attr("d",line(points)).attr("class","visual-route").attr("stroke",`rgba(255,40,69,${opacity})`).attr("stroke-width",width).attr("stroke-dasharray",dash);
  svg.selectAll("circle").data(points).join("circle").attr("class","visual-point").attr("cx",d=>d[0]).attr("cy",d=>d[1]).attr("r",5+risk/100*7).attr("stroke-width",2+risk/100*3);
  const annotations=[{x:100,y:55,label:"LINE WEIGHT"},{x:390,y:250,label:"ALERT DENSITY"},{x:720,y:235,label:"ANNOTATION INTENSITY"}];
  svg.selectAll(".visual-annotation").data(annotations).join("text").attr("class","visual-annotation").attr("x",d=>d.x).attr("y",d=>d.y).text(d=>`${d.label} · ${risk}%`);
  for(let i=0;i<Math.round(risk/8);i++){svg.append("line").attr("x1",70+i*70).attr("x2",110+i*70).attr("y1",270-(i%3)*9).attr("y2",270-(i%3)*9).attr("stroke","#941124").attr("stroke-width",2);}
}

function renderArgumentChart(){
  const root=clearRoot("#argumentChart");if(root.empty())return;
  const data=OFFICIAL_DATA.payTrend;const w=850,h=330,m={t:24,r:42,b:55,l:70};const keys=state.argumentTotalMode?["total"]:["pay","tips"];
  const x0=d3.scaleBand().domain(data.map(d=>d.period)).range([m.l,w-m.r]).padding(.35);const x1=d3.scaleBand().domain(keys).range([0,x0.bandwidth()]).padding(.08);const y=d3.scaleLinear().domain([0,d3.max(data,d=>d3.max(keys,k=>d[k]))*1.2]).nice().range([h-m.b,m.t]);
  const svg=root.append("svg").attr("viewBox",`0 0 ${w} ${h}`).attr("role","img").attr("aria-label","Delivery worker pay and tips comparison");
  svg.append("g").attr("class","chart-grid").attr("transform",`translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickFormat(d=>`$${d}`).tickSize(-(w-m.l-m.r))).call(g=>g.select(".domain").remove());
  svg.append("g").attr("class","chart-axis").attr("transform",`translate(0,${h-m.b})`).call(d3.axisBottom(x0));
  const groups=svg.selectAll(".pay-group").data(data).join("g").attr("transform",d=>`translate(${x0(d.period)},0)`);
  groups.selectAll("rect").data(d=>keys.map(key=>({key,value:d[key]}))).join("rect").attr("x",d=>x1(d.key)).attr("y",h-m.b).attr("width",x1.bandwidth()).attr("height",0).attr("fill",d=>d.key==="pay"?"#ff2845":d.key==="tips"?"#941124":"#ff7583").transition().duration(650).attr("y",d=>y(d.value)).attr("height",d=>h-m.b-y(d.value));
  groups.selectAll("text").data(d=>keys.map(key=>({key,value:d[key]}))).join("text").attr("class","chart-value").attr("x",d=>x1(d.key)+x1.bandwidth()/2).attr("y",d=>y(d.value)-8).attr("text-anchor","middle").text(d=>`$${d.value.toFixed(2)}`);
  const legend=svg.append("g").attr("transform",`translate(${m.l},${h-12})`);keys.forEach((key,i)=>{legend.append("rect").attr("x",i*130).attr("width",11).attr("height",11).attr("fill",key==="pay"?"#ff2845":key==="tips"?"#941124":"#ff7583");legend.append("text").attr("class","chart-note").attr("x",17+i*130).attr("y",10).text(key.toUpperCase());});
}

function renderCapstoneChart(){
  const root=clearRoot("#capstoneChart");if(root.empty())return;
  const phases=[
    {id:"LISTEN",start:0,end:3,label:"FALL 2026 · LISTEN",desc:"Build trust, establish consent, and identify what workers want documented or kept private."},
    {id:"COLLECT",start:2,end:6,label:"FALL 2026 · COLLECT",desc:"Gather worker-authored traces, testimony, screenshots, and field observations."},
    {id:"PROTOTYPE",start:5,end:9,label:"WINTER 2027 · PROTOTYPE",desc:"Test secure interfaces for route annotation, unpaid-time evidence, and contestation."},
    {id:"GOVERN",start:8,end:12,label:"SPRING 2027 · GOVERN",desc:"Define access, ownership, retention, refusal, and collective decision-making rules."},
    {id:"EXHIBIT",start:10,end:14,label:"SPRING 2027 · EXHIBIT",desc:"Combine software, public argument, printed evidence, and physical representation."}
  ];
  const w=1050,h=390,m={t:30,r:45,b:58,l:170};const x=d3.scaleLinear().domain([0,14]).range([m.l,w-m.r]);const y=d3.scaleBand().domain(phases.map(d=>d.id)).range([m.t,h-m.b]).padding(.32);
  const svg=root.append("svg").attr("viewBox",`0 0 ${w} ${h}`).attr("role","img").attr("aria-label","Capstone research roadmap");
  svg.append("g").attr("class","chart-grid").attr("transform",`translate(0,${h-m.b})`).call(d3.axisBottom(x).ticks(7).tickFormat(d=>`M${d+1}`).tickSize(-(h-m.t-m.b))).call(g=>g.select(".domain").remove());
  const bars=svg.selectAll(".roadmap-bar").data(phases).join("rect").attr("class",(d,i)=>`roadmap-bar${i===0?" active":""}`).attr("x",d=>x(d.start)).attr("y",d=>y(d.id)).attr("height",y.bandwidth()).attr("width",d=>x(d.end)-x(d.start)).on("click",(event,d)=>{bars.classed("active",n=>n.id===d.id);const r=$("#capstoneReadout");r.querySelector("span").textContent=d.label;r.querySelector("h3").textContent=d.id==="LISTEN"?"RELATIONSHIPS BEFORE SOFTWARE":d.id;r.querySelector("p").textContent=d.desc;});
  svg.selectAll(".roadmap-label").data(phases).join("text").attr("class","roadmap-label").attr("x",m.l-12).attr("y",d=>y(d.id)+y.bandwidth()/2).attr("text-anchor","end").attr("dominant-baseline","middle").text(d=>d.id);
  svg.selectAll(".roadmap-date").data(phases).join("text").attr("class","roadmap-date").attr("x",d=>x(d.start)+10).attr("y",d=>y(d.id)+y.bandwidth()/2).attr("dominant-baseline","middle").text(d=>`${d.end-d.start} MONTHS`);
}

function renderChallengeChart(){
  const root=clearRoot("#challengeChart");if(root.empty())return;
  const data=[
    {id:"WORKER TRUST",impact:5,readiness:1.5,desc:"High impact, low current readiness. The next step is relationship-building rather than feature-building."},
    {id:"SENSITIVE LOCATION DATA",impact:5,readiness:2.2,desc:"Route traces can expose homes, routines, immigration status, and work patterns."},
    {id:"MISSING WAIT DATA",impact:4.3,readiness:2.8,desc:"Public datasets rarely capture restaurant waiting, parking, and deactivation."},
    {id:"MAPBOX + D3",impact:3.2,readiness:4.1,desc:"The current technical foundation is strong enough for iterative prototyping."},
    {id:"VISUAL ARGUMENT",impact:4,readiness:3.7,desc:"The representation is coherent but must avoid substituting aesthetics for evidence."},
    {id:"POLICY INTERPRETATION",impact:4.2,readiness:3,desc:"Rules change over time and require careful legal and worker-centered interpretation."}
  ];
  const w=730,h=470,m={t:35,r:35,b:65,l:75};const x=d3.scaleLinear().domain([1,5]).range([m.l,w-m.r]);const y=d3.scaleLinear().domain([1,5]).range([h-m.b,m.t]);
  const svg=root.append("svg").attr("viewBox",`0 0 ${w} ${h}`).attr("role","img").attr("aria-label","Challenge impact and readiness matrix");
  const midX=x(3),midY=y(3);[[m.l,m.t,midX-m.l,midY-m.t],[midX,m.t,w-m.r-midX,midY-m.t],[m.l,midY,midX-m.l,h-m.b-midY],[midX,midY,w-m.r-midX,h-m.b-midY]].forEach(d=>svg.append("rect").attr("class","matrix-quadrant").attr("x",d[0]).attr("y",d[1]).attr("width",d[2]).attr("height",d[3]));
  svg.append("g").attr("class","chart-axis").attr("transform",`translate(0,${h-m.b})`).call(d3.axisBottom(x).ticks(5));svg.append("g").attr("class","chart-axis").attr("transform",`translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5));
  svg.append("text").attr("class","chart-note").attr("x",(m.l+w-m.r)/2).attr("y",h-15).attr("text-anchor","middle").text("CURRENT READINESS →");svg.append("text").attr("class","chart-note").attr("transform","rotate(-90)").attr("x",-(m.t+h-m.b)/2).attr("y",20).attr("text-anchor","middle").text("PROJECT IMPACT →");
  const g=svg.selectAll(".matrix-point").data(data).join("g").attr("class",(d,i)=>`matrix-point${i===0?" active":""}`).attr("transform",d=>`translate(${x(d.readiness)},${y(d.impact)})`).on("click",(event,d)=>{g.classed("active",n=>n.id===d.id);const r=$("#challengeReadout");r.querySelector("span").textContent=`IMPACT ${d.impact}/5 · READINESS ${d.readiness}/5`;r.querySelector("h3").textContent=d.id;r.querySelector("p").textContent=d.desc;});
  g.append("circle").attr("r",d=>8+d.impact*2.5);g.append("text").attr("x",14).attr("y",4).text(d=>d.id);
}

function renderExhibitionChart(){
  const root=clearRoot("#exhibitionChart");if(root.empty())return;
  const data=[
    {id:"DRAWING",x:75,y:35,w:170,h:340,label:"36 × 72 IN",desc:"Suspended from the Avery 100 rail; the route becomes the spine connecting platform, street, worker, and policy layers."},
    {id:"OBJECT",x:330,y:260,w:150,h:115,label:"24 × 18 IN",desc:"Delivery bag and extended thermal receipt placed on a black plinth next to the drawing."},
    {id:"SCREEN",x:555,y:135,w:260,h:155,label:"SECOND SCREEN",desc:"Live Mapbox and D3 demo with a recorded backup video for reliable presentation."}
  ];
  const w=900,h=450;const svg=root.append("svg").attr("viewBox",`0 0 ${w} ${h}`).attr("role","img").attr("aria-label","Scaled exhibition component layout");
  svg.append("line").attr("x1",35).attr("x2",865).attr("y1",395).attr("y2",395).attr("stroke","rgba(255,255,255,.18)");
  const g=svg.selectAll(".install-component").data(data).join("g").attr("class",(d,i)=>`install-component${i===0?" active":""}`).on("click",(event,d)=>{g.classed("active",n=>n.id===d.id);const r=$("#exhibitionReadout");r.querySelector("span").textContent=d.id==="DRAWING"?"PRINTED DRAWING":d.id==="OBJECT"?"MATERIAL-SPATIAL GESTURE":"OPTIONAL SECOND SCREEN";r.querySelector("h3").textContent=d.id==="DRAWING"?"36 × 72 INCH VERTICAL DATASCAPE":d.label;r.querySelector("p").textContent=d.desc;});
  g.append("rect").attr("x",d=>d.x).attr("y",d=>d.y).attr("width",d=>d.w).attr("height",d=>d.h);
  g.append("text").attr("x",d=>d.x+d.w/2).attr("y",d=>d.y+d.h/2-6).text(d=>d.id);g.append("text").attr("class","install-dimension").attr("x",d=>d.x+d.w/2).attr("y",d=>d.y+d.h/2+16).text(d=>d.label);
  svg.append("text").attr("class","chart-note").attr("x",450).attr("y",430).attr("text-anchor","middle").text("AVERY 100 · ELEVATION / TABLE SETUP · PROVISIONAL SCALE");
}

function renderLiveFoundationVisuals(){renderTitleMetrics();renderMethodsChart();}
function renderFoundationVisuals(){renderTitleMetrics();renderQuestionsChart();renderKeywordsChart();renderFieldsChart();renderLineageChart();renderPracticeChart();renderSituatedChart();renderMethodsChart();renderVisualEncoding();renderArgumentChart();renderCapstoneChart();renderChallengeChart();renderExhibitionChart();}

$("#questionMode")?.addEventListener("click",event=>{state.questionShareMode=!state.questionShareMode;event.currentTarget.textContent=state.questionShareMode?"SHOW HOURS":"SHOW SHARE";renderQuestionsChart();});
$("#argumentMode")?.addEventListener("click",event=>{state.argumentTotalMode=!state.argumentTotalMode;event.currentTarget.textContent=state.argumentTotalMode?"SHOW PAY + TIPS":"SHOW TOTAL";renderArgumentChart();});
$("#visualRiskSlider")?.addEventListener("input",renderVisualEncoding);
$$('[data-context-layer]').forEach(button=>button.addEventListener("click",()=>{$$('[data-context-layer]').forEach(b=>b.classList.remove("active"));button.classList.add("active");setContextLayer(button.dataset.contextLayer);}));

function observeReveals() {
  const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting)entry.target.classList.add("visible");}),{threshold:.12});
  $$(".reveal").forEach(node=>observer.observe(node));
}

function updateScrollUI() {
  const total=document.documentElement.scrollHeight-window.innerHeight;
  el.progress.style.width=`${total>0?window.scrollY/total*100:0}%`;
  const sections=$$("main section[id]");
  let active=sections[0]?.id;
  sections.forEach(section=>{if(section.getBoundingClientRect().top<=window.innerHeight*.38)active=section.id;});
  $$(".topbar nav a").forEach(link=>link.classList.toggle("active",link.getAttribute("href")===`#${active}`));
}

el.tokenButton.addEventListener("click",openTokenPanel);
el.placeholderTokenButton.addEventListener("click",openTokenPanel);
el.closeToken.addEventListener("click",closeTokenPanel);
el.connectMap.addEventListener("click",()=>initMap(el.tokenInput.value));
el.tokenInput.addEventListener("keydown",event=>{if(event.key==="Enter")initMap(el.tokenInput.value);});
el.clearToken.addEventListener("click",()=>{localStorage.removeItem("ib_mapbox_token");state.token="";el.tokenInput.value="";el.tokenButton.classList.remove("connected");el.tokenMessage.textContent="Saved token cleared.";if(state.map){state.map.remove();state.map=null;state.mapReady=false;}if(state.contextMap){state.contextMap.remove();state.contextMap=null;state.contextMapReady=false;}el.mapPlaceholder.classList.remove("hidden");$("#contextMapPlaceholder")?.classList.remove("hidden");});

el.search.addEventListener("input",applyFilters);
el.borough.addEventListener("change",applyFilters);
el.grade.addEventListener("change",applyFilters);
el.reset.addEventListener("click",()=>{el.search.value="";el.borough.value="ALL";el.grade.value="ALL";state.scoreRange=null;el.scoreLabel.textContent="ALL SCORES";applyFilters();});
el.sync.addEventListener("change",()=>{state.syncViewport=el.sync.checked;drawCharts(currentChartData());});
el.routeToColumbia.addEventListener("click",()=>setDestination([-73.9626,40.8075]));
el.clearRoute.addEventListener("click",()=>clearRoute(true));
el.tipSlider.addEventListener("input",()=>{state.tipPercent=Number(el.tipSlider.value);renderCart();});

el.waitSlider.addEventListener("input",()=>{state.scenario.wait=Number(el.waitSlider.value);updateCase();});
el.pickupSlider.addEventListener("input",()=>{state.scenario.pickup=Number(el.pickupSlider.value);updateCase();});
el.riskSlider.addEventListener("input",()=>{state.scenario.risk=Number(el.riskSlider.value);updateCase();});

el.placeOrder.addEventListener("click",()=>{el.orderNumber.textContent=`ORDER #${Date.now().toString().slice(-6)}`;el.confirmation.hidden=false;document.body.classList.add("no-scroll");});
el.closeConfirmation.addEventListener("click",()=>{el.confirmation.hidden=true;document.body.classList.remove("no-scroll");state.cart=[];renderCart();});

window.addEventListener("scroll",updateScrollUI,{passive:true});
window.addEventListener("resize",()=>{clearTimeout(window.__resizeTimer);window.__resizeTimer=setTimeout(()=>{drawCharts(currentChartData());drawVisibilityChart(calculateCase());renderFoundationVisuals();state.map?.resize();state.contextMap?.resize();},120);});
document.addEventListener("keydown",event=>{if(event.key==="Escape"){closeTokenPanel();if(!el.confirmation.hidden)el.closeConfirmation.click();}});

renderFoundationVisuals();
observeReveals();
updateScrollUI();
renderCart();
updateCase();
const savedToken=localStorage.getItem("ib_mapbox_token") || DEFAULT_MAPBOX_TOKEN;
el.tokenInput.value=savedToken;
initMap(savedToken);
loadData();
