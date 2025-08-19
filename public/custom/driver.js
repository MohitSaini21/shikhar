let socket = null;
let isProvidingLocation = false;

let previousPoint = null;

let distanceCovered = 0;
window._wasManuallyRejected = false;

let peerConnection = null;
const lastNotification = null;

let reconnectTimeout;
let recorder = null;
let chunks = [];
let isSharing = false;

const RADIUS_METERS = 1000;
let mediaStream = null;
let isShowingRoute = false; // Track current state

let lastCampusChecked = null;
let lastProximityChecked = null;
const iceConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function connectionDenied(message, errorType = "gpsApart") {
  cleanupConnection();
  if (socket && socket.connected) {
    socket.disconnect();
  }

  const html = `
  <div class="col-12 grid-margin stretch-card" id="goBack">
    <div class="card">
      <div class="card-body">
        <h4 class="card-title">${user.name} (${user.role})</h4>
        <p class="card-description">${message}</p>

        ${
          errorType === "gps"
            ? `
              <div class="template-demo">
                <button class="btn btn-danger btn-fw">
                  <a href="/DC" style="text-decoration: none; color: inherit;">वापस जाएँ</a>
                </button>
                <button class="btn btn-success btn-fw" onclick="window.location.href='/DC/goLive'">
                  🔁 फिर से प्रयास करें
                </button>
              </div>
            `
            : ""
        }

      </div>
    </div>
  </div>
`;

  const temp = document.createElement("div");
  temp.innerHTML = html.trim();

  const mainRow = document.getElementById("mainRow");
  document.getElementById("rowMain").innerHTML = "";
  if (mainRow) {
    mainRow.innerHTML = "";
    mainRow.appendChild(temp.firstChild);
  }

  if (errorType == "gps" && isProvidingLocation) {
    setTimeout(() => {
      window.location.reload();
    }, 3000);
  }
}

function areLatLonClose(lat1, lon1, lat2, lon2, tolerance = 0.000009) {
  return Math.abs(lat1 - lat2) < tolerance && Math.abs(lon1 - lon2) < tolerance;
}

function saveLocation(position) {
  const currentTime = Date.now();
  const coords = position.coords;

  const baseData = {
    latitude: coords.latitude,
    longitude: coords.longitude,
    accuracy: coords.accuracy,
    timestamp: currentTime,
  };

  // ✅ First point — accept it directly
  if (previousPoint === null) {
    previousPoint = { latitude: coords.latitude, longitude: coords.longitude };
    return baseData;
  }

  // ✅ Check if too similar — skip update
  const isSame = areLatLonClose(
    previousPoint.latitude,
    previousPoint.longitude,
    coords.latitude,
    coords.longitude
  );

  if (isSame) {
    return baseData;
  }

  // ✅ Update previous point and return new data
  previousPoint = { latitude: coords.latitude, longitude: coords.longitude };
  return baseData;
}

setTimeout(() => {
  navigator.geolocation.watchPosition(
    (position) => {
      const locationData = saveLocation(position);

      if (!locationData) {
        socket.emit("busLocationUpdate", locationData);
        return;
      }
      locationData.bus = bus;

      if (socket && socket.connected) {
        socket.emit("busLocationUpdate", locationData);
        if (!isProvidingLocation) {
          isProvidingLocation = true;
        }

        // let's check is it  time to check the stops proximity
        if (!lastCampusChecked) lastCampusChecked = Date.now();
        if (!lastProximityChecked) lastProximityChecked = Date.now();

        const now = Date.now();

        if (now - lastCampusChecked > 10000) {
          // Every 10 seconds
          console.log("Time to check campus alert...");
          checkCampusEvent(locationData.latitude, locationData.longitude);
          lastCampusChecked = now;
        }

        if (now - lastProximityChecked > 5000) {
          // Every 5 seconds
          checkProximity(
            locationData.latitude,
            locationData.longitude,
            locationData.accuracy
          );
          DistanceCover(
            locationData.latitude,
            locationData.longitude,
            locationData.accuracy
          );
          lastProximityChecked = now;
        } else {
          console.log(
            "Skipping Frequent Proximities Checking and Events Tracking"
          );
        }
      } else {
        buildConnection();
      }
    },
    (error) => handleGeolocationError(error),
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15000,
    }
  );
}, 5000);

