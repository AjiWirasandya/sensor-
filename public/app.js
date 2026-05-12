const ROOMS = [
  { id: "ruang1", label: "Ruang 1" },
  { id: "ruang2", label: "Ruang 2" }
];

const METRICS = [
  { key: "temperature", label: "Temperature", unit: "°C", color: "#007f5f" },
  { key: "humidity", label: "Humidity", unit: "%", color: "#3a86ff" },
  { key: "light", label: "Light", unit: "lx", color: "#ffb703" },
  { key: "sound", label: "Sound", unit: "dB", color: "#e76f51" },
  { key: "pressure", label: "Pressure", unit: "hPa", color: "#6d597a" }
];

// Register the zoom plugin if available (guard to avoid script-breaking errors)
try {
  if (typeof ChartZoom !== 'undefined' && Chart && typeof Chart.register === 'function') {
    Chart.register(ChartZoom);
  } else {
    console.warn('ChartZoom plugin not available; zoom/pan disabled.');
  }
} catch (err) {
  console.warn('Failed to register ChartZoom plugin:', err.message);
}

const socket = io();
const roomGrid = document.getElementById("roomGrid");
const rangeMinutesEl = document.getElementById("rangeMinutes");
const refreshBtn = document.getElementById("refreshBtn");
const resetZoomBtn = document.getElementById("resetZoomBtn");
const chartTypeEl = document.getElementById("chartType");
const autoRefreshEl = document.getElementById("autoRefresh");

let HISTORY_REFRESH_MS = 5000;
let currentChartType = "line";
let autoRefreshEnabled = true;
let autoRefreshInterval = null;

const roomState = Object.fromEntries(
  ROOMS.map((room) => [room.id, { 
    latest: null, 
    charts: {},
    realtimeBuffer: {} 
  }])
);

// Initialize realtime buffer
ROOMS.forEach(room => {
  METRICS.forEach(metric => {
    roomState[room.id].realtimeBuffer[metric.key] = [];
  });
});

function formatValue(metricKey, value) {
  if (value === null || value === undefined) return "--";
  const precision = metricKey === "pressure" ? 3 : 2;
  return Number(value).toFixed(precision);
}

function formatChartLabel(timestampLike, minutesRange) {
  const d = new Date(timestampLike);
  if (Number.isNaN(d.getTime())) return "";

  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');

  if (minutesRange < 1) return `${hh}:${min}:${ss}`;
  if (minutesRange < 60) return `${hh}:${min}:${ss}`;
  if (minutesRange < 24 * 60) return `${hh}:${min}`;
  if (minutesRange < 7 * 24 * 60) return `${dd}/${mm} ${hh}:${min}`;
  return `${dd}/${mm}/${yyyy}`;
}

function createRoomCard(room) {
  const section = document.createElement("section");
  section.className = "card room-card";
  section.innerHTML = `
    <div class="room-header">
      <div>
        <p class="eyebrow">${room.label}</p>
        <h2 class="room-title">${room.label} Dashboard</h2>
      </div>
      <p class="room-status" id="status-${room.id}">Waiting data...</p>
    </div>
    <div class="room-section">
      <div class="room-metrics" id="metrics-${room.id}"></div>
      <div class="room-charts">
        ${METRICS.map(metric => `
          <article class="card chart-card">
            <p class="chart-title">${metric.label} (${metric.unit})</p>
            <div class="chart-container" id="container-${room.id}-${metric.key}">
              <canvas id="chart-${room.id}-${metric.key}"></canvas>
            </div>
          </article>
        `).join('')}
      </div>
    </div>
  `;

  const metricsGrid = section.querySelector(`#metrics-${room.id}`);
  METRICS.forEach((metric) => {
    const div = document.createElement("article");
    div.className = "card metric";
    div.innerHTML = `
      <h3>${metric.label}</h3>
      <div class="value" id="value-${room.id}-${metric.key}">--</div>
      <div class="meta" id="meta-${room.id}-${metric.key}">Waiting data...</div>
    `;
    metricsGrid.appendChild(div);
  });

  roomGrid.appendChild(section);
}

function setCardValues(roomId, payload) {
  METRICS.forEach((metric) => {
    const valueEl = document.getElementById(`value-${roomId}-${metric.key}`);
    const metaEl = document.getElementById(`meta-${roomId}-${metric.key}`);
    if (!valueEl || !metaEl) return;

    valueEl.textContent = `${formatValue(metric.key, payload[metric.key])} ${metric.unit}`;
    metaEl.textContent = "";
  });

  const statusEl = document.getElementById(`status-${roomId}`);
  if (statusEl) {
    const stamp = payload.timestamp ? new Date(payload.timestamp).toLocaleTimeString() : "--";
    statusEl.textContent = `Last update ${stamp}`;
  }
}

