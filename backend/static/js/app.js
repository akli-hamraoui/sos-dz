const API = "/api";

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}
function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

async function api(path, options = {}) {
  const resp = await fetch(API + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  let data = null;
  try { data = await resp.json(); } catch (e) { /* no body */ }
  if (!resp.ok) {
    const err = new Error((data && data.detail) || "Request failed");
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data;
}

function app() {
  return {
    route: "home",
    routeParams: {},
    config: { mode: "normal", media_moderation_active: true },
    wilayas: [],
    campaigns: [],
    needs: [],
    currentNeed: null,
    filterWilaya: "",
    viewMode: loadJSON("rassemble_view_mode", "list"),
    needTokens: loadJSON("rassemble_need_tokens", {}),
    pickupTokens: loadJSON("rassemble_pickup_tokens", {}),
    showPhone: false,
    shareLink: "",
    canSeeLiveMap: false,
    progressText: {},
    createForm: this_defaultCreateForm(),
    createError: "",
    pickupForm: this_defaultPickupForm(),
    pickupError: "",
    recoverForm: { last_name: "", first_name: "", phone: "", date_of_birth: "" },
    recoverError: "",
    recoverContext: null,
    supportForm: { requester_phone: "", related_listing_description: "", message: "" },
    supportSent: false,
    _mainMap: null,
    _detailMap: null,

    async init() {
      window.addEventListener("hashchange", () => this.onRouteChange());
      this.onRouteChange();
      try { this.config = await api("/config/"); } catch (e) { /* ignore */ }
      try {
        const w = await api("/wilayas/");
        this.wilayas = w.results || w;
      } catch (e) {}
      try {
        const c = await api("/campaigns/");
        this.campaigns = c.results || c;
      } catch (e) {}
    },

    async onRouteChange() {
      const hash = window.location.hash.replace(/^#\/?/, "");
      const parts = hash.split("/").filter(Boolean);
      if (parts.length === 0) {
        this.route = "home";
      } else if (parts[0] === "needs" && parts[1]) {
        this.route = "detail";
        await this.loadNeedDetail(parts[1]);
      } else if (parts[0] === "needs") {
        this.route = "needs";
        await this.loadNeeds();
        this.$nextTick(() => this.renderCurrentView());
      } else {
        this.route = parts[0];
      }
    },

    wilayasForCampaign(campaignId) {
      const c = this.campaigns.find((c) => String(c.id) === String(campaignId));
      return c ? c.authorized_wilayas : this.wilayas;
    },

    statusLabel(s) {
      return { open: "open", partially_covered: "partially covered", covered: "covered", cancelled: "cancelled" }[s] || s;
    },

    maskPhone(phone, revealed) {
      if (!phone) return "";
      if (revealed) return phone;
      if (phone.length <= 4) return phone;
      return phone.slice(0, 4) + " XX XX " + phone.slice(-2);
    },

    formatDate(iso) {
      if (!iso) return "";
      const d = new Date(iso);
      return d.toLocaleDateString("fr-FR") + " " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    },

    setViewMode(mode) {
      this.viewMode = mode;
      saveJSON("rassemble_view_mode", mode);
      this.$nextTick(() => this.renderCurrentView());
    },

    renderCurrentView() {
      if (this.viewMode === "map") this.renderMainMap();
    },

    async useMyLocation(formKey) {
      if (!navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition((pos) => {
        this[formKey].latitude = pos.coords.latitude;
        this[formKey].longitude = pos.coords.longitude;
      });
    },

    // ---- Needs ----
    async loadNeeds() {
      const qs = this.filterWilaya ? `?wilaya=${this.filterWilaya}` : "";
      const data = await api(`/needs/${qs}`);
      this.needs = data.results || data;
      if (this.viewMode === "map") this.$nextTick(() => this.renderMainMap());
    },

    async submitNeed() {
      this.createError = "";
      try {
        const need = await api("/needs/", { method: "POST", body: JSON.stringify(this.createForm) });
        this.needTokens[need.id] = { access_token: need.access_token, location_viewer_share_token: need.location_viewer_share_token };
        saveJSON("rassemble_need_tokens", this.needTokens);
        window.location.hash = `#/needs/${need.id}`;
      } catch (e) {
        this.createError = (e.data && JSON.stringify(e.data)) || e.message;
      }
    },

    isNeedOwner(id) {
      return !!(this.needTokens[id] && this.needTokens[id].access_token);
    },
    isPickupOwner(id) {
      return !!this.pickupTokens[id];
    },

    async loadNeedDetail(id) {
      this.currentNeed = await api(`/needs/${id}/`);
      this.showPhone = false;
      this.shareLink = "";
      await this.checkLiveMapAccess(id);
    },

    async checkLiveMapAccess(id) {
      const owner = this.isNeedOwner(id);
      const viewer = new URLSearchParams(window.location.hash.split("?")[1] || "").get("viewer");
      let qs = "";
      if (owner) qs = `?access_token=${this.needTokens[id].access_token}`;
      else if (viewer) qs = `?viewer=${viewer}`;
      else { this.canSeeLiveMap = false; return; }
      try {
        const pickups = await api(`/needs/${id}/pickup-locations/${qs}`);
        this.canSeeLiveMap = true;
        this.$nextTick(() => this.renderDetailMap(pickups));
      } catch (e) {
        this.canSeeLiveMap = false;
      }
    },

    startEditNeed() {
      const title = prompt("New title:", this.currentNeed.title);
      if (title === null) return;
      this.editNeed({ title });
    },
    async editNeed(patch) {
      const token = this.needTokens[this.currentNeed.id].access_token;
      this.currentNeed = await api(`/needs/${this.currentNeed.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ ...patch, access_token: token }),
      });
    },
    async cancelNeed() {
      const reason = prompt("Reason for cancelling (optional):", "");
      if (reason === null) return;
      await this.editNeed({ is_cancelled: true, cancellation_reason: reason });
    },
    async promptUpdateGPS() {
      if (!navigator.geolocation) return alert("Geolocation not available on this device.");
      navigator.geolocation.getCurrentPosition(async (pos) => {
        const token = this.needTokens[this.currentNeed.id].access_token;
        try {
          this.currentNeed = await api(`/needs/${this.currentNeed.id}/update-gps/`, {
            method: "POST",
            body: JSON.stringify({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, access_token: token }),
          });
        } catch (e) {
          alert(e.message);
        }
      });
    },
    async shareTracking() {
      const t = this.needTokens[this.currentNeed.id];
      this.shareLink = `${window.location.origin}${window.location.pathname}#/needs/${this.currentNeed.id}?viewer=${t.location_viewer_share_token}`;
    },
    async regenerateShareToken() {
      const token = this.needTokens[this.currentNeed.id].access_token;
      const result = await api(`/needs/${this.currentNeed.id}/regenerate-share-token/`, {
        method: "POST",
        body: JSON.stringify({ access_token: token }),
      });
      this.needTokens[this.currentNeed.id].location_viewer_share_token = result.location_viewer_share_token;
      saveJSON("rassemble_need_tokens", this.needTokens);
      this.shareTracking();
    },
    async anonymizeNeed() {
      const token = this.needTokens[this.currentNeed.id].access_token;
      try {
        this.currentNeed = await api(`/needs/${this.currentNeed.id}/anonymize/`, {
          method: "POST",
          body: JSON.stringify({ access_token: token }),
        });
      } catch (e) {
        if (e.data && e.data.requires_confirmation) {
          if (confirm(e.data.detail + "\n\nConfirm?")) {
            this.currentNeed = await api(`/needs/${this.currentNeed.id}/anonymize/`, {
              method: "POST",
              body: JSON.stringify({ access_token: token, confirm: true }),
            });
          }
        } else {
          alert(e.message);
        }
      }
    },

    // ---- Pickups ----
    async submitPickup() {
      this.pickupError = "";
      try {
        const pickup = await api("/pickups/", {
          method: "POST",
          body: JSON.stringify({ ...this.pickupForm, need: this.currentNeed.id }),
        });
        this.pickupTokens[pickup.id] = pickup.access_token;
        saveJSON("rassemble_pickup_tokens", this.pickupTokens);
        window.location.hash = `#/needs/${this.currentNeed.id}`;
        await this.loadNeedDetail(this.currentNeed.id);
      } catch (e) {
        this.pickupError = (e.data && JSON.stringify(e.data)) || e.message;
      }
    },
    async addProgressUpdate(pickupId) {
      const text = this.progressText[pickupId];
      if (!text) return;
      const token = this.pickupTokens[pickupId];
      await api(`/pickups/${pickupId}/progress-updates/`, {
        method: "POST",
        body: JSON.stringify({ free_text: text, access_token: token }),
      });
      this.progressText[pickupId] = "";
      await this.loadNeedDetail(this.currentNeed.id);
    },
    async toggleLocationSharing(pickup, checked) {
      const token = this.pickupTokens[pickup.id];
      await api(`/pickups/${pickup.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ location_sharing_active: checked, access_token: token }),
      });
      await this.loadNeedDetail(this.currentNeed.id);
    },
    async pingLocation(pickupId) {
      if (!navigator.geolocation) return;
      const token = this.pickupTokens[pickupId];
      navigator.geolocation.getCurrentPosition(async (pos) => {
        await api(`/pickups/${pickupId}/location-pings/`, {
          method: "POST",
          body: JSON.stringify({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, access_token: token }),
        });
        await this.checkLiveMapAccess(this.currentNeed.id);
      });
    },
    async markDelivered(pickupId) {
      const token = this.pickupTokens[pickupId];
      await api(`/pickups/${pickupId}/deliver/`, { method: "POST", body: JSON.stringify({ access_token: token }) });
      await this.loadNeedDetail(this.currentNeed.id);
    },
    async anonymizePickup(pickupId) {
      const token = this.pickupTokens[pickupId];
      try {
        await api(`/pickups/${pickupId}/anonymize/`, { method: "POST", body: JSON.stringify({ access_token: token }) });
      } catch (e) {
        if (e.data && e.data.requires_confirmation && confirm(e.data.detail + "\n\nConfirm?")) {
          await api(`/pickups/${pickupId}/anonymize/`, { method: "POST", body: JSON.stringify({ access_token: token, confirm: true }) });
        }
      }
      await this.loadNeedDetail(this.currentNeed.id);
    },

    // ---- Recovery / support ----
    async submitRecovery() {
      this.recoverError = "";
      if (!this.recoverContext) { this.recoverError = "Open this from a need/pickup page first."; return; }
      const { type, id } = this.recoverContext;
      try {
        const result = await api(`/${type === "need" ? "needs" : "pickups"}/${id}/recover-access/`, {
          method: "POST",
          body: JSON.stringify(this.recoverForm),
        });
        if (type === "need") {
          this.needTokens[id] = { ...(this.needTokens[id] || {}), access_token: result.access_token };
          saveJSON("rassemble_need_tokens", this.needTokens);
          window.location.hash = `#/needs/${id}`;
        } else {
          this.pickupTokens[id] = result.access_token;
          saveJSON("rassemble_pickup_tokens", this.pickupTokens);
          alert("Access recovered.");
        }
      } catch (e) {
        this.recoverError = e.message;
      }
    },
    async submitSupport() {
      await api("/support-requests/", { method: "POST", body: JSON.stringify(this.supportForm) });
      this.supportSent = true;
    },

    // ---- Maps ----
    urgencyColor(u) {
      return { critical: "#d92626", medium: "#e08a1e", low: "#cbb400" }[u] || "#555";
    },

    async renderMainMap() {
      const el = document.getElementById("main-map");
      if (!el || typeof L === "undefined") return;
      if (!this._mainMap) {
        this._mainMap = L.map(el);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap" }).addTo(this._mainMap);
      }
      const map = this._mainMap;
      map.eachLayer((layer) => { if (layer instanceof L.Marker) map.removeLayer(layer); });

      const pins = await api("/needs/locations/");
      const withPos = pins.filter((p) => p.display_latitude != null && p.display_longitude != null);
      const markers = [];
      withPos.forEach((p) => {
        const marker = L.circleMarker([p.display_latitude, p.display_longitude], {
          radius: 9, color: this.urgencyColor(p.urgency), fillColor: this.urgencyColor(p.urgency), fillOpacity: 0.85,
        }).addTo(map);
        const gpsNote = p.has_exact_position ? "" : "<br><em>no exact GPS position</em>";
        marker.bindPopup(
          `<strong>${p.title}</strong><br>${p.urgency} — ${p.wilaya_name}<br>${(p.location_description || "").slice(0, 80)}` +
          `<br>${this.statusLabel(p.overall_status)}${gpsNote}<br><a href="#/needs/${p.id}">Open</a>`
        );
        markers.push(marker);
      });

      this.smartZoom(map, withPos.map((p) => [p.display_latitude, p.display_longitude]));
    },

    smartZoom(map, points) {
      if (points.length === 0) {
        map.setView([28.0, 2.6], 5); // whole-Algeria fallback view
        return;
      }
      const doZoom = (userLatLng) => {
        const nearby = userLatLng
          ? points.filter((pt) => this.haversineKm(userLatLng, pt) <= 50)
          : [];
        const target = nearby.length ? nearby : points;
        const bounds = L.latLngBounds(target);
        map.fitBounds(bounds.pad(0.3), { maxZoom: nearby.length ? 11 : 6 });
      };
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (pos) => doZoom([pos.coords.latitude, pos.coords.longitude]),
          () => doZoom(null),
          { timeout: 3000 }
        );
      } else {
        doZoom(null);
      }
    },

    haversineKm([lat1, lon1], [lat2, lon2]) {
      const R = 6371;
      const dLat = ((lat2 - lat1) * Math.PI) / 180;
      const dLon = ((lon2 - lon1) * Math.PI) / 180;
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    },

    renderDetailMap(pickups) {
      const el = document.getElementById("need-detail-map");
      if (!el || typeof L === "undefined") return;
      if (this._detailMap) { this._detailMap.remove(); this._detailMap = null; }
      const map = L.map(el);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap" }).addTo(map);
      this._detailMap = map;
      const allPoints = [];
      pickups.forEach((entry) => {
        const trail = entry.trail;
        if (!trail.length) return;
        const latlngs = trail.map((t) => [t.latitude, t.longitude]);
        L.polyline(latlngs, { color: "#111" }).addTo(map);
        const last = latlngs[latlngs.length - 1];
        const marker = L.marker(last).addTo(map);
        marker.bindPopup(
          `<strong>${entry.pickup.responder_last_name} ${entry.pickup.responder_first_name}</strong><br>` +
          `Bringing: ${entry.pickup.content_brought}<br>Latest: ${entry.latest_progress_text || "—"}`
        );
        allPoints.push(...latlngs);
      });
      if (allPoints.length) map.fitBounds(L.latLngBounds(allPoints).pad(0.3));
      else map.setView([28.0, 2.6], 5);
    },
  };
}

function this_defaultCreateForm() {
  return {
    campaign: "", wilaya: "", commune: "", title: "", urgency: "medium",
    estimated_quantity: "", location_description: "", latitude: null, longitude: null,
    contact_last_name: "", contact_first_name: "", contact_phone: "", contact_date_of_birth: "",
    contact_email: "", organization_or_person_name: "",
  };
}
function this_defaultPickupForm() {
  return {
    responder_type: "individual_volunteer", content_brought: "",
    responder_last_name: "", responder_first_name: "", responder_phone: "", responder_date_of_birth: "",
    responder_email: "", organization_or_person_name: "",
  };
}