function handleGeolocationError(error) {
  const messages = {
    1: {
      message:
        "❌ अनुमति अस्वीकृत: उपयोगकर्ता ने वेबसाइट को लोकेशन एक्सेस की अनुमति नहीं दी।",
      suggestion: "कृपया वेबसाइट को लोकेशन अनुमति दें।",
    },
    2: {
      message: "❌ स्थिति अनुपलब्ध: डिवाइस लोकेशन नहीं खोज सका।",
      suggestion: "कृपया GPS ऑन करें या खुले स्थान पर जाएं।",
    },
    3: {
      message: "⌛ समय समाप्त: लोकेशन प्राप्त करने में अधिक समय लग गया।",
      suggestion: "इंटरनेट या GPS की स्थिति जांचें।",
    },
    default: {
      message: `⚠️ अज्ञात त्रुटि: ${error.message}`,
      suggestion: "कृपया डिवाइस की सेटिंग्स जांचें।",
    },
  };
  const { message, suggestion } = messages[error.code] || messages.default;
  console.error("📡 GPS Error:", error.message);
  connectionDenied(
    `📡 GPS त्रुटि: ${message}<br /><br />📌 सुझाव: ${suggestion}`,
    "gps"
  );
  if (typeof safeSpeakHindi === "function") safeSpeakHindi(suggestion);
}

let reconnectAttempt = 0;
isReconnecting = false;
let reconnectTimer = null; // store timer ID
function buildConnection() {
  if (socket) {
    console.log("🧹 Cleaning up old socket listners to prevent memery leak");
    socket.removeAllListeners(); // Clean up all previous listeners
    socket.disconnect(); // <- add this
  }

  socket = io({
    reconnection: false,
    timeout: 20000, // Connection timeout
    query: { role: user.role, liveBusId: bus._id },
  });
  //  refreshRequest if bus details is updated or driver and conductor they are not allowed to provide locatioin got it

  socket.on("connect", () => {
    console.log("✅ Connected to server");
    // reset reconnect state
    isReconnecting = false;
    reconnectAttempt = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  });

  socket.on("refreshRequest", (busId) => {
    window.location.reload();
  });

  socket.on("disconnectReason", (msg) => {
    if (msg === "duplicate_connection") window._wasManuallyRejected = true;
  });

  socket.on("connect_timeout", () => {
    console.warn("⏰ Connection timed out after 20s");
    let msg;
    if (isProvidingLocation) {
      msg =
        "⏰ **कनेक्शन समय समाप्त हो गया है।**\n\n🔄 कृपया प्रतीक्षा करें, हम पुनः कनेक्ट करने का प्रयास कर रहे हैं। जैसे ही नेटवर्क उपलब्ध होगा, कनेक्शन स्वतः स्थापित हो जाएगा।";
    } else {
      msg = "कनेक्शन समय समाप्त हो गया। कृपया फिर से प्रयास करें।";
    }

    connectionDenied(msg);
  });

  // this ois the refreshing event to make the page is refres or redirect he user to back to index.page

  // socket.on("refreshIntervalRequest", () => {
  //   socket.disconnect();
  //   setTimeout(() => {
  //     console.log("🔄 Refreshing the page...");
  //     window.location.href = "/DC";
  //   }, 1000);
  // });
  socket.on("disconnect", (reason) => {
    console.log("Disconnect reason:", reason);

    cleanupConnection();

    // Don't show message if client itself disconnected
    if (reason === "io client disconnect") {
      return;
    }

    const isHidden = document.visibilityState === "hidden";
    const manuallyRejected = window._wasManuallyRejected === true;

    let msg;

    if (reason === "ping timeout" || reason === "transport close") {
      msg = isHidden
        ? "आपकी टैब पृष्ठभूमि में थी, जिससे कनेक्शन बंद हो गया।"
        : "नेटवर्क समस्या या लंबे समय तक निष्क्रियता के कारण कनेक्शन टूट गया।";
    } else if (reason === "io server disconnect") {
      if (!manuallyRejected) {
        msg = isHidden
          ? "जब आप दूसरी टैब पर थे, तब कनेक्शन बंद कर दिया गया। हम सर्वर से कनेक्ट नहीं हो सके।"
          : "वर्तमान में सर्वर से कनेक्शन नहीं हो पा रहा है...";
      } else {
        msg =
          "🚫 यह बस अभी हेल्पर द्वारा लाइव की जा रही है। कृपया पहले उसे डिस्कनेक्ट करें और फिर कोशिश करें।"; // Don't show anything
      }
    } else {
      msg = "❓ अज्ञात कारण से कनेक्शन टूट गया।";
    }

    if (msg) {
      msg += "<br><br>🔄 <b>कनेक्ट किया जा रहा है... कृपया प्रतीक्षा करें।</b>";
      connectionDenied(msg);
    }

    // Optional: Reset the manual flag
    window._wasManuallyRejected = false;

    scheduleReconnect();
  });

  // Manually Disconnectin Socket Beofore Page is closed and Page si refreshed .

  window.addEventListener("beforeunload", () => {
    if (socket && socket.connected && distanceCovered > 0) {
      socket.emit("distanceAdding", { busId: bus._id, distanceCovered });
      distanceCovered = 0;
    }

    socket?.connected && socket.disconnect();
  });

  socket.on("connectionApproved", renderStreamingUI);

  socket.on("admin-answer", ({ offer }) =>
    peerConnection?.setRemoteDescription(new RTCSessionDescription(offer))
  );
  socket.on("ice-candidate", ({ candidate }) =>
    peerConnection?.addIceCandidate(new RTCIceCandidate(candidate))
  );
  socket.on("refresh", () => {
    if (isSharing) {
      console.log("Admin disconnected, refreshing video stream...");
      recorder?.state === "recording" && recorder.stop();
      peerConnection?.close();
      peerConnection = null;
      collectionIceCandidateInfo();
    }
  });
}

