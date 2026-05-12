const { InfluxDB, Point } = require("@influxdata/influxdb-client");
const util = require("util");

const influxConfig = {
  url: process.env.INFLUX_URL,
  token: process.env.INFLUX_TOKEN,
  org: process.env.INFLUX_ORG,
  bucket: process.env.INFLUX_BUCKET,
  measurement: process.env.INFLUX_MEASUREMENT || "sensor_data"
};

function isInfluxConfigured() {
  return Boolean(influxConfig.url && influxConfig.token && influxConfig.org && influxConfig.bucket);
}

function getInflux() {
  if (!isInfluxConfigured()) return null;
  const influxDB = new InfluxDB({ url: influxConfig.url, token: influxConfig.token });

  return {
    queryApi: influxDB.getQueryApi(influxConfig.org),
    writeApi: influxDB.getWriteApi(influxConfig.org, influxConfig.bucket, "ns")
  };
}

async function writeSensorData(writeApi, payload) {
  if (!writeApi) return;

  const point = new Point(influxConfig.measurement)
    .tag("room", payload.room || payload.device || "unknown")
    .tag("device", payload.device || "esp32")
    .timestamp(new Date(payload.timestamp));

  if (payload.temperature !== null) point.floatField("temperature", payload.temperature);
  if (payload.humidity !== null) point.floatField("humidity", payload.humidity);
  if (payload.light !== null) point.floatField("light", payload.light);
  if (payload.sound !== null) point.floatField("sound", payload.sound);
  if (payload.pressure !== null) point.floatField("pressure", payload.pressure);

  writeApi.writePoint(point);
}

async function flushWrites(writeApi) {
  if (!writeApi) return;
  await writeApi.flush();
}

async function queryHistory(queryApi, minutes = 60, room = null) {
  if (!queryApi) return [];

  const MAX_MINUTES = 30 * 24 * 60; // allow up to 30 days
  const safeMinutes = Math.max(1, Math.min(Number(minutes) || 60, MAX_MINUTES));
  const roomFilter = room ? `  |> filter(fn: (r) => r.room == "${room}")\n` : "";

  // Pivot so the sensor fields are in the same record and keep room/device tags
  const flux = `
from(bucket: "${influxConfig.bucket}")
  |> range(start: -${safeMinutes}m)
  |> filter(fn: (r) => r._measurement == "${influxConfig.measurement}")
${roomFilter}  |> filter(fn: (r) => r._field == "temperature" or r._field == "humidity" or r._field == "light" or r._field == "sound" or r._field == "pressure")
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> sort(columns: ["_time"], desc: false)
`;

  console.debug(`[queryHistory] minutes=${minutes} safeMinutes=${safeMinutes} room=${room}`);

  const rows = [];
  await new Promise((resolve, reject) => {
    queryApi.queryRows(flux, {
      next(row, tableMeta) {
        const o = tableMeta.toObject(row);
        const device = o.device || o.deviceId || room || "unknown";

        // Create rows for each sensor field
        const fields = ["temperature", "humidity", "light", "sound", "pressure"];
        fields.forEach((field) => {
          if (o[field] !== null && o[field] !== undefined) {
            rows.push({
              time: o._time,
              field: field,
              value: Number(o[field]),
              device: device,
              room: o.room || room || "unknown"
            });
          }
        });
      },
      error(error) {
        console.error(`[queryHistory] queryRows error for room=${room}:`, util.inspect(error, { depth: 5, breakLength: 120 }));
        reject(error);
      },
      complete() {
        console.debug(`[queryHistory] returned ${rows.length} total rows for room=${room}`);
        resolve();
      }
    });
  });
  return rows;
}

async function queryMeasurements(queryApi) {
  if (!queryApi) return [];
  const flux = `from(bucket: "${influxConfig.bucket}") |> range(start: -24h) |> keep(columns: ["_measurement"]) |> limit(n: 1000)`;
  const measurements = new Set();
  await new Promise((resolve) => {
    queryApi.queryRows(flux, {
      next(row, tableMeta) {
        const o = tableMeta.toObject(row);
        if (o._measurement) measurements.add(o._measurement);
      },
      error() { resolve(); },
      complete() { resolve(); }
    });
  });
  return Array.from(measurements);
}

async function queryFieldsAndTags(queryApi, measurement) {
  if (!queryApi || !measurement) return { fields: [], tags: [] };
  const flux = `from(bucket: "${influxConfig.bucket}") |> range(start: -24h) |> filter(fn: (r) => r._measurement == "${measurement}") |> keep(columns: ["_field"]) |> limit(n: 1000)`;
  
  const fields = new Set();
  const tags = new Set();
  
  await new Promise((resolve) => {
    queryApi.queryRows(flux, {
      next(row, tableMeta) {
        const o = tableMeta.toObject(row);
        if (o._field) fields.add(o._field);
      },
      error() { resolve(); },
      complete() { resolve(); }
    });
  });

  return { fields: Array.from(fields), tags: Array.from(tags) };
}

module.exports = {
  influxConfig,
  isInfluxConfigured,
  getInflux,
  writeSensorData,
  flushWrites,
  queryHistory,
  queryMeasurements,
  queryFieldsAndTags
};
