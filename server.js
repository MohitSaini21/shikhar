// Importing Required Modules
import express from "express";

import { config } from "dotenv"; // For environment variable management

import FCM from "./model/FCM.js";
import { dcRouter } from "./routes/DC.js";
import CORE from "./model/admin.js";
import { sendNotificationToClient } from "./utils/notify.js";
import { Worker } from "worker_threads";
import os from "os";
import { setAllRouteStops } from "./utils/busRouteStops.js";
import { getBusCacheData } from "./utils/busRouteStops.js";
import BusActivityLog from "./model/busTrack.js";

import jwt from "jsonwebtoken";

import { administratorRouter } from "./routes/administrator.js";
import { adminRouter } from "./routes/admin.js";
import { publicRouter } from "./routes/public.js";

import cron from "node-cron"; // or const cron = require('node-cron');

import saveLogs from "./utils/saveLogs.js";

import { checkAuth } from "./middlware/rootCheckAuth.js";
import cookie from "cookie"; // 🔥 NOT 'cookie-parser'

import ejs from "ejs";

import http from "http";
import fs from "fs";
import path from "path";

import moment from "moment-timezone";

import cookieParser from "cookie-parser";

import { ConnectDB } from "./config/db.js";
// Handler if user want's to communicate over webScoket protocols
import { Server } from "socket.io";
import Bus from "./model/bus.js";

// Load Environment Variables
config();

const PORT = process.env.PORT || 8000; // Default to 8000 if PORT is not defined in .env
const dbUrl = process.env.DB_URL;

// Initialize Express App
const app = express();

// Initialize Passport

app.use(cookieParser());
// Enable trust proxy
// app.set("trust proxy", true);

// Middleware and Settings
// Set EJS as the view engine (Corrected 'view engine' typo)
app.set("view engine", "ejs");

// Middlewares for Parsing and Static Files (Optional, Add if Needed)
app.use(express.json()); // Parse JSON requests
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded requests
app.use(express.static("public")); // Serve static files from the "public" directory

// Import the HTTP module

// Create HTTP server and pass the app handler
const server = http.createServer(app);

// Routers
app.use(
  "/administrator/settings",
  checkAuth,
  (req, res, next) => {
    if (req.user?.role === "administrator") {
      next();
    } else {
      return res.status(204).end(); // silent drop
    }
  },
  administratorRouter
);

app.use(
  "/admin",
  checkAuth,
  (req, res, next) => {
    if (req.user?.role === "admin" || req.user?.role === "administrator") {
      next();
    } else {
      return res.status(204).end(); // silent drop
    }
  },
  adminRouter
);

app.use("/", publicRouter);

app.use(
  "/DC",
  checkAuth,
  (req, res, next) => {
    if (req.user.role == "conductor" || req.user.role == "driver") {
      next();
    }
  },
  dcRouter
);

const io = new Server(server, {
  pingInterval: 5000, // every 5s send ping
  pingTimeout: 3000, // wait 3s for pong before dropping
});

app.set("io", io); // <-- shared shelf mein rakh diy
// Object to store busId -> array of socketIds
let busConnections = {};

let allAdmins = [];
let administratorIds = [];
const peers = {};
let liveBuses = [];

let adminConnectionsBus = {};
let administratorConnectionsBus = {};

let lastLocation = new Map();

let locationEvaluationCooldown = 10000; // ms (5 seconds)
let lastEvaluated = {}; // { [busId]: timestamp }

// Cron Jobs

function deleteFileIfExists(relativePath, label = "") {
  if (!relativePath) return;

  const fullPath = path.join(process.cwd(), "public", relativePath);

  if (fs.existsSync(fullPath)) {
    try {
      fs.unlinkSync(fullPath);
      console.log(`🗑️ Deleted ${label}: ${relativePath}`);
    } catch (err) {
      console.error(`❗ Error deleting ${label}: ${relativePath}`, err);
    }
  }
}

