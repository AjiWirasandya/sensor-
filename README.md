# Sensor Dashboard (MQTT + InfluxDB)

A web dashboard for visualizing sensor data (temperature, humidity, light, sound, pressure) with:
- real-time updates from MQTT
- historical charts from InfluxDB

## 1) Prerequisites

- Node.js 18+
- Existing MQTT broker
- Existing InfluxDB v2 instance (or create one)

## 2) Install and Configure

```bash
npm installs
copy .env.example .env
```

Then edit `.env`:

```env
PORT=3000

MQTT_BROKER_URL=mqtts://3760508db6d94049a0c34bebed091b74.s1.eu.hivemq.cloud:8883
MQTT_TOPIC=katd/+/data
MQTT_USERNAME=Robilana
MQTT_PASSWORD=RoBiLaNa619
MQTT_CLIENT_ID=katd-dashboard-ruang2

INFLUX_URL=http://localhost:8086
INFLUX_TOKEN=replace_with_your_influx_token
INFLUX_ORG=replace_with_your_org
INFLUX_BUCKET=replace_with_your_bucket
INFLUX_MEASUREMENT=sensor_data

WRITE_TO_INFLUX=false
```

## 3) Data Format from MQTT

The dashboard expects JSON payloads like this:

```json
{
  "temperature": 27.5,
  "humidity": 70.2,
  "light": 352,
  "sound": 40.8,
  "pressure": 1007.1,
  "device": "esp32-01",
  "timestamp": "2026-04-02T10:15:30Z"
}
```

Supported aliases:
- `temp` -> `temperature`
- `hum` -> `humidity`
- `lux` -> `light`
- `noise` -> `sound`
- `pres` -> `pressure`

The dashboard now listens to `katd/+/data`, so it can show both `ruang1` and `ruang2` separately as long as each device publishes to its own topic like `katd/ruang1/data` and `katd/ruang2/data`.

## 4) Run

```bash
npm run dev
```

Open: `http://localhost:3000`

## 5) MQTT + InfluxDB Connection Flow

Your current pipeline can remain the same:
1. ESP32 publishes telemetry to MQTT topic.
2. Your existing subscriber writes data to InfluxDB.
3. This dashboard subscribes MQTT for live UI and queries InfluxDB for history.

For your sketch specifically:
- Broker: HiveMQ Cloud at `3760508db6d94049a0c34bebed091b74.s1.eu.hivemq.cloud:8883`
- Topic pattern: `katd/+/data`
- Ruang 2 device topic: `katd/ruang2/data`
- Ruang 1 device topic: `katd/ruang1/data`
- Username: `Robilana`
- Password: `RoBiLaNa619`

If you want this dashboard app to also write MQTT data to InfluxDB, set:

```env
WRITE_TO_INFLUX=true
```

## 6) InfluxDB Setup (if needed)

In InfluxDB v2:
1. Create Organization.
2. Create Bucket named `sensors` (or your preferred bucket).
3. Create an API token with read access (and write access if `WRITE_TO_INFLUX=true`).
4. Set `INFLUX_URL`, `INFLUX_ORG`, `INFLUX_BUCKET`, `INFLUX_TOKEN` in `.env`.

Measurement used by default: `sensor_data`.
Fields used: `temperature`, `humidity`, `light`, `sound`, `pressure`.

## 7) Troubleshooting

- `503 InfluxDB is not configured`: check `INFLUX_*` variables.
- Live cards update but charts empty: data may be in a different measurement or field names in InfluxDB.
- No live updates: verify topic in `MQTT_TOPIC` and payload is valid JSON.
