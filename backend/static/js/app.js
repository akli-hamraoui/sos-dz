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

const RETRY_DELAYS_MS = [1000, 3000, 6000];

// Upload retry for weak/rural connections (spec Wave 2: "automatic retry on
// upload failure, 3 attempts with increasing delay"). Only retries on
// network failure or a 5xx -- a 4xx (validation error, rejected content) is
// never retried, since retrying it would just fail again. FormData bodies
// are never JSON-encoded: the browser sets its own multipart boundary.
async function apiUpload(path, formData, method = "POST", onStatus = () => {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      onStatus(`Upload failed, retrying (${attempt}/${RETRY_DELAYS_MS.length})...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
    }
    try {
      const resp = await fetch(API + path, { method, body: formData });
      let data = null;
      try { data = await resp.json(); } catch (e) { /* no body */ }
      if (resp.ok) {
        onStatus("");
        return data;
      }
      if (resp.status < 500) {
        // Validation/permission error -- retrying would not help.
        const err = new Error((data && data.detail) || "Request failed");
        err.status = resp.status;
        err.data = data;
        throw err;
      }
      lastError = new Error((data && data.detail) || `Server error (${resp.status})`);
    } catch (e) {
      if (e.status && e.status < 500) throw e; // non-retryable, re-throw immediately
      lastError = e;
    }
  }
  onStatus("Upload failed after several attempts. Your entry was kept on this screen -- check your connection and try again.");
  throw lastError;
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
    revealedPickupPhones: {},
    shareLink: "",
    canSeeLiveMap: false,
    mapHasNoNeedsAtAll: false,
    progressText: {},
    createForm: this_defaultCreateForm(),
    createError: "",
    createUploadStatus: "",
    damagePhotos: [],
    deliveryPhotos: {},
    recorder: { recording: false, seconds: 0, blob: null, blobUrl: null, mediaRecorder: null, stream: null, timer: null },
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
      try {
        this.config = await api("/config/");
        if (this.config.turnstile_enabled && !document.getElementById("turnstile-script")) {
          const s = document.createElement("script");
          s.id = "turnstile-script";
          s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
          s.async = true;
          s.defer = true;
          document.head.appendChild(s);
        }
      } catch (e) { /* ignore */ }
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
        const needId = parts[1].split("?")[0];
        await this.loadNeedDetail(needId);
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
        const formData = new FormData();
        for (const [k, v] of Object.entries(this.createForm)) {
          if (v !== null && v !== "") formData.append(k, v);
        }
        formData.append("turnstile_token", window.__turnstileToken || "");
        if (this.createForm.media_type !== "text" && this.recorder.blob) {
          const ext = this.createForm.media_type === "audio" ? "webm" : "webm";
          formData.append("media_file", this.recorder.blob, `recording.${ext}`);
        }
        this.damagePhotos.forEach((p) => formData.append("damage_photos", p.file, p.file.name));

        const need = await apiUpload("/needs/", formData, "POST", (s) => (this.createUploadStatus = s));
        this.needTokens[need.id] = { access_token: need.access_token, location_viewer_share_token: need.location_viewer_share_token };
        saveJSON("rassemble_need_tokens", this.needTokens);
        this.discardRecording();
        this.damagePhotos = [];
        window.location.hash = `#/needs/${need.id}`;
      } catch (e) {
        this.createError = (e.data && JSON.stringify(e.data)) || e.message;
      }
    },

    // ---- Media capture (Wave 2) ----
    async startRecording(kind) {
      const constraints = kind === "video" ? { video: { facingMode: "environment" }, audio: true } : { audio: true };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const mediaRecorder = new MediaRecorder(stream);
      const chunks = [];
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: mediaRecorder.mimeType || (kind === "video" ? "video/webm" : "audio/webm") });
        this.recorder.blob = blob;
        this.recorder.blobUrl = URL.createObjectURL(blob);
        stream.getTracks().forEach((t) => t.stop());
      };
      this.recorder.mediaRecorder = mediaRecorder;
      this.recorder.stream = stream;
      this.recorder.seconds = 0;
      this.recorder.recording = true;
      mediaRecorder.start();
      this.recorder.timer = setInterval(() => {
        this.recorder.seconds += 1;
        if (kind === "video" && this.recorder.seconds >= 20) this.stopRecording(); // hard cap, spec Wave 2
      }, 1000);
    },
    stopRecording() {
      if (this.recorder.timer) clearInterval(this.recorder.timer);
      this.recorder.recording = false;
      if (this.recorder.mediaRecorder && this.recorder.mediaRecorder.state !== "inactive") {
        this.recorder.mediaRecorder.stop();
      }
    },
    discardRecording() {
      if (this.recorder.timer) clearInterval(this.recorder.timer);
      if (this.recorder.stream) this.recorder.stream.getTracks().forEach((t) => t.stop());
      if (this.recorder.blobUrl) URL.revokeObjectURL(this.recorder.blobUrl);
      this.recorder = { recording: false, seconds: 0, blob: null, blobUrl: null, mediaRecorder: null, stream: null, timer: null };
    },
    async compressPhoto(file) {
      if (typeof imageCompression === "undefined") return file; // vendored lib failed to load -- upload uncompressed rather than block
      try {
        return await imageCompression(file, { maxWidthOrHeight: 1280, initialQuality: 0.7, useWebWorker: true, fileType: "image/jpeg" });
      } catch (e) {
        return file;
      }
    },
    async addDamagePhoto(event) {
      const file = event.target.files[0];
      event.target.value = ""; // allow re-selecting/re-capturing the same shot
      if (!file || this.damagePhotos.length >= 3) return;
      const compressed = await this.compressPhoto(file);
      this.damagePhotos.push({ file: compressed, previewUrl: URL.createObjectURL(compressed) });
    },
    async addDeliveryPhoto(event, pickupId) {
      const file = event.target.files[0];
      event.target.value = "";
      if (!this.deliveryPhotos[pickupId]) this.deliveryPhotos[pickupId] = [];
      if (!file || this.deliveryPhotos[pickupId].length >= 3) return;
      const compressed = await this.compressPhoto(file);
      this.deliveryPhotos[pickupId].push({ file: compressed, previewUrl: URL.createObjectURL(compressed) });
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
          body: JSON.stringify({ ...this.pickupForm, need: this.currentNeed.id, turnstile_token: window.__turnstileToken || "" }),
        });
        this.pickupTokens[pickup.id] = pickup.access_token;
        saveJSON("rassemble_pickup_tokens", this.pickupTokens);
        window.location.hash = `#/needs/${this.currentNeed.id}`;
        await this.loadNeedDetail(this.currentNeed.id);
        this.route = "detail"; // hash may be unchanged (see "Also take charge" below), so hashchange won't fire
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
      const formData = new FormData();
      formData.append("access_token", token);
      (this.deliveryPhotos[pickupId] || []).forEach((p) => formData.append("delivery_photos", p.file, p.file.name));
      await apiUpload(`/pickups/${pickupId}/deliver/`, formData);
      delete this.deliveryPhotos[pickupId];
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
      const pins = await api("/needs/locations/");
      this.mapHasNoNeedsAtAll = pins.length === 0;
      if (this.mapHasNoNeedsAtAll) return; // truly zero listings anywhere -- show the message instead of a map
      await this.$nextTick();
      const el = document.getElementById("main-map");
      if (!el || typeof L === "undefined") return;
      if (!this._mainMap) {
        this._mainMap = L.map(el);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap" }).addTo(this._mainMap);
      }
      const map = this._mainMap;
      (this._mainMapMarkers || []).forEach((m) => map.removeLayer(m));
      const markers = [];
      this._mainMapMarkers = markers;

      const withPos = pins.filter((p) => p.display_latitude != null && p.display_longitude != null);
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
    contact_email: "", organization_or_person_name: "", media_type: "text",
  };
}
function this_defaultPickupForm() {
  return {
    responder_type: "individual_volunteer", content_brought: "",
    responder_last_name: "", responder_first_name: "", responder_phone: "", responder_date_of_birth: "",
    responder_email: "", organization_or_person_name: "",
  };
}