cron.schedule(
  "0 0 * * *", // Every day at 12:00 AM IST
  async () => {
    const nowIST = moment().tz("Asia/Kolkata");

    const currentTime = nowIST.format("YYYY-MM-DD HH:mm:ss");
    console.log(`⏰ Cron triggered at (IST): ${currentTime}`);

    // 🔹 Clear in-memory object used for location checks
    console.log("🕛 12:00 AM IST: Clearing lastEvaluated memory...");
    for (const busId in lastEvaluated) {
      delete lastEvaluated[busId];
    }
    console.log("🧹 Cleared all entries from lastEvaluated");

    // 🔹 Delete old logs based on logDate (YYYY-MM-DD format)
    const cutoffDate = nowIST.clone().subtract(10, "day").format("YYYY-MM-DD");
    console.log(`🧾 Deleting logs with logDate before: ${cutoffDate}`);

    try {
      const oldLogs = await BusActivityLog.find({
        logDate: { $lt: cutoffDate },
      });

      if (oldLogs.length === 0) {
        console.log("📂 No old logs found to delete.");
        return;
      }

      console.log(`📁 Found ${oldLogs.length} old logs to delete.`);

      for (const log of oldLogs) {
        if (log.morningSnap?.image) {
          deleteFileIfExists(log.morningSnap.image, "Morning Snap");
        }

        if (log.eveningSnap?.image) {
          deleteFileIfExists(log.eveningSnap.image, "Evening Snap");
        }

        await log.deleteOne();
        console.log(`✅ Deleted log ID: ${log._id} (logDate: ${log.logDate})`);
      }

      console.log("🧹 Old logs cleanup complete.");
    } catch (error) {
      console.error("❌ Error during cleanup cron job:", error);
    }
  },
  {
    timezone: "Asia/Kolkata",
  }
);

// cron.schedule(
//   "* * * * *", // Runs every minute
//   async () => {
//     const nowIST = moment().tz("Asia/Kolkata");
//     const currentTime = nowIST.format("YYYY-MM-DD HH:mm:ss");
//     console.log(`⏰ Cleanup Cron Triggered at: ${currentTime}`);

//     // Get cutoff date (24 hours ago = one full previous day)
//     const cutoffDate = nowIST.clone().subtract(1, "day").format("YYYY-MM-DD");
//     console.log(`🧾 Deleting logs with logDate before: ${cutoffDate}`);

//     try {
//       const oldLogs = await BusActivityLog.find({
//         logDate: { $lt: cutoffDate }, // logDate is string, so direct comparison
//       });

//       if (oldLogs.length === 0) {
//         console.log("📂 No old logs found to delete.");
//         return;
//       }

//       console.log(`📁 Found ${oldLogs.length} old logs to delete.`);

//       for (const log of oldLogs) {
//         if (log.morningSnap?.image) {
//           deleteFileIfExists(log.morningSnap.image, "Morning Snap");
//         }

//         if (log.eveningSnap?.image) {
//           deleteFileIfExists(log.eveningSnap.image, "Evening Snap");
//         }

//         await log.deleteOne();
//         console.log(`✅ Deleted log ID: ${log._id} (logDate: ${log.logDate})`);
//       }

//       console.log("🧹 Old logs cleanup complete.");
//     } catch (error) {
//       console.error("❌ Error during cleanup cron job:", error);
//     }
//   },
//   {
//     timezone: "Asia/Kolkata",
//   }
// );

// Cron Jobs

// cron Job for testing
// Run every 1 minute in IST (good for testing)
// cron.schedule(
//   "*/1 * * * *",
//   async () => {
//     const currentTimeIST = moment()
//       .tz("Asia/Kolkata")
//       .format("YYYY-MM-DD HH:mm:ss");
//     console.log(`🧪 Minute Cron Test @ ${currentTimeIST}`);
//   },
//   {
//     timezone: "Asia/Kolkata",
//   }
// );

//  NewArch Based Code

const MAX_WORKERS = os.cpus().length - 2; // 8 in your case
const waitingArea = new Set(); // 👈 No duplicates
const workers = [];

const availableWorkers = [];

for (let i = 0; i < MAX_WORKERS; i++) {
  const worker = new Worker("./workerTask.js");
  workers.push(worker);
  availableWorkers.push(worker);
}
// ---- TASK & QUEUE MAPS ----
const taskQueues = new Map(); // Map<busId, Queue<Task>>
const isProcessing = new Map(); // Map<busId, Boolean>

// ---- Add task to bus queue ----
// ---- Add task to bus queue ----
function addTask(task) {
  const busId = task.bus._id;

  if (!taskQueues.has(busId)) {
    taskQueues.set(busId, []);
    isProcessing.set(busId, false);
  }

  const queue = taskQueues.get(busId);
  queue.push(task);

  console.log(`[QUEUE] Bus ${busId} → Queue length: ${queue.length}`);

  if (!isProcessing.get(busId)) {
    processQueue(busId);
  }
}
const TASK_TIMEOUT = 10000; // from 4000ms

// Ineterval to Provess Watitign Area
// setInterval(() => {
//   if (availableWorkers.length === 0) return;

//   const busId = [...waitingArea][0];
//   if (busId) {
//     waitingArea.delete(busId);
//     processQueue(busId);
//   }
// }, 500); // Every 500ms