function scheduleReconnect() {
  if (isReconnecting) return; // already reconnecting

  reconnectAttempt++;
  const delay = 5000;
  console.log(`⏳ Reconnecting in ${delay / 1000} seconds...`);
  isReconnecting = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  reconnectTimer = setTimeout(() => {
    console.log(`🔁 Attempting to reconnect #${reconnectAttempt}`);
    buildConnection();
  }, delay);
}

function cleanupConnection() {
  // 🛑 Stop recorder
  if (recorder?.state === "recording") recorder.stop();
  // 🛑 Stop camera stream if mediaStream exists
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => {
      track.stop();
    });
    mediaStream = null;
  }

  // 🧼 Also clean up video element if it exists
  const videoElement = document.getElementById("driverVideo");

  if (videoElement && videoElement.srcObject) {
    videoElement.srcObject.getTracks().forEach((track) => {
      track.stop();
    });
    videoElement.srcObject = null;
    videoElement.removeAttribute("src"); // Optional: extra cleanup
    videoElement.load(); // Optional: resets the video element

    // 📤 Inform server
    socket.emit("stopStreaming", { busId: bus._id });
    socket.emit("streamNotification", { busId: bus._id, about: "stoped" });
  }

  isSharing = false;
  peerConnection?.close();
  peerConnection = null;
  recorder = null;
  chunks = [];
}