function getChartOptions(metric) {
  const isPressure = metric.key === "pressure";
  const baseOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: {
      duration: 300,
      easing: 'easeInOutQuart'
    },
    interaction: {
      mode: 'index',
      intersect: false,
    },
    plugins: {
      legend: { 
        display: true,
        position: 'top'
      },
      tooltip: {
        backgroundColor: 'rgba(0, 0, 0, 0.8)',
        padding: 12,
        titleColor: '#fff',
        bodyColor: '#fff',
        borderColor: metric.color,
        borderWidth: 1,
        cornerRadius: 4,
        displayColors: true,
        callbacks: {
          label: function(context) {
            return `${context.dataset.label}: ${Number(context.parsed.y).toFixed(2)}`;
          }
        }
      },
      zoom: {
        pan: {
          enabled: true,
          mode: 'x',
          modifierKey: 'ctrl',
          onPan: function() {
            resetZoomBtn.style.display = 'inline-block';
          }
        },
        zoom: {
          wheel: {
            enabled: true,
            speed: 0.1,
            modifierKey: 'shift'
          },
          pinch: {
            enabled: true
          },
          mode: 'x',
          onZoom: function() {
            resetZoomBtn.style.display = 'inline-block';
          }
        }
      }
    },
    scales: {
      x: {
        ticks: {
          maxTicksLimit: 6,
          maxRotation: 45,
          minRotation: 0,
          autoSkip: true
        }
      },
      y: {
        ticks: {
          maxTicksLimit: 6
        }
      }
    }
  };

  if (isPressure) {
    baseOptions.scales.y.ticks.precision = 1;
  }

  return baseOptions;
}

function createCharts(roomId) {
  METRICS.forEach((metric) => {
    const canvas = document.getElementById(`chart-${roomId}-${metric.key}`);
    if (!canvas) {
      roomState[roomId].charts[metric.key] = null;
      return;
    }
    const ctx = canvas.getContext && canvas.getContext("2d");
    if (!ctx || typeof Chart === 'undefined') {
      roomState[roomId].charts[metric.key] = null;
      return;
    }
    const isPressure = metric.key === "pressure";

    const chartType = currentChartType;

    const chartConfig = {
      type: chartType,
      data: {
        labels: [],
        datasets: [
          {
            label: `${metric.label}`,
            data: [],
            borderColor: metric.color,
            backgroundColor: (currentChartType === 'bar') ? `${metric.color}88` : `${metric.color}22`,
            tension: isPressure ? 0.35 : 0.55,
            fill: (currentChartType === 'line'),
            pointRadius: isPressure ? 2 : 3,
            pointHoverRadius: isPressure ? 4 : 5,
            pointBackgroundColor: metric.color,
            pointBorderColor: '#fff',
            pointBorderWidth: 2,
            borderWidth: 2,
            spanGaps: true,
            barPercentage: 0.7,
            categoryPercentage: 0.8
          }
        ]
      },
      options: getChartOptions(metric)
    };

    try {
      console.debug(`Creating chart ${roomId}/${metric.key}`);
      roomState[roomId].charts[metric.key] = new Chart(ctx, chartConfig);
      console.debug(`Chart created ${roomId}/${metric.key}`);
    } catch (err) {
      console.error(`Failed to create chart for ${roomId}/${metric.key}:`, err && err.message ? err.message : err);
      roomState[roomId].charts[metric.key] = null;
    }
  });
}

  

function updateChartType(newType) {
  currentChartType = newType;
  
  // Recreate all charts with new type
  ROOMS.forEach((room) => {
    METRICS.forEach((metric) => {
      const chart = roomState[room.id].charts[metric.key];
      if (!chart) return;
      
      chart.destroy();
    });
    createCharts(room.id);
  });

  // Reload the current history
  ROOMS.forEach((room) => loadHistory(room.id));
}

function addRealtimeData(roomId, payload) {
  const timestamp = new Date(payload.timestamp || Date.now());
  const minutesRange = Number(rangeMinutesEl.value || 0.5);
  const label = formatChartLabel(timestamp, minutesRange);
  
  METRICS.forEach((metric) => {
    if (payload[metric.key] === null || payload[metric.key] === undefined) return;
    
    roomState[roomId].realtimeBuffer[metric.key].push({
      label,
      value: payload[metric.key],
      timestamp: timestamp
    });

    // Keep only last 100 points in buffer
    if (roomState[roomId].realtimeBuffer[metric.key].length > 100) {
      roomState[roomId].realtimeBuffer[metric.key].shift();
    }

    // Update chart with realtime data
    const chart = roomState[roomId].charts[metric.key];
    if (!chart) return;

    const dataset = chart.data.datasets[0].data;
    const labels = chart.data.labels;
    labels.push(label);
    dataset.push(payload[metric.key]);

    // Keep only last 50 points visible for smooth scrolling
    if (dataset.length > 50) {
      dataset.shift();
      labels.shift();
    }

    try {
      chart.update('none'); // Update without animation for smooth real-time
    } catch (err) {
      console.error(`Realtime chart update failed for ${roomId}/${metric.key}:`, err && err.message ? err.message : err);
    }
  });
}