// // To improve Memeory
// setInterval(() => {
//   for (const [busId, queue] of taskQueues) {
//     if (queue.length === 0 && !isProcessing.get(busId)) {
//       taskQueues.delete(busId);
//       isProcessing.delete(busId);
//       waitingArea.delete(busId);
//     }
//   }
// }, 10 * 60 * 1000); // Every 10 mins

function processQueue(busId) {
  if (isProcessing.get(busId)) return;

  const queue = taskQueues.get(busId);
  if (!queue || queue.length === 0) {
    // When retrying:
    let busId = [...waitingArea][0];
    if (busId) {
      waitingArea.delete(busId); // 👈 remove from set
      processQueue(busId);
    }

    return;
  }

  if (availableWorkers.length === 0) {
    waitingArea.add(busId); // 👈 No repeat entries
    return;
  }

  const task = queue.shift();
  const worker = availableWorkers.shift();

  const start = Date.now();

  let busObject = lastEvaluated[busId] ?? {};

  isProcessing.set(busId, true);

  let resolved = false;

  const clearEverything = () => {
    resolved = true;
    clearTimeout(timeout);
    worker.removeAllListeners();
    isProcessing.set(busId, false);
    availableWorkers.push(worker);
    processQueue(busId);
  };

  const timeout = setTimeout(() => {
    if (!resolved) {
      console.warn(`⏰ Timeout: Task for bus ${busId} took too long.`);
      try {
        worker.removeAllListeners();
        isProcessing.set(busId, false);
        worker.terminate().then(() => {
          // DON'T push it back, instead:
          const newWorker = new Worker("./workerTask.js");
          workers.push(newWorker);
          availableWorkers.push(newWorker);
          processQueue(busId);
        });
      } catch (e) {
        console.error("Worker termination failed:", e);
      }
    }
  }, TASK_TIMEOUT);
  timeout.unref();

  const safeTaskData = JSON.parse(JSON.stringify({ task, busObject }));
  worker.postMessage(safeTaskData);

  worker.once("message", (msg) => {
    process.nextTick(() => {
      if (resolved) return;

      if (msg?.updatedBusObject && msg?.busId) {
        lastEvaluated[msg.busId] = msg.updatedBusObject;

        if (adminConnectionsBus[msg.busId]) {
          adminConnectionsBus[msg.busId].forEach((socketId) => {
            io.to(socketId).emit("busUpdate", {
              busObject: lastEvaluated[msg.busId],
            });
          });
        }

        const timeTaken = Date.now() - start;
        console.log(`✅ Worker completed in ${timeTaken}ms`);
      } else {
        console.warn("⚠️ Malformed worker message:", msg);
      }

      clearEverything();
    });
  });

  if (!task._retries) task._retries = 0;

  worker.once("error", (err) => {
    if (resolved) return;
    console.error("💥 Worker crashed:", err);
    if (task._retries < 1) {
      task._retries++;
      taskQueues.get(busId)?.unshift(task); // Retry it
    }

    clearEverything();
  });

  worker.once("exit", (code) => {
    if (resolved) return;
    if (code !== 0) {
      console.warn(`❌ Worker exited abnormally with code ${code}`);
    }
    clearEverything();
  });
}

const pendingBusOverrides = {}; // store busId => socket.id

io.use((socket, next) => {
  try {
    const query = socket.handshake.query;

    // ✅ Allow public connections if no admin identifiers or liveBusid are present
    if (!query.adminId && !query.administratorId && !query.liveBusId) {
      return next();
    }

    const rawCookies = socket.handshake.headers.cookie || "";

    const parsed = cookie.parse(rawCookies);
    const token = parsed.authToken;

    if (!token) {
      return next(new Error("Missing auth token"));
    }

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "Secret String"
    );

    if (query.adminId) {
      socket.adminId = decoded.id;
    } else if (query.administratorId) {
      socket.administratorId = decoded.id;
    } else if (query.liveBusId) {
      socket.liveBusId = query.liveBusId;
    }

    return next();
  } catch (err) {
    console.error("🚨 JWT decode failed:", err.message);
    return next(new Error("Invalid token"));
  }
});

// Helper to safely register a socket connection under a mapping
function registerSocket(map, key, socket, label = "") {
  map[key] = map[key] || [];
  map[key].push(socket.id);

  console.log(
    `✅ New connection${label ? ` (${label})` : ""} for ${key} with socketId: ${
      socket.id
    }`
  );
  console.log(`📡 Current connections for ${key}:`, map[key]);
}

// Helper to safely remove socket ID from all arrays
function removeSocketFromMap(map, key, socketId, label = "") {
  if (!map[key]) return;

  map[key] = map[key].filter((id) => id !== socketId);
  console.log(`❌ Removed socket ${socketId} from ${label} for ${key}.`);

  if (map[key].length === 0) {
    delete map[key];
    console.log(`🗑️ Deleted empty ${label} array for ${key}.`);
  }
}