function renderStreamingUI() {
  const html = `
<div class="col-12 grid-margin stretch-card" id="goAhead">
  <div class="card">
    <div class="card-body">
      <h4 class="card-title">${user.name} (${user.role})</h4>
      <p class="card-description">
        बस की लोकेशन साझा करना बंद करने के लिए कृपया <code>चेक्ड आउट</code> बटन पर क्लिक करें।
      </p>

      
    

      
      
      
      
      <button class="btn btn-danger btn-fw">
      <a href="/DC" style="text-decoration: none; color: inherit;">चेक्ड आउट</a>
      </button>

          
      
      <br>
      <br>
      
          
        <!-- 📡 Streaming Button (default Bootstrap style) -->
        <button onclick="toggleStreaming(this)" class="btn btn-success btn-fw">
          📡 स्ट्रीमिंग शुरू करें
        </button>



      
    </div>
  </div>
</div>


 <div class="col-md-12 grid-margin stretch-card" id="videoTag" style="height: 60vh; position: relative;">
  <div class="card h-100">
    <div class="card-body p-0" style="height: 100%; position: relative;">
      <iframe
        id="videoIframe"
        src="/locationBus/${bus._id}"
        frameborder="0"
        style="width: 100%; height: 100%;"
        allow="autoplay; fullscreen">
      </iframe>

   <!-- Zoom/Control Panel -->
<div
  id="zoomControls"
  style="
    position: absolute;
   bottom: 48px; /* 👈 moved slightly up from bottom */
    right: 12px;
    z-index: 999;
    display: flex;
    gap: 12px;
    background-color: transparent;
    padding: 6px 12px;
    border-radius: 8px;
    align-items: center;
  ">

  <!-- Zoom In -->
  <button onclick="zoomInIframe()" title="Zoom In"
    style="background: none; border: none; color: black; font-size: 22px; cursor: pointer;">
    <i class="mdi mdi-magnify-plus-outline"></i>
  </button>

  <!-- Zoom Out -->
  <button onclick="zoomOutIframe()" title="Zoom Out"
    style="background: none; border: none; color: black; font-size: 22px; cursor: pointer;">
    <i class="mdi mdi-magnify-minus-outline"></i>
  </button>

  <!-- Fly to Bus Location -->
  <button onclick="flyToBusLocation()" title="Fly to Bus Location"
    style="background: none; border: none; color: black; font-size: 22px; cursor: pointer;">
    <i class="mdi mdi-crosshairs-gps"></i>
  </button>

  <!-- Show Stops -->
  <button onclick="toggleStopsVisibility()" title="Toggle Stops"
    style="background: none; border: none; color: black; font-size: 22px; cursor: pointer;">
    <i class="mdi mdi-map-marker-multiple-outline"></i>
  </button>

  <!-- Show Route -->
  <button onclick="toggleRouteVisibility()" title="Toggle Route"
    style="background: none; border: none; color: black; font-size: 22px; cursor: pointer;">
    <i class="mdi mdi-vector-line"></i>
  </button>
</div>

    </div>
  </div>
</div>

  `;

  const tempDiv = document.createElement("div");
  tempDiv.innerHTML = html.trim();
  const mainRow = document.getElementById("mainRow");
  if (mainRow) {
    mainRow.innerHTML = "";
    tempDiv.childNodes.forEach((el) => mainRow.appendChild(el));
  }
  const mapContainer = document.getElementById("videoTag");
  mapContainer.scrollIntoView({ behavior: "smooth", block: "center" });
}

function zoomInIframe() {
  const mapContainer = document.getElementById("videoTag");
  if (mapContainer.classList.contains("fullscreen-map")) {
    return;
  }
  if (mapContainer) {
    mapContainer.classList.remove("grid-margin", "stretch-card", "col-md-12");
    mapContainer.classList.add("fullscreen-map");
  }
}

