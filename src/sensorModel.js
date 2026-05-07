const SENSOR_KEYS = ["temperature", "humidity", "light", "sound", "pressure"];

function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function roomFromTopic(topic) {
  const match = String(topic || "").match(/katd\/([^/]+)\/data/i);
  return match?.[1] || null;
}

function parsePayload(rawInput) {
  if (typeof rawInput !== "string") return rawInput;

  try {
    return JSON.parse(rawInput);
  } catch (_error) {
    // Repair malformed device field from embedded builders:
    // {"device":ruang2,"temp":...} -> {"device":"ruang2","temp":...}
    const repaired = rawInput.replace(/"device"\s*:\s*([a-zA-Z0-9_-]+)([,}])/i, '"device":"$1"$2');
    return JSON.parse(repaired);
  }
}

function normalizeTimestamp(payload) {
  const receivedAt = new Date().toISOString();
  const rawTimestamp = payload.timestamp ?? payload.ts;

  if (rawTimestamp === null || rawTimestamp === undefined || rawTimestamp === "") {
    return { timestamp: receivedAt, sensorTime: null };
  }

  if (typeof rawTimestamp === "number" && Number.isFinite(rawTimestamp)) {
    // Treat very large numeric values as real epoch timestamps.
    if (rawTimestamp >= 1e12) {
      return { timestamp: new Date(rawTimestamp).toISOString(), sensorTime: rawTimestamp };
    }

    // Smaller numeric values are usually uptime / device-relative seconds.
    return { timestamp: receivedAt, sensorTime: rawTimestamp };
  }

  const parsed = new Date(rawTimestamp);
  if (!Number.isNaN(parsed.getTime())) {
    return { timestamp: parsed.toISOString(), sensorTime: rawTimestamp };
  }

  return { timestamp: receivedAt, sensorTime: rawTimestamp };
}

function normalizePayload(input, topic = "") {
  const payload = parsePayload(input);
  const room = roomFromTopic(topic) ?? payload.room ?? payload.deviceId ?? "unknown";
  const device = payload.device ?? payload.deviceId ?? payload.room ?? room;
  const { timestamp, sensorTime } = normalizeTimestamp(payload);

  return {
    temperature: asNumber(payload.temperature ?? payload.temp),
    humidity: asNumber(payload.humidity ?? payload.hum),
    light: asNumber(payload.light ?? payload.lux),
    sound: asNumber(payload.sound ?? payload.noise),
    pressure: asNumber(payload.pressure ?? payload.pres),
    room,
    device,
    timestamp,
    sensorTime
  };
}

module.exports = {
  SENSOR_KEYS,
  normalizePayload,
  roomFromTopic
};