function logStopArrivalToMemory({ busId, stopId }) {
  console.log("🔍 logStopArrivalToMemory called with:", { busId, stopId });

  const cacheData = getBusCacheData(busId);
  console.log("🧠 Fetched cacheData:", cacheData);

  if (!cacheData || !Array.isArray(cacheData.routeStops)) {
    console.warn("⚠️ No routeStops found in cacheData");
    return;
  }

  console.log(
    "🛣️ routeStops:",
    cacheData.routeStops.map((s) => s?._id?.toString())
  );

  const stop = cacheData.routeStops.find((item) => {
    if (!item || !item._id) return false;
    const match = item._id.toString() === stopId.toString();
    console.log(
      `🔎 Checking stop: ${item._id?.toString()} === ${stopId.toString()} ➜ ${match}`
    );
    return match;
  });

  if (!stop) {
    console.warn("❌ Stop not found in routeStops for busId:", busId);
    return;
  }

  console.log("✅ Matched stop:", stop);

  const currentTime = moment().tz("Asia/Kolkata");
  const isMorning = currentTime.hour() < 12;
  const readableTime = currentTime.format("hh:mm A");

  if (!lastEvaluated[busId]) {
    console.warn("🚫 lastEvaluated[busId] not initialized");
    return;
  }

  if (!lastEvaluated[busId].reachedStops) {
    console.log("📌 Initializing reachedStops");
    lastEvaluated[busId].reachedStops = {};
  }

  if (!lastEvaluated[busId].reachedStops[stopId]) {
    console.log("📌 Creating stopId log entry");
    lastEvaluated[busId].reachedStops[stopId] = {};
  }

  const stopLog = lastEvaluated[busId].reachedStops[stopId];
  console.log("🧾 Existing stopLog:", stopLog);

  const alreadyLogged = isMorning ? stopLog.morningTime : stopLog.eveningTime;
  if (alreadyLogged) {
    console.log("⏩ Already logged this stop for this time of day. Skipping.");
    return;
  }

  stopLog.stopName = stop.stopName;
  if (isMorning) {
    stopLog.eMorningTime = stop.morningTime + " AM";
    stopLog.morningTime = readableTime;
  } else {
    stopLog.eEveningTime = stop.eveningTime + " PM";
    stopLog.eveningTime = readableTime;
  }

  console.log("✅ stopLog updated:", stopLog);

  // Notify admins watching this bus
  if (adminConnectionsBus[busId]) {
    console.log(
      "📤 Emitting busUpdate to admin sockets:",
      adminConnectionsBus[busId]
    );
    adminConnectionsBus[busId].forEach((socketId) => {
      io.to(socketId).emit("busUpdate", {
        busObject: lastEvaluated[busId],
      });
    });
  } else {
    console.log("ℹ️ No admin sockets connected for busId:", busId);
  }
}