function createDashboard() {
  roomGrid.innerHTML = "";
  ROOMS.forEach((room) => {
    createRoomCard(room);
    createCharts(room.id);
  });
}

async function loadLatest() {
  const res = await fetch("/api/latest");
  if (!res.ok) return;
  const payload = await res.json();

  if (payload.rooms) {
    ROOMS.forEach((room) => {
      const latest = payload.rooms[room.id];
      if (!latest) return;
      roomState[room.id].latest = latest;
      setCardValues(room.id, latest);
    });
  }
}

async function loadHistory(roomId) {
  const minutes = Number(rangeMinutesEl.value || 0.5);
  const res = await fetch(`/api/history?minutes=${minutes}&room=${encodeURIComponent(roomId)}`);

  if (!res.ok) {
    console.warn(`Failed to load history for ${roomId}. Check InfluxDB config.`);
    return;
  }

  const data = await res.json();
  const minutesRange = Number(rangeMinutesEl.value || 0.5);

  METRICS.forEach((metric) => {
    const points = [...(data.points?.[metric.key] || [])].sort((left, right) => {
      return new Date(left.x).getTime() - new Date(right.x).getTime();
    });
    const chart = roomState[roomId].charts[metric.key];
    if (!chart) return;

    // Use category labels with proper timestamp formatting
    const labels = points.map((p) => formatChartLabel(p.x, minutesRange));
    const values = points.map((p) => Number(p.y));
    console.debug(`loadHistory ${roomId}/${metric.key} -> ${values.length} points`);
    chart.data.labels = labels;
    chart.data.datasets[0].data = values;

    // Auto-scale Y axis for pressure
    if (metric.key === "pressure") {
      const yValues = values.filter((v) => Number.isFinite(v));
      if (yValues.length > 0) {
        const min = Math.min(...yValues);
        const max = Math.max(...yValues);
        const range = max - min;
        const padding = Math.max(0.05, range * 0.35);
        chart.options.scales.y.min = min - padding;
        chart.options.scales.y.max = max + padding;
      } else {
        delete chart.options.scales.y.min;
        delete chart.options.scales.y.max;
      }
    } else {
      delete chart.options.scales.y.min;
      delete chart.options.scales.y.max;
    }

    // Reset zoom when loading new data (if plugin available)
    if (chart && typeof chart.resetZoom === 'function') chart.resetZoom();
    resetZoomBtn.style.display = 'none';

    // Adjust tick density to avoid clutter for long ranges
    if (chart.options && chart.options.scales && chart.options.scales.x && chart.options.scales.x.ticks) {
      if (minutesRange < 60) chart.options.scales.x.ticks.maxTicksLimit = 6;
      else if (minutesRange < 24 * 60) chart.options.scales.x.ticks.maxTicksLimit = 8;
      else if (minutesRange < 7 * 24 * 60) chart.options.scales.x.ticks.maxTicksLimit = 10;
      else chart.options.scales.x.ticks.maxTicksLimit = 12;
    }

    try {
      chart.update();
    } catch (err) {
      console.error(`History chart update failed for ${roomId}/${metric.key}:`, err && err.message ? err.message : err);
    }
  });
}

socket.on("sensor:update", (payload) => {
  if (!payload?.room || !roomState[payload.room]) return;
  roomState[payload.room].latest = payload;
  setCardValues(payload.room, payload);
  addRealtimeData(payload.room, payload);
});

socket.on("sensor:batch", (payloads) => {
  Object.entries(payloads || {}).forEach(([roomId, payload]) => {
    if (!roomState[roomId]) return;
    roomState[roomId].latest = payload;
    setCardValues(roomId, payload);
    addRealtimeData(roomId, payload);
  });
});

function resetAutoRefresh() {
  if (autoRefreshInterval) clearInterval(autoRefreshInterval);
  
  if (autoRefreshEnabled) {
    autoRefreshInterval = setInterval(() => {
      loadLatest();
    }, HISTORY_REFRESH_MS);
  }
}

// Event listeners
rangeMinutesEl.addEventListener("change", () => {
  ROOMS.forEach((room) => loadHistory(room.id));
  resetAutoRefresh();
});

chartTypeEl.addEventListener("change", (e) => {
  updateChartType(e.target.value);
});

autoRefreshEl.addEventListener("change", (e) => {
  autoRefreshEnabled = e.target.checked;
  resetAutoRefresh();
});

refreshBtn.addEventListener("click", () => {
  ROOMS.forEach((room) => loadHistory(room.id));
});



resetZoomBtn.addEventListener("click", () => {
  ROOMS.forEach((room) => {
    METRICS.forEach((metric) => {
      const chart = roomState[room.id].charts[metric.key];
      if (chart && typeof chart.resetZoom === 'function') {
        chart.resetZoom();
      }
    });
  });
  resetZoomBtn.style.display = 'none';
});

createDashboard();
loadLatest();
ROOMS.forEach((room) => loadHistory(room.id));

// Start auto-refresh
resetAutoRefresh();

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  if (autoRefreshInterval) clearInterval(autoRefreshInterval);
});
