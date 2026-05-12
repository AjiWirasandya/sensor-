require("dotenv").config();

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const ExcelJS = require("exceljs");

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

function describeError(error) {
  if (!error) return "Unknown error";

  const details = {
    name: error.name,
    message: error.message,
    stack: error.stack
  };

  if (Array.isArray(error.errors) && error.errors.length > 0) {
    details.errors = error.errors.map((nestedError) => ({
      name: nestedError?.name,
      message: nestedError?.message,
      code: nestedError?.code,
      errno: nestedError?.errno,
      syscall: nestedError?.syscall,
      address: nestedError?.address,
      port: nestedError?.port
    }));
  }

  return details;
}

function formatJakartaTimestamp(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
}

function pivotHistoryRows(rows) {
  const byPoint = new Map();

  rows.forEach((row) => {
    const pointKey = `${row.time}|${row.device || "unknown"}`;
    if (!byPoint.has(pointKey)) {
      byPoint.set(pointKey, {
        time: row.time,
        device: row.device || "unknown",
        temperature: null,
        humidity: null,
        light: null,
        sound: null,
        pressure: null
      });
    }

    const point = byPoint.get(pointKey);
    if (Object.prototype.hasOwnProperty.call(point, row.field)) {
      point[row.field] = row.value;
    }
  });

  return Array.from(byPoint.values()).sort((left, right) => {
    return new Date(left.time).getTime() - new Date(right.time).getTime();
  });
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
    console.error("[API] /api/influx-info error:", describeError(error));
    res.status(500).json({ error: error.message, details: describeError(error) });
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
    console.log(`[/api/history] Request: minutes=${minutes} room=${room}`);
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

    const allPoints = Object.values(history).flat();
    if (allPoints.length > 0) {
      const times = allPoints.map(p => new Date(p.x).getTime()).sort((a, b) => a - b);
      const earliest = new Date(times[0]);
      const latest = new Date(times[times.length - 1]);
      console.log(`[/api/history] Response: ${allPoints.length} total points, earliest=${earliest.toISOString()} latest=${latest.toISOString()}`);
    } else {
      console.log(`[/api/history] Response: 0 points returned`);
    }

    res.json({
      rangeMinutes: Number(minutes),
      points: history
    });
  } catch (error) {
    console.error("[API] /api/history error:", describeError(error));
    res.status(500).json({
      error: "Failed to query history from InfluxDB",
      details: describeError(error)
    });
  }
});

app.get("/api/export/excel", async (req, res) => {
  try {
    if (!influx?.queryApi) {
      return res.status(503).json({
        error: "InfluxDB is not configured. Check INFLUX_URL, INFLUX_TOKEN, INFLUX_ORG, INFLUX_BUCKET."
      });
    }

    const minutes = Number(req.query.minutes || 60);
    const roomQuery = String(req.query.room || "").trim();
    const targetRooms = roomQuery ? [roomQuery] : ROOMS;

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "sensor-dashboard";
    workbook.created = new Date();

    for (const roomId of targetRooms) {
      const rows = await queryHistory(influx.queryApi, minutes, roomId);
      const points = pivotHistoryRows(rows);
      const sheet = workbook.addWorksheet(roomId.slice(0, 31));

      sheet.columns = [
        { header: "Waktu", key: "time", width: 22 },
        { header: "Device", key: "device", width: 14 },
        { header: "Temperature", key: "temperature", width: 14 },
        { header: "Humidity", key: "humidity", width: 14 },
        { header: "Light", key: "light", width: 12 },
        { header: "Sound", key: "sound", width: 12 },
        { header: "Pressure", key: "pressure", width: 14 }
      ];

      if (points.length === 0) {
        sheet.addRow({
          time: "No data in selected range",
          device: "-",
          temperature: null,
          humidity: null,
          light: null,
          sound: null,
          pressure: null
        });
      } else {
        points.forEach((point) => {
          sheet.addRow({
            time: formatJakartaTimestamp(point.time),
            device: point.device,
            temperature: point.temperature,
            humidity: point.humidity,
            light: point.light,
            sound: point.sound,
            pressure: point.pressure
          });
        });
      }

      sheet.getRow(1).font = { bold: true };
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `sensor_history_${minutes}m_${timestamp}.xlsx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const buffer = await workbook.xlsx.writeBuffer();
    res.send(Buffer.from(buffer));
  } catch (error) {
    console.error("[API] /api/export/excel error:", describeError(error));
    res.status(500).json({ error: "Failed to export Excel", details: describeError(error) });
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