function zoomOutIframe() {
  const mapContainer = document.getElementById("videoTag");

  if (mapContainer) {
    // Step 1: Animate zoom-out

    if (!mapContainer.classList.contains("fullscreen-map")) {
      return;
    }

    mapContainer.classList.add("shrink-map");

    // Step 2: After animation ends
    setTimeout(() => {
      mapContainer.classList.add("grid-margin", "stretch-card", "col-md-12");
      mapContainer.classList.remove("shrink-map", "fullscreen-map");
      mapContainer.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 400);
  }
}

function flyToBusLocation() {
  // Your logic to fly camera to bus location (Mapbox, Leaflet, etc.)
  document
    .getElementById("videoIframe")
    .setAttribute("src", `/locationBus/${bus._id}`);
}

function toggleRouteVisibility() {
  try {
    const iframe = document.getElementById("videoIframe");
    const busId = bus._id;

    if (isShowingRoute) {
      // Show current location
      iframe.setAttribute("src", `/locationBus/${busId}`);
    } else {
      // Show full route
      iframe.setAttribute("src", `/routingMachine?busId=${busId}`);
    }

    isShowingRoute = !isShowingRoute; // Toggle state
  } catch (error) {
    console.log(error.message);
  }
}

function toggleStopsVisibility() {
  // Your logic to show/hide bus stops
  // Show the modal
  $("#staticBackdrop").modal("show");
}

async function requestCameraStream() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    return stream; // 🎥 Success
  } catch (error) {
    console.error("📷 Camera access error:", error);

    let errorMsg =
      "कैमरा एक्सेस नहीं किया जा सका। कृपया अनुमति दें और फिर से प्रयास करें।";

    // Optional: customize error message
    if (error.name === "NotAllowedError") {
      errorMsg = "आपने कैमरा एक्सेस की अनुमति नहीं दी। कृपया अनुमति दें।";
    } else if (error.name === "NotFoundError") {
      errorMsg = "कोई कैमरा डिवाइस नहीं मिला। कृपया जांचें।";
    }

    alert("🚫 " + errorMsg);

    if (typeof safeSpeakHindi === "function") {
      safeSpeakHindi(errorMsg);
    }

    return null; // 🔴 Stream failed
  }
}
function toggleStreaming(button) {
  if (isSharing) {
    stopStreaming(button);
  } else {
    startStreaming(button);
  }
}

async function startStreaming(button) {
  const stream = await requestCameraStream();
  if (!stream) return; // 🔒 Stop if stream not available
  isSharing = true;

  socket.emit("streamNotification", { busId: bus._id, about: "started" });

  const previewHTML = `
    <div class="col-md-6 grid-margin stretch-card" id="tagVideo" style="height: 60vh; position: relative;">
  <div class="card h-100">
    <div class="card-body p-0" style="height: 100%; position: relative;">
      <video id="driverVideo" autoplay></video>

         <!-- Zoom/Control Panel -->
<div
  id="zoomControls"
  style="
    position: absolute;
    bottom: 60px;   
    right: 12px;
    z-index: 999;
    display: flex;
    gap: 12px;
    background-color: transparent;
    padding: 6px 12px;
    border-radius: 8px;
    align-items: center;
  ">

  <!-- Zoom In -->
  <button onclick="zoomInVframe()" title="Zoom In"
    style="background: none; border: none; color: black; font-size: 22px; cursor: pointer;">
    <i class="mdi mdi-magnify-plus-outline"></i>
  </button>

  <!-- Zoom Out -->
  <button onclick="zoomOutVframe()" title="Zoom Out"
    style="background: none; border: none; color: black; font-size: 22px; cursor: pointer;">
    <i class="mdi mdi-magnify-minus-outline"></i>
  </button>

  
</div>

    </div>
  </div>
</div>
  `;

  const tempDiv = document.createElement("div");
  tempDiv.innerHTML = previewHTML.trim();
  const rowMain = document.getElementById("rowMain");
  rowMain.innerHTML = "";
  rowMain.appendChild(tempDiv.firstChild);
  const mapContainer = document.getElementById("tagVideo");
  mapContainer.scrollIntoView({ behavior: "smooth", block: "center" });

  await collectionIceCandidateInfo();

  button.innerText = "स्ट्रीमिंग रोकें";
  button.classList.remove("btn-success");
  button.classList.add("btn-danger");
}

function zoomInVframe() {
  const mapContainer = document.getElementById("tagVideo");
  if (mapContainer) {
    mapContainer.classList.remove("grid-margin", "stretch-card", "col-md-12");
    mapContainer.classList.add("fullscreen-map");
  }
}