// Prevent any connection in first 5s after a disconnect for same busId
const cooldowns = new Map();
io.on("connection", (socket) => {
  const query = socket.handshake.query;

  // 🎯 Priority 1: Public Viewer (no auth)
  if (query.busId) {
    const busId = query.busId;
    socket.busId = busId;

    registerSocket(busConnections, busId, socket, "Viewer");

    // 🎯 Priority 2: Admin for specific bus
  } else if (query.bus && socket.adminId) {
    const busId = query.bus;
    socket.bus = busId;

    registerSocket(adminConnectionsBus, busId, socket, "Admin (per bus)");

    // 🎯 Priority 3: Administrator for specific bus
  } else if (query.bus && socket.administratorId) {
    const busId = query.bus;
    socket.bus = busId;

    registerSocket(
      administratorConnectionsBus,
      busId,
      socket,
      "Administrator (per bus)"
    );

    // 🎯 Priority 4: Global Administrator
  } else if (socket.administratorId) {
    administratorIds.push(socket.id);
    console.log(`✅ New global administrator connection: ${socket.id}`);
    console.log(`📋 Current administrator IDs:`, administratorIds);

    // 🎯 Priority 5: Global Admin
  } else if (socket.adminId) {
    allAdmins.push(socket.id);
    console.log(`✅ New global admin connection: ${socket.id}`);
    console.log(`📋 Current admin IDs:`, allAdmins);

    // 🎯 Priority 6: Live Bus (driver/conductor)
  } else if (socket.liveBusId) {
    const busId = socket.liveBusId.toString();

    const now = Date.now();

    if (cooldowns.has(busId) && now - cooldowns.get(busId) < 3000) {
      console.log(`⏳ Rejecting ${busId} — still in cooldown`);

      socket.disconnect(true);
      return;
    }

    if (liveBuses.includes(busId)) {
      console.log(`liveBuses mai abhi bhi busId hai ...........`);
      socket.disconnect(true);
      return;
    }

    liveBuses.push(busId);
    console.log(`🟢 Bus ${busId} is now live with socket ${socket.id}`);

    // Notify admins
    allAdmins.forEach((adminSocketId) => {
      io.to(adminSocketId).emit("add", busId);
    });

    socket.emit("connectionApproved", "✅ You are now live.");
  } else {
    console.warn("🚫 Unknown or malformed connection attempt:", query);
    socket.disconnect(true);
    return;
  }

  //   |||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||  all   socket handlers to handle events |||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||
  // asking about is ther ebus obejt exist
  socket.on("liveBuses", async (callback) => {
    try {
      callback({ success: true, data: liveBuses });
    } catch (err) {
      console.error("Error fetching bus:", err);
      callback({ success: false, message: "Server error" });
    }
  });

  // to keep connection live

  socket.on("💓", () => {
    // No need to do anything. Just accepting keeps connection alive.
  });

  // allStream
  socket.on("allStream", (callback) => {
    callback(Object.keys(peers));
  });

  // offer and icecandiate storegae
  socket.on("driver-offer", ({ bus, offer }) => {
    if (!peers[bus._id]) {
      console.log(
        "New connection !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!! ne Connection !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
      );
      if (administratorIds.length) {
        for (let i = 0; i < administratorIds.length; i++) {
          io.to(administratorIds[i]).emit("newStream", bus._id);
        }
      }

      if (administratorConnectionsBus[bus._id]?.length) {
        // Iterate through each connected admin socket
        for (let i = 0; i < administratorConnectionsBus[bus._id].length; i++) {
          io.to(administratorConnectionsBus[bus._id][i]).emit(
            "newStream",
            bus._id
          );
        }
      }
    }
    if (!peers[bus._id]) peers[bus._id] = {};
    peers[bus._id].offer = offer;
    peers[bus._id].socketID = socket.id;
    console.log("Offer saved for bus:", bus._id);
  });
  socket.on("ice-candidate", ({ bus, candidate }) => {
    if (!peers[bus._id]) peers[bus._id] = {};
    if (!peers[bus._id].candidates) peers[bus._id].candidates = [];
    peers[bus._id].candidates.push(candidate);
    console.log("ICE candidate saved for bus:", bus._id);
  });
  // admin checking whether offer and candiate exsit or not
  socket.on("admin-wants-to-connect", ({ busId }) => {
    if (peers[busId]) {
      socket.emit("bus-offer-and-candidates", {
        offer: peers[busId].offer,
        candidates: peers[busId].candidates || [],
      });
    } else {
      socket.emit("bus-offer-and-candidates", {
        offer: null,
        candidates: [],
      });
    }
  });

  // Admin REalted ice candiate and asnwer

  // Relay the admin's ICE candidate back to the driver
  socket.on("admin-ice-candidate", ({ busId, candidate }) => {
    if (peers[busId]) {
      io.to(peers[busId].socketID).emit("ice-candidate", {
        bus: { _id: busId },
        candidate: candidate,
      });
    }
  });

  // Handle admin's answer to the offer from the driver
  socket.on("admin-answer", ({ busId, answer }) => {
    if (peers[busId]) {
      // Send the answer to the bus (driver)
      io.to(peers[busId].socketID).emit("admin-answer", {
        bus: { _id: busId },
        offer: answer,
      });
    }
  });

  socket.on("admin-disconnected", ({ busId }) => {
    if (peers[busId]) {
      io.to(peers[busId].socketID).emit("refresh", {
        bus: { _id: busId },
      });

      // Clean up the peer entry
      peers[busId].offer = null;
      peers[busId].candidates = [];
      console.log(`Cleaned up peers[${busId}] after admin disconnect.`);
    }
  });

  // About pTracking
  socket.on("getObject", async (data, callback) => {
    try {
      const busId = data.busId;

      // Simulate fetching the bus object from a database
      const busObject = lastEvaluated[busId]; // Use your DB model here

      if (busObject) {
        callback({ data: busObject }); // Send the object back to the client
      } else {
        callback({ data: null }); // Let the client know no data was found
      }
    } catch (error) {
      console.error("Error fetching bus object:", error);
      callback({ data: null, error: "Server error" });
    }
  });

  socket.on("lastLocation", (busId, callback) => {
    if (!liveBuses.includes(busId)) {
      const location = lastLocation.has(busId) ? lastLocation.get(busId) : null;
      callback({
        status: "true",
        data: location,
      });
    }
  });

  socket.on("lastLocationOfAllBuses", (callback) => {
    try {
      if (!lastLocation || lastLocation.size === 0) {
        return callback(null); // ❌ No location data at all
      }

      const offlineLocations = [];

      for (const [busId, data] of lastLocation.entries()) {
        // Check if bus is offline
        if (!liveBuses.includes(busId)) {
          offlineLocations.push(data); // Add last known location
        }
      }

      if (offlineLocations.length > 0) {
        callback(offlineLocations); // ✅ Send offline bus locations
      } else {
        callback(null); // ❌ No offline bus locations available
      }
    } catch (err) {
      console.error("❌ Error in lastLocationOfAllBuses:", err);
      callback(null); // Fallback if error
    }
  });

  // updating the distance

  socket.on("distanceAdding", ({ busId, distanceCovered }) => {
    distanceCovered = distanceCovered / 1000;
    if (distanceCovered > 0) {
      let busEval = lastEvaluated[busId];
      if (!busEval) {
        return;
      }

      lastEvaluated[busId].distanceCovered += distanceCovered;
    }
  });

  socket.on("busLocationUpdate", (data) => {
    try {
      if (data == null) return; // catches null or undefined only

      const busId = data.bus?._id;
      if (!busId) return;

      // 1. Clone only what's needed early
      const clientBroadcastData = {
        latitude: data.latitude,
        longitude: data.longitude,
        timestamp: data.timestamp,
        accuracy: data.accuracy,
        bus: {
          _id: busId,
        },
      };

      // 2. Broadcast to bus-connected clients
      const sockets = busConnections[busId];
      if (sockets?.length) {
        for (let i = 0; i < sockets.length; i++) {
          io.to(sockets[i]).emit("receivelocation", clientBroadcastData);
        }
      }

      // 3. Use lightweight cache fetch
      const cacheData = getBusCacheData(busId);
      const adminPayload = {
        ...clientBroadcastData,
        bus: {
          ...clientBroadcastData.bus,
          iconPhoto: cacheData.iconPhoto,
        },
      };

      // 4. Update lastLocation (used by admins)
      lastLocation.set(busId, adminPayload);

      // 5. Notify all admin and super admin sockets
      const adminTargets = [...allAdmins, ...administratorIds];
      for (let i = 0; i < adminTargets.length; i++) {
        io.to(adminTargets[i]).emit("allBusLocations", adminPayload);
      }

      // 6. Initialize bus evaluation cache if not present
      const now = Date.now();
      let busEval = lastEvaluated[busId];
      if (!busEval) {
        busEval = lastEvaluated[busId] = {
          busId,
          reachedStops: {},
          lastEvaluations: now,
          eventTimeline: [],
          path: [],
          distanceCovered: 0,
        };
      }

      // 7. Cooldown check — only update every 10s
      const cooldownPassed = now - busEval.lastEvaluations >= 5 * 60 * 1000;
      if (cooldownPassed) {
        // Push path update
        busEval.path.push({
          lat: data.latitude,
          lon: data.longitude,
        });

        busEval.lastEvaluations = now;

        console.log("✅ Path updated after cooldown");
      }
    } catch (err) {
      console.error("🚨 Error in busLocationUpdate handler:", err);
    }
  });

  socket.on("stopStreaming", ({ busId }) => {
    administratorIds.forEach((id) => {
      io.to(id).emit("deleteStream", busId);
    });

    if (administratorConnectionsBus[busId]) {
      administratorConnectionsBus[busId].forEach((id) => {
        io.to(id).emit("deleteStream", busId);
      });
    }

    if (peers[busId]) {
      delete peers[busId];
      console.log(`🧹 Cleaned peers for ${busId}`);
    }

    console.log(`📡 stopStreaming received for bus: ${busId}`);
  });

  // Send Notifcation
  socket.on(
    "sendNotificiation",
    async ({ stopId, status, busId, distance }, callback) => {
      try {
        console.log("📥 Received sendNotificiation event:", {
          stopId,
          status,
          busId,
          distance,
        });

        const activeTokens = await FCM.find({
          stopId,
          isActive: true,
        })
          .select("fcmToken stop stopId busId")
          .populate("busId", "busNumber route");

        console.log("📡 Fetched activeTokens:", activeTokens.length);

        // ✅ Special logic only for 'arrived'
        if (status === "arrived") {
          console.log(
            "🟢 Status is 'arrived' — calling logStopArrivalToMemory"
          );
          logStopArrivalToMemory({ busId, stopId });
        } else {
          console.log("ℹ️ Not an 'arrived' status — skipping memory log");
        }

        if (!activeTokens.length) {
          console.log("🟡 No active tokens found for stopId:", stopId);
          return callback(true);
        }

        const title = "Bus Stop Update";

        const statusMessages = {
          arriving: "The bus is arriving shortly at your stop.",
          arrived: "The bus has just arrived at your stop.",
          departing: "The bus will be departing from your stop soon.",
          departed: "The bus has departed from your stop.",
        };

        const formalMessage =
          statusMessages[status] || `New status at your stop: ${status}`;

        for (const entry of activeTokens) {
          const stopName = entry.stop?.stopName || "your stop";
          const busNumber = entry.busId?.busNumber || "Unknown Bus";
          let message = `🚌 Bus ${busNumber} update at "${stopName}": ${formalMessage}`;

          if (typeof distance !== "undefined") {
            const meters = Math.round(distance);
            message += ` (Distance: ~${meters} meters)`;
          }

          console.log("📲 Sending push notification:", {
            to: entry.fcmToken,
            message,
          });

          await sendNotificationToClient(entry.fcmToken, title, message);
        }

        callback(true);
      } catch (err) {
        console.error("🚨 Error while sending notification:", err);
        callback(false);
      }
    }
  );

  // Campus Notification
  socket.on("campusEvent", async ({ campus, event, busId }, callback) => {
    try {
      if (!campus || !event || !busId) {
        return callback(false); // 🔴 Invalid request
      }

      // 1. Fetch active tokens for this busId
      const activeTokens = await FCM.find({
        busId,
        isActive: true,
      })
        .select("fcmToken stop stopName busId")
        .populate("busId", "busNumber");

      // ✅ 4. Update in-memory eventTimeline
      const timeString = moment().tz("Asia/Kolkata").format("hh:mm A");

      lastEvaluated[busId]?.eventTimeline?.push({
        campus,
        eventType: event,
        time: timeString,
      });

      if (adminConnectionsBus[busId]) {
        adminConnectionsBus[busId].forEach((socketId) => {
          io.to(socketId).emit("busUpdate", {
            busObject: lastEvaluated[busId],
          });
        });
      }

      console.log(
        `📌 Event logged: ${event} ${campus} @ ${timeString} for bus ${busId}`
      );

      if (!activeTokens.length) {
        return callback(true); // ✅ No tokens to notify, but not an error
      }

      // 2. Build message
      const title = "Campus Update";
      const busNumber = activeTokens[0]?.busId?.busNumber || "Bus";

      const statusMessages = {
        Entered: `🚌 ${busNumber} has entered ${campus}`,
        Exited: `🚌 ${busNumber} has exited ${campus}`,
      };

      const message =
        statusMessages[event] || `Bus status update for ${campus}`;

      // 3. Send push notification
      for (const entry of activeTokens) {
        await sendNotificationToClient(entry.fcmToken, title, message);
      }

      callback(true); // ✅ Completed successfully
    } catch (err) {
      console.error("🚨 Error in campusEvent handler:", err);
      callback(false);
    }
  });

  //  Generatting Speed Alert

  socket.on("overSpeedAlert", async ({ busId, message }) => {
    console.log(message);

    const bus = await Bus.findById(busId)
      .select("busNumber route _id")
      .populate("driver", "name phone")
      .populate("conductor", "name phone");

    if (!bus) return;

    const admins = await CORE.find({
      role: { $in: ["admin", "administrator"] },
      isLogged: true,
      notificationToken: { $exists: true, $ne: "" },
    });

    const route = bus.route || "N/A";
    const busNumber = bus.busNumber || "Unknown";

    // Safely get driver and conductor details
    const driverInfo =
      bus.driver?.name && bus.driver?.phone
        ? `Driver: ${bus.driver.name} (${bus.driver.phone})`
        : null;

    const conductorInfo =
      bus.conductor?.name && bus.conductor?.phone
        ? `Conductor: ${bus.conductor.name} (${bus.conductor.phone})`
        : null;

    const additionalInfo = [conductorInfo, driverInfo]
      .filter(Boolean)
      .join("\n");

    for (const admin of admins) {
      if (additionalInfo) {
        message += `\n\n${additionalInfo}`;
      }
      sendNotificationToClient(admin.notificationToken, "Speed Alert", message);
    }
  });

  socket.on("streamNotification", async ({ busId, about }) => {
    try {
      const bus = await Bus.findById(busId)
        .select("busNumber route _id")
        .populate("driver", "name phone")
        .populate("conductor", "name phone");

      if (!bus) return;

      const admins = await CORE.find({
        role: { $in: ["admin", "administrator"] },
        isLogged: true,
        notificationToken: { $exists: true, $ne: "" },
      });

      const route = bus.route || "N/A";
      const busNumber = bus.busNumber || "Unknown";

      // Safely get driver and conductor details
      const driverInfo =
        bus.driver?.name && bus.driver?.phone
          ? `Driver: ${bus.driver.name} (${bus.driver.phone})`
          : null;

      const conductorInfo =
        bus.conductor?.name && bus.conductor?.phone
          ? `Conductor: ${bus.conductor.name} (${bus.conductor.phone})`
          : null;

      const additionalInfo = [conductorInfo, driverInfo]
        .filter(Boolean)
        .join("\n");

      for (const admin of admins) {
        const title = "📡 Live Stream Alert";
        let message = `Bus number ${busNumber} on route "${route}" has ${about} live streaming.`;

        if (additionalInfo) {
          message += `\n\n${additionalInfo}`;
        }

        if (admin.role === "admin") {
          message += `\n\nPlease confirm the situation and take necessary actions.`;
        } else {
          message += `\n\nAs an administrator, please monitor the stream.`;
        }

        sendNotificationToClient(admin.notificationToken, title, message);
      }
    } catch (err) {
      console.error("Error sending stream notification:", err);
    }
  });

  socket.on("disconnect", async () => {
    console.log(`🔌 Disconnection: ${socket.id}`);

    // 🟠 Viewer (public viewer)
    if (socket.busId) {
      const busId = socket.busId;
      removeSocketFromMap(busConnections, busId, socket.id, "Viewer");
    }

    // 🔵 Admin (per-bus)
    if (socket.bus && socket.adminId) {
      const busId = socket.bus;
      removeSocketFromMap(adminConnectionsBus, busId, socket.id, "Admin (bus)");
    }

    // 🟣 Administrator (per-bus)
    if (socket.bus && socket.administratorId) {
      const busId = socket.bus;

      removeSocketFromMap(
        administratorConnectionsBus,
        busId,
        socket.id,
        "Administrator (bus)"
      );
    }

    // 🔴 Admin (global)
    if (socket.adminId && allAdmins.includes(socket.id)) {
      allAdmins = allAdmins.filter((id) => id !== socket.id);
      console.log(`❌ Removed global admin: ${socket.id}`);
    }

    // 🟢 Administrator (global)
    if (socket.administratorId && administratorIds.includes(socket.id)) {
      administratorIds = administratorIds.filter((id) => id !== socket.id);
      console.log(`❌ Removed global administrator: ${socket.id}`);
    }

    // 🚌 Live Bus (driver/conductor)
    if (socket.liveBusId) {
      const busId = socket.liveBusId;
      cooldowns.set(busId, Date.now());

      const index = liveBuses.indexOf(busId);
      if (index !== -1) {
        liveBuses.splice(index, 1);
        console.log(`🚫 Bus ${busId} went offline.`);

        allAdmins.forEach((id) => io.to(id).emit("remove", busId));
      }

      // Inform all administrators to delete stream
      administratorIds.forEach((id) => {
        io.to(id).emit("deleteStream", busId);
      });

      if (administratorConnectionsBus[busId]) {
        administratorConnectionsBus[busId].forEach((id) => {
          io.to(id).emit("deleteStream", busId);
        });
      }

      // Clean up peer-related data
      if (peers[busId]) {
        delete peers[busId];
        console.log(`🧹 Cleaned peers for ${busId}`);
      }

      if (lastEvaluated[busId]) {
        await saveLogs(lastEvaluated[busId]); // async-safe
      }
    }
  });
});

const startServer = async () => {
  try {
    await ConnectDB(
      "mongodb+srv://educole:educole1234@educole.2cvrvth.mongodb.net/shikharDB?retryWrites=true&w=majority&appName=Educole"
    );
    const existingAdministrator = await CORE.findOne({ role: "administrator" });
    if (!existingAdministrator) {
      await CORE.create({
        username: "shikhar",
        password: "shikhar123", // you should hash this in real-world apps!
        role: "administrator",

        administratorId: "ADMTR-1234",
        isLogged: false,
        notificationToken: "",
      });
      console.log("🧑‍💼 Admin user created in CORE collection.");
    } else {
      console.log("✅ Admin user already exists.");
    }

    console.log("✅ MongoDB connected successfully.");

    await setAllRouteStops();
    console.log("✅ All routeStops loaded into memory.");

    const timeInIST = moment().tz("Asia/Kolkata").format("YYYY-MM-DD HH:mm:ss");
    console.log("🕐 Time in IST:", timeInIST);

    server.listen(PORT, () => {
      console.log(`🚀 Server is running and listening at port ${PORT}`);
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err);
  }
};

startServer();
