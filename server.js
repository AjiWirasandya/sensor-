require("dotenv").config();

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const { SENSOR_KEYS, normalizePayload } = require("./src/sensorModel");
const { connectMqtt } = require("./src/mqttClient");
const {
  isInfluxConfigured,
  getInflux,
  writeSensorData,
  flushWrites,
  queryHistory,
  queryMeasurements,
  queryFieldsAndTags
} = require("./src/influxClient");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT || 3000);
const WRITE_TO_INFLUX = String(process.env.WRITE_TO_INFLUX || "false").toLowerCase() === "true";
const ROOMS = ["ruang1", "ruang2"];

function emptySensorState(room) {
  return {
    room,
    temperature: null,
    humidity: null,
    light: null,
    sound: null,
    pressure: null,
    device: room,
    timestamp: null
  };
}

let latestByRoom = Object.fromEntries(ROOMS.map((room) => [room, emptySensorState(room)]));

const influx = getInflux();
if (!isInfluxConfigured()) {
  console.warn("[InfluxDB] Not fully configured. Historical queries will be unavailable.");
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/latest", (req, res) => {
  const room = String(req.query.room || "").trim();

  if (room) {
    return res.json(latestByRoom[room] || emptySensorState(room));
  }

  res.json({ rooms: latestByRoom });
});

app.get("/api/rooms", (req, res) => {
  res.json({ rooms: ROOMS });
});

app.get("/api/influx-info", async (req, res) => {
  try {
    if (!influx?.queryApi) {
      return res.status(503).json({
        error: "InfluxDB not configured",
        config: {
          url: process.env.INFLUX_URL || "not set",
          org: process.env.INFLUX_ORG || "not set",
          bucket: process.env.INFLUX_BUCKET || "not set",
          measurement: process.env.INFLUX_MEASUREMENT || "not set"
        }
      });
    }

    const measurements = await queryMeasurements(influx.queryApi);
    const info = {
      config: {
        url: process.env.INFLUX_URL,
        org: process.env.INFLUX_ORG,
        bucket: process.env.INFLUX_BUCKET,
        measurement: process.env.INFLUX_MEASUREMENT
      },
      measurements: measurements,
      details: {}
    };

    if (measurements.length > 0) {
      for (const meas of measurements) {
        const schema = await queryFieldsAndTags(influx.queryApi, meas);
        info.details[meas] = schema;
      }
    }

    res.json(info);
  } catch (error) {
    console.error("[API] /api/influx-info error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/history", async (req, res) => {
  try {
    if (!influx?.queryApi) {
      return res.status(503).json({
        error: "InfluxDB is not configured. Check INFLUX_URL, INFLUX_TOKEN, INFLUX_ORG, INFLUX_BUCKET."
      });
    }

    const minutes = req.query.minutes || 60;
    const room = String(req.query.room || "").trim() || null;
    const rows = await queryHistory(influx.queryApi, minutes, room);

    const history = {
      temperature: [],
      humidity: [],
      light: [],
      sound: [],
      pressure: []
    };

    rows.forEach((row) => {
      if (!history[row.field]) return;
      history[row.field].push({ x: row.time, y: row.value, device: row.device });
    });

    Object.values(history).forEach((points) => {
      points.sort((left, right) => new Date(left.x).getTime() - new Date(right.x).getTime());
    });

    res.json({
      rangeMinutes: Number(minutes),
      points: history
    });
  } catch (error) {
    console.error("[API] /api/history error:", error.message);
    res.status(500).json({ error: "Failed to query history from InfluxDB" });
  }
});

io.on("connection", (socket) => {
  socket.emit("sensor:batch", latestByRoom);
});

connectMqtt(async (topic, payloadText) => {
  try {
    const payload = normalizePayload(payloadText, topic);
    const room = payload.room || "unknown";

    if (!ROOMS.includes(room)) {
      console.warn(`[MQTT] Ignoring payload for unsupported room: ${room} | topic=${topic}`);
      return;
    }

    latestByRoom[room] = payload;

    io.emit("sensor:update", payload);

    if (WRITE_TO_INFLUX && influx?.writeApi) {
      await writeSensorData(influx.writeApi, payload);
      await flushWrites(influx.writeApi);
    }
  } catch (error) {
    const preview = String(payloadText).slice(0, 180);
    console.error("[MQTT] Invalid payload:", error.message, `| topic=${topic} | payload=${preview}`);
  }
});

process.on("SIGINT", async () => {
  if (influx?.writeApi) {
    try {
      await influx.writeApi.close();
    } catch (error) {
      console.error("[InfluxDB] Failed closing write API:", error.message);
    }
  }
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`Dashboard running on http://localhost:${PORT}`);
  console.log(`Expected MQTT payload keys: ${SENSOR_KEYS.join(", ")}`);
  console.log(`Dashboard rooms: ${ROOMS.join(", ")}`);
});