function zoomOutVframe() {
  const mapContainer = document.getElementById("tagVideo");

  if (mapContainer) {
    // Step 1: Animate zoom-out
    mapContainer.classList.add("shrink-map");

    // Step 2: After animation ends
    setTimeout(() => {
      mapContainer.classList.add("grid-margin", "stretch-card", "col-md-12");
      mapContainer.classList.remove("shrink-map", "fullscreen-map");
      mapContainer.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 400);
  }
}

function stopStreaming(button) {
  // // 🛑 Stop recorder
  // if (recorder?.state === "recording") recorder.stop();
  // // 🛑 Stop camera stream if mediaStream exists
  // if (mediaStream) {
  //   mediaStream.getTracks().forEach((track) => {
  //     track.stop();
  //   });
  //   mediaStream = null;
  // }

  // // 🧼 Also clean up video element if it exists
  // const videoElement = document.getElementById("driverVideo");

  // if (videoElement && videoElement.srcObject) {
  //   videoElement.srcObject.getTracks().forEach((track) => {
  //     track.stop();
  //   });
  //   videoElement.srcObject = null;
  //   videoElement.removeAttribute("src"); // Optional: extra cleanup
  //   videoElement.load(); // Optional: resets the video element
  // }

  // 🧹 Clean peer connection
  cleanupConnection();

  // 🧹 UI cleanup
  document.getElementById("rowMain").innerHTML = "";

  // 🔁 Update button
  button.innerText = "स्ट्रीमिंग शुरू करें";
  button.classList.remove("btn-danger");
  button.classList.add("btn-success");

  const mapContainer = document.getElementById("videoTag");
  mapContainer.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function collectionIceCandidateInfo() {
  peerConnection = new RTCPeerConnection(iceConfig);
  mediaStream = await navigator.mediaDevices.getUserMedia({ video: true });

  recorder = new MediaRecorder(mediaStream);
  recorder.ondataavailable = (event) =>
    event.data.size > 0 && chunks.push(event.data);
  recorder.onstop = () => {
    const completeBlob = new Blob(chunks, { type: "video/webm" });
    const fileName = `busStream(${
      user.assignedBus.busNumber
    })_${Date.now()}.webm`;
    const url = URL.createObjectURL(completeBlob);

    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();

    URL.revokeObjectURL(url);
    document.body.removeChild(a);
  };
  recorder.start();

  window.addEventListener("beforeunload", () => {
    if (recorder?.state === "recording") recorder.stop();
  });

  mediaStream
    .getTracks()
    .forEach((track) => peerConnection.addTrack(track, mediaStream));
  const localVideo = document.getElementById("driverVideo");
  if (localVideo) localVideo.srcObject = mediaStream;

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("ice-candidate", {
        bus,
        candidate: event.candidate,
      });
    }
  };

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  socket.emit("driver-offer", { bus, offer });
}

function updateButtonStatus(btn, type, text) {
  const iconMap = {
    sending: "mdi-bell-ring-outline text-warning",
    success: "mdi-check-circle text-success",
    error: "mdi-close-circle text-danger",
    idle: "mdi-bell",
  };

  btn.innerHTML = `<i class="mdi ${iconMap[type]} mr-2"></i> ${text}`;

  if (type === "success" || type === "error") {
    setTimeout(() => {
      btn.innerHTML = `<i class="mdi ${
        iconMap.idle
      } mr-2"></i> ${btn.getAttribute("data-stop-name")}`;
    }, 4000);
  }
}

function emitNotification(stopId, status, distance, btn) {
  const payload = { stopId, status, busId: bus._id };
  if (typeof distance !== "undefined") {
    payload.distance = distance;
  }

  socket.emit("sendNotificiation", payload, (isConfirm) => {
    if (!btn) {
      return;
    }
    updateButtonStatus(
      btn,
      isConfirm ? "success" : "error",
      isConfirm ? "नोटिफिकेशन भेज दी गई" : "नोटिफिकेशन नहीं भेजी जा सकी"
    );
  });
}

function notifyStatus(stopId, status, lat, lon) {
  const btn = document.getElementById(`dropdownMenu-${stopId}`);
  if (!btn) return;

  updateButtonStatus(btn, "sending", "नोटिफिकेशन भेजी जा रही है...");

  // Directly emit for "arrived"/"departed" without location check
  if (status === "arrived" || status === "departed" || status === "departing") {
    emitNotification(stopId, status, undefined, btn);
    return;
  }

  // For "arriving"/"departing", get location and compute distance
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      const distance = getDistance({
        lat1: Number(lat),
        lon1: Number(lon),
        lat2: latitude,
        lon2: longitude,
      });
      console.log(`📏 Distance from stop: ${distance} meters`);
      emitNotification(stopId, status, distance, btn);
    },
    (err) => {
      console.warn(
        "⚠️ Location error, proceeding without distance:",
        err.message
      );
      emitNotification(stopId, status, undefined, btn);
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0,
    }
  );
}

