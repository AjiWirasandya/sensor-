const mqtt = require("mqtt");

function connectMqtt(onMessage) {
  const client = mqtt.connect(process.env.MQTT_BROKER_URL || "mqtt://localhost:1883", {
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    clientId: process.env.MQTT_CLIENT_ID || `dashboard-${Math.random().toString(16).slice(2)}`,
    reconnectPeriod: 2000
  });

  const topicList = (process.env.MQTT_TOPICS || process.env.MQTT_TOPIC || "katd/+/data")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  client.on("connect", () => {
    console.log(`[MQTT] Connected. Subscribing to topic(s): ${topicList.join(", ")}`);
    topicList.forEach((topic) => {
      client.subscribe(topic, (err) => {
        if (err) {
          console.error("[MQTT] Subscribe failed:", err.message);
        }
      });
    });
  });

  client.on("message", (incomingTopic, message) => {
    onMessage(incomingTopic, message.toString("utf8"));
  });

  client.on("reconnect", () => console.log("[MQTT] Reconnecting..."));
  client.on("error", (err) => {
    const details = err?.message || err?.code || JSON.stringify(err);
    console.error("[MQTT] Error:", details);
  });

  return client;
}

module.exports = {
  connectMqtt
};