function notifyCampus(campus, event) {
  if (campus && event) {
    console.log("📡 Emitting campus event:", campus, event);

    const btn = document.getElementById(`dropdownMenu-${campus}`);
    if (!btn) return;

    // Show loading state
    btn.innerHTML = `<i class="mdi mdi-bell-ring-outline text-warning mr-2"></i> नोटिफिकेशन भेजी जा रही है...`;

    // Send socket event with callback as 3rd parameter
    socket.emit(
      "campusEvent",
      { campus, event, busId: bus._id },
      (isConfirm) => {
        if (isConfirm) {
          btn.innerHTML = `<i class="mdi mdi-check-circle text-success mr-2"></i> नोटिफिकेशन भेज दी गई`;
        } else {
          btn.innerHTML = `<i class="mdi mdi-close-circle text-danger mr-2"></i> नोटिफिकेशन नहीं भेजी जा सकी`;
        }

        // Restore original label after 4 seconds
        setTimeout(() => {
          btn.innerHTML = `<i class="mdi mdi-bell mr-2"></i> ${btn.getAttribute(
            "data-campus-name"
          )}`;
        }, 4000);
      }
    );
  }
}

function getDistance({ lat1, lon1, lat2, lon2 }) {
  const R = 6371000; // Earth's radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;

  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);

  const a =
    Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  const distanceInMeters = R * c;
  return Math.floor(distanceInMeters); // rounded down to nearest meter
}

const reachedStops = {}; // Tracks stop reach status per stopId
let isMorning;

// 1. Determine whether it is morning or evening (IST)
(function () {
  const nowUTC = new Date();
  const IST_OFFSET = 5.5 * 60;
  const localOffset = nowUTC.getTimezoneOffset();
  const istTime = new Date(
    nowUTC.getTime() + (IST_OFFSET + localOffset) * 60000
  );

  const hourIST = istTime.getHours();
  isMorning = hourIST < 12;

  console.log("Current IST Time:", istTime.toLocaleTimeString("en-IN"));
  console.log("isMorning:", isMorning);
})();

// 2. Main function to check proximity
function checkProximity(busLat, busLng, accuracy) {
  const stops = bus.routeStops;
  if (!stops || !stops.length) return;

  for (const stop of stops) {
    if (!stop || !stop._id || !stop.latitude || !stop.longitude) continue;

    const stopId = stop._id.toString();

    // Ensure entry exists for this stop
    if (!reachedStops[stopId]) {
      reachedStops[stopId] = { isMorning: false, isEvening: false };
    }

    // Skip if already logged for current time of day
    const stopStatus = reachedStops[stopId];
    if (
      (isMorning && stopStatus.isMorning) ||
      (!isMorning && stopStatus.isEvening)
    ) {
      continue;
    }

    // Calculate distance
    const stopLat = parseFloat(stop.latitude);
    const stopLng = parseFloat(stop.longitude);
    const distance = getDistance({
      lat1: Number(busLat),
      lon1: Number(busLng),
      lat2: stopLat,
      lon2: stopLng,
    });

    if (distance <= RADIUS_METERS) {
      console.log(
        `📍 Bus reached "${stop.stopName}" at ${new Date().toLocaleTimeString(
          "en-IN"
        )}`
      );

      emitNotification(stopId, "arrived", distance, null);

      // Mark as reached for morning or evening
      if (isMorning) {
        stopStatus.isMorning = true;
      } else {
        stopStatus.isEvening = true;
      }
    } else {
      console.log(`🚌 Bus is ${distance}m away from "${stop.stopName}"`);
    }
  }
}

//  Function to Check Campus Alert
let campusPrev = null;

function checkCampusEvent(lat, lng) {
  const currentPoint = { latitude: lat, longitude: lng };

  if (!campusPrev) {
    campusPrev = currentPoint;
    return;
  }

  const event = checkEntryExit(campusPrev, currentPoint, campuses);
  console.log("Checking Campus Alert..............................");
  if (event) {
    notifyCampus(event.campus, event.eventType);
  }

  campusPrev = currentPoint;
}

function checkEntryExit(previousPoint, currentPoint, campuses) {
  console.log("Checking Campus Alert..............................");
  if (!previousPoint || !currentPoint) {
    console.warn("⚠️ Incomplete data for checkEntryExit.");
    return null;
  }

  const previousGeo = turf.point([
    previousPoint.longitude,
    previousPoint.latitude,
  ]);
  const currentGeo = turf.point([
    currentPoint.longitude,
    currentPoint.latitude,
  ]);

  for (const campus of campuses) {
    const wasInside = turf.booleanPointInPolygon(previousGeo, campus.polygon);
    const isInside = turf.booleanPointInPolygon(currentGeo, campus.polygon);

    if (!wasInside && isInside) {
      return { campus: campus.name, eventType: "Entered" };
    } else if (wasInside && !isInside) {
      return { campus: campus.name, eventType: "Exited" };
    } else {
      console.log("Bus is  at either outside or inside campus");
    }
  }

  return null;
}
// Function to track distance and speed using GPS data
let disPrev = null;
let lastDistanceTimeStamp = null;

const speedLogs = [];

function DistanceCover(lat, lng, accuracy) {
  const currentPoint = { latitude: lat, longitude: lng };

  // ✅ Skip until we have a previous point to compare
  if (!disPrev) {
    disPrev = currentPoint;
    lastDistanceTimeStamp = Date.now(); // initialize timestamp
    return;
  }

  // ✅ Only proceed if GPS accuracy is reliable
  if (accuracy < 50) {
    const newDistance = getDistance({
      lat1: disPrev.latitude,
      lon1: disPrev.longitude,
      lat2: currentPoint.latitude,
      lon2: currentPoint.longitude,
    });

    distanceCovered += newDistance;
    disPrev = currentPoint;

    const now = Date.now();

    // ✅ Only calculate speed if we have a previous timestamp
    if (lastDistanceTimeStamp) {
      const timeElapsed = now - lastDistanceTimeStamp; // ms
      const hoursElapsed = timeElapsed / (1000 * 60 * 60); // ms → hours

      if (newDistance > 0 && hoursElapsed > 0) {
        const speed = newDistance / 1000 / hoursElapsed; // km/h

        // ✅ Safety filter: ignore unrealistic spikes (GPS glitch)
        if (speed <= 150) {
          speedLogs.push({ time: now, speed });

          if (speed > 70) {
            const message = `🚨 Over-speeding Alert from ${
              bus.busNumber
            }: ${speed.toFixed(2)} km/h`;

            if (socket && socket.connected) {
              if (!lastNotification) {
                lastNotification = now;
                socket.emit("overSpeedAlert", { busId: bus._id, message });
              } else if (now - lastNotification > 60 * 1000) {
                lastNotification = now; // reset timer
                socket.emit("overSpeedAlert", { busId: bus._id, message });
              }
            }
          } else {
            console.log(`✅ Speed: ${speed.toFixed(2)} km/h`);
          }
        } else {
          console.warn("⚠️ Ignored faulty speed spike due to GPS anomaly.");
        }
      }
    }

    lastDistanceTimeStamp = now;
  } else {
    console.log("⏭️ Skipping distance calculation due to low GPS accuracy.");
  }
}

setInterval(() => {
  if (socket && socket.connected && distanceCovered > 0) {
    socket.emit("distanceAdding", { busId: bus._id, distanceCovered });
    distanceCovered = 0;
  }
}, 30 * 1000);
  y 
window.addEventListener("offline", () => {
  console.warn("📴 Offline — disconnecting socket");
  window.location.href = "/DC";
});

window.addEventListener("online", () => {
  console.warn("🌐 Back online — will reconnect in 5s");
  return;
});
